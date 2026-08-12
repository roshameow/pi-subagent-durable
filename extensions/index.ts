/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	getAgentDir,
	getMarkdownTheme,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text, type Focusable, matchesKey } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";

// ── RMUX integration ──
const RMUX_SESSION_NAME = "pi-agents";
let rmuxAvailable: boolean | null = null;
let rmuxClient: any = null; // Rmux instance (lazy)

// @rmux/sdk 位置：优先包内 node_modules，兼容旧全局安装
function resolveRmuxSdk(): string {
	const self = typeof __dirname !== "undefined" ? __dirname : process.cwd();
	const candidates = [
		path.join(self, "..", "node_modules", "@rmux", "sdk", "dist", "index.js"),
		path.join(self, "node_modules", "@rmux", "sdk", "dist", "index.js"),
		"/opt/homebrew/lib/node_modules/@rmux/sdk/dist/index.js",
		"/usr/local/lib/node_modules/@rmux/sdk/dist/index.js",
	];
	for (const c of candidates) {
		try { if (fs.existsSync(c)) return c; } catch {}
	}
	return candidates[0];
}

function checkRmuxAvailable(): boolean {
	if (rmuxAvailable !== null) return rmuxAvailable;
	try {
		execSync("rmux -V", { stdio: "pipe", timeout: 3000 });
		rmuxAvailable = true;
	} catch {
		rmuxAvailable = false;
	}
	return rmuxAvailable;
}

async function getRmux(): Promise<any | null> {
	if (!checkRmuxAvailable()) return null;
	if (rmuxClient) return rmuxClient;
	try {
		const mod = await import(resolveRmuxSdk());
		rmuxClient = await mod.Rmux.builder().connectOrStart();
		return rmuxClient;
	} catch (e) {
		console.warn("[subagent] RMUX init failed:", e);
		rmuxAvailable = false;
		return null;
	}
}

// Strip ANSI escape codes from terminal output
function stripAnsi(s: string): string {
	return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1B\\]/g, "");
}

function getAgentLogDir(): string {
	// 和 pi session 放一起，用户容易发现
	return path.join(getAgentDir(), "agent-logs");
}

function getAgentLogPath(taskId: string): string {
	return path.join(getAgentLogDir(), `${taskId}.jsonl`);
}

function makeRmuxWindowName(agentName: string, taskId: string): string {
	const safe = agentName.replace(/[^a-zA-Z0-9_-]/g, "_");
	return `${safe}-${taskId}`.slice(0, 60);
}

// 从 NDJSON 事件流提取最后一条「非空」的 assistant 文本消息。
// 之前只取最后一条 message_end 的文本：若最后一条是纯 toolCall/空消息（常见），
// 真实总结会被丢弃，且 finalText 为空导致完成通知被跳过（主 agent 收不到通知）。
function extractAssistantFinalText(raw: string): string {
	let last = "";
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line);
			if (event.type === "message_end" && event.message?.role === "assistant") {
				const parts = event.message.content || [];
				const text = parts.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n").trim();
				if (text) last = text;
			}
		} catch {}
	}
	return last;
}

// 检测最后一次 assistant message_end 是否 stopReason=error（turn 被模型/provider 错误打断）。
// 这类崩溃不会留下文本输出，但主 agent 应知道是「中断」而不是「正常完成」。
function extractStopReason(raw: string): string | undefined {
	let last: string | undefined;
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line);
			if (event.type === "message_end" && event.message?.role === "assistant") {
				if (event.message.stopReason) last = event.message.stopReason;
			}
		} catch {}
	}
	return last;
}

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };

// ── jsonl 日志处理：message_update 瘦身为增量（防全量快照膨胀），并生成 session 镜像 ──
// 根因：pi --mode json 会把 session.subscribe 收到的每条 message_update（携带全量累积
// thinking + toolCall arguments）原样落盘；40586 条 message_update ≈ 99% 的日志体积。
// 处理：message_update 只保留 { message.role, assistantMessageEvent }（增量 delta），
// 保住 /agent-live 的实时文本流，同时体积从每条约 8KB 降到 ~100B。
// 另外把 message_end 实时转换为 pi session 格式（sessions 目录），`pi --export` 可直接导出对话 HTML。
const JSONL_FILTER_SCRIPT = String.raw`
const fs = require("fs");
const crypto = require("crypto");
const outPath = process.argv[2];       // 过滤后的事件流（agent-logs）
const sessionPath = process.argv[3];   // session 格式镜像（可 pi --export）
const cwd = process.argv[4] || ".";
const parentId = process.argv[5] || ""; // 父会话 id（widget 归属用）
let parentWritten = false;
let pending = "";
let lastParentId = null;
let lastEntryId = null;
let sawSession = false;
let sessionId = "";
const genId = () => "m_" + crypto.randomBytes(6).toString("hex");
// 体积控制（agent-logs 只服务 /agent-live 实时文本 + message_end 完成检测/usage，
// 其余都是重复数据）:
//   message_update: 只留 text_delta + *_start/_end 骨架，丢 thinking/toolcall 增量流（体积大头）
//   agent_end: 丢 messages 全量快照
//   turn_end: 丢 message + toolResults
//   tool_execution_end/update: 截断 result/args/partialResult
function truncateStr(s, max) {
  if (typeof s !== "string" || s.length <= max) return s;
  return s.slice(0, max) + "…[truncated]";
}
function truncateVal(v, max) {
  if (v === undefined || v === null) return v;
  if (typeof v === "string") return truncateStr(v, max);
  if (typeof v === "object") {
    const json = JSON.stringify(v);
    if (json.length <= max) return v;
    return { __truncated__: true, size: json.length, preview: truncateStr(json, max) };
  }
  return v;
}
function slimAe(ae) {
  if (!ae) return undefined;
  const t = ae.type;
  const keepDelta = t === "text_delta";
  const keepSkeleton = /_(start|end)$/.test(t || "");
  if (!keepDelta && !keepSkeleton) return undefined;   // 丢弃整条（thinking/toolcall 增量）
  const slim = { type: t, contentIndex: ae.contentIndex };
  if (keepDelta && ae.delta !== undefined) slim.delta = ae.delta;
  return slim;
}
// 实时处理：每收到完整一行就立即处理写入，不攒 buffer（否则要等 pi 退出 stdin EOF 才 flush）
function handleLine(line) {
  if (!line.trim()) return;
  let ev = null;
  try { ev = JSON.parse(line); } catch {}
  if (!ev || typeof ev !== "object") { process.stdout.write(line + "\n"); return; }
  // 1) 事件流日志：只保留消费方需要的事件，其余瘦身/丢弃
  let out = null;
  if (ev.type === "message_update") {
    const ae = slimAe(ev.assistantMessageEvent || {});
    if (ae) out = JSON.stringify({ type: "message_update", message: { role: ev.message && ev.message.role }, assistantMessageEvent: ae });
    // ae 为 null → 整条丢弃
  } else if (ev.type === "turn_end") {
    out = JSON.stringify({ type: "turn_end" });
  } else if (ev.type === "agent_end") {
    const slim = { type: "agent_end" };
    if (ev.willRetry !== undefined) slim.willRetry = ev.willRetry;
    out = JSON.stringify(slim);
  } else if (ev.type === "tool_execution_end") {
    out = JSON.stringify({ type: "tool_execution_end", toolCallId: ev.toolCallId, toolName: ev.toolName, result: truncateVal(ev.result, 2048), isError: ev.isError });
  } else if (ev.type === "tool_execution_update") {
    out = JSON.stringify({ type: "tool_execution_update", toolCallId: ev.toolCallId, toolName: ev.toolName, args: truncateVal(ev.args, 1024), partialResult: truncateVal(ev.partialResult, 1024) });
  } else if (ev.type === "message_start" && ev.message && ev.message.role === "toolResult") {
    const content = ev.message.content;
    if (Array.isArray(content)) {
      for (const item of content) {
        if (item && typeof item.text === "string" && item.text.length > 8192) item.text = item.text.slice(0, 8192) + "…[truncated]";
      }
    }
    out = JSON.stringify(ev);
  } else {
    out = line;
  }
  if (out) process.stdout.write(out + "\n");
  // 2) session 镜像：只收 session 头 + message_end（含完整最终态）
  if (ev.type === "session") {
    sawSession = true;
    sessionId = ev.id || genId();
    const header = { type: "session", version: 3, id: sessionId, timestamp: ev.timestamp || new Date().toISOString(), cwd: ev.cwd || cwd };
    fs.appendFileSync(sessionPath, JSON.stringify(header) + "\n");
    // 把父会话 id 写进 agent-log（widget 按父会话归属任务）
    if (parentId && !parentWritten) {
      parentWritten = true;
      process.stdout.write(JSON.stringify({ type: "pi_subagent_parent", parentId }) + "\n");
    }
    lastParentId = null; lastEntryId = null;
  }
  else if (ev.type === "message_end") {
    const m = ev.message || {};
    const entry = {
      type: "message",
      id: genId(),
      parentId: lastEntryId,   // 线性链：user → assistant → toolResult → assistant ...
      timestamp: m.timestamp || ev.timestamp || new Date().toISOString(),
      message: m,
    };
    fs.appendFileSync(sessionPath, JSON.stringify(entry) + "\n");
    lastEntryId = entry.id;
  }
}
process.stdin.on("data", d => {
  pending += d.toString("utf8");
  let nl;
  while ((nl = pending.indexOf("\n")) >= 0) {
    const line = pending.slice(0, nl);
    pending = pending.slice(nl + 1);
    handleLine(line);
  }
});
process.stdin.on("end", () => {
  if (pending.trim()) handleLine(pending);
  pending = "";
});
`;

function getJsonlFilterPath(): string {
	return path.join(os.tmpdir(), "pi-subagent-jsonl-filter.cjs");
}

function ensureJsonlFilterScript(): void {
	const p = getJsonlFilterPath();
	try {
		if (fs.existsSync(p)) {
			const cur = fs.readFileSync(p, "utf-8");
			if (cur === JSONL_FILTER_SCRIPT) return;
		}
		fs.writeFileSync(p, JSONL_FILTER_SCRIPT, { encoding: "utf-8", mode: 0o600 });
	} catch {}
}

// subagent 的 session 镜像文件路径（放在 sessions 目录，pi --export 可直接导出）
function getSubagentSessionPath(taskId: string, cwd: string): string {
	const sessionsDir = path.join(getAgentDir(), "sessions");
	// 仿照 pi 的 cwd 编码规则：/Users/a/b -> --Users-a-b--
	const encoded = "--" + cwd.replace(/^\/+/, "").replace(/\//g, "-") + "--";
	const dir = path.join(sessionsDir, encoded);
	try { fs.mkdirSync(dir, { recursive: true }); } catch {}
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	return path.join(dir, `${ts}_subagent-${taskId}.jsonl`);
}

// 在进程内过滤一行 JSONL（fallback spawn 路径用）：返回 null 表示应丢弃
// 若传入 sessionPath，同时把 message_end 实时追加为 pi session 格式（供 pi --export）
let _sessionState: { file: string; lastId: string | null; id: string } | null = null;
function genSessionEntryId(): string {
	return "m_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
function truncateVal(v: any, max: number): any {
	if (v === undefined || v === null) return v;
	if (typeof v === "string") return v.length <= max ? v : v.slice(0, max) + "…[truncated]";
	if (typeof v === "object") {
		const json = JSON.stringify(v);
		if (json.length <= max) return v;
		return { __truncated__: true, size: json.length, preview: json.slice(0, max) + "…[truncated]" };
	}
	return v;
}

function filterJsonlLine(line: string, sessionPath?: string, cwd?: string): string | null {
	if (!line.trim()) return line;
	let ev: any = null;
	try { ev = JSON.parse(line); } catch {}
	if (!ev || typeof ev !== "object") return line;
	// 体积控制（与 JSONL_FILTER_SCRIPT 一致）：只保留消费方需要的事件，其余瘦身/丢弃
	let out: string | null = null;
	if (ev.type === "message_update") {
		const ae = ev.assistantMessageEvent || {};
		const t = ae.type;
		const keepDelta = t === "text_delta";
		const keepSkeleton = /_(start|end)$/.test(t || "");
		if (keepDelta || keepSkeleton) {
			const slimAe: Record<string, any> = { type: t, contentIndex: ae.contentIndex };
			if (keepDelta && ae.delta !== undefined) slimAe.delta = ae.delta;
			out = JSON.stringify({ type: "message_update", message: { role: ev.message && ev.message.role }, assistantMessageEvent: slimAe });
		}
		// 否则整条丢弃（thinking/toolcall 增量流）
	} else if (ev.type === "turn_end") {
		out = JSON.stringify({ type: "turn_end" });
	} else if (ev.type === "agent_end") {
		const slim: Record<string, any> = { type: "agent_end" };
		if (ev.willRetry !== undefined) slim.willRetry = ev.willRetry;
		out = JSON.stringify(slim);
	} else if (ev.type === "tool_execution_end") {
		out = JSON.stringify({ type: "tool_execution_end", toolCallId: ev.toolCallId, toolName: ev.toolName, result: truncateVal(ev.result, 2048), isError: ev.isError });
	} else if (ev.type === "tool_execution_update") {
		out = JSON.stringify({ type: "tool_execution_update", toolCallId: ev.toolCallId, toolName: ev.toolName, args: truncateVal(ev.args, 1024), partialResult: truncateVal(ev.partialResult, 1024) });
	} else if (ev.type === "message_start" && ev.message && ev.message.role === "toolResult") {
		const content = ev.message.content;
		if (Array.isArray(content)) {
			for (const item of content) {
				if (item && typeof item.text === "string" && item.text.length > 8192) item.text = item.text.slice(0, 8192) + "…[truncated]";
			}
		}
		out = JSON.stringify(ev);
	} else {
		out = line;
	}
	if (!out) return null;
	// session 镜像：只收 session 头 + message_end（含完整最终态）
	if (sessionPath) {
		try {
			if (ev.type === "session") {
				_sessionState = { file: sessionPath, lastId: null, id: ev.id || genSessionEntryId() };
				const header = {
					type: "session", version: 3, id: _sessionState.id,
					timestamp: ev.timestamp || new Date().toISOString(),
					cwd: ev.cwd || cwd || ".",
				};
				fs.appendFileSync(sessionPath, JSON.stringify(header) + "\n");
				// 父会话 marker(fallback 路径;rmux 路径由 filter 脚本写)
				if (currentSessionId && !fbParentWritten) {
					fbParentWritten = true;
					return JSON.stringify({ type: "pi_subagent_parent", parentId: currentSessionId }) + "\n" + line;
				}
			} else if (ev.type === "message_end") {
				if (!_sessionState) {
					_sessionState = { file: sessionPath, lastId: null, id: genSessionEntryId() };
					const header = {
						type: "session", version: 3, id: _sessionState.id,
						timestamp: new Date().toISOString(), cwd: cwd || ".",
					};
					fs.appendFileSync(sessionPath, JSON.stringify(header) + "\n");
				}
				const m = ev.message || {};
				const entry = {
					type: "message",
					id: genSessionEntryId(),
					parentId: _sessionState.lastId, // 线性链
					timestamp: m.timestamp || ev.timestamp || new Date().toISOString(),
					message: m,
				};
				fs.appendFileSync(sessionPath, JSON.stringify(entry) + "\n");
				_sessionState.lastId = entry.id;
			}
		} catch {}
	}
	return out;
}


function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain" | "auto";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
	let agent = agents.find((a) => a.name === agentName);
	// _worker: 通用 worker，不依赖预注册 agent（与 runAsyncSingleAgent 保持一致）
	if (!agent && agentName === "_worker") {
		agent = {
			name: "_worker",
			description: "Generic worker with full capabilities",
			systemPrompt: `You are a general-purpose coding/research agent. You have access to all tools.
Complete the task thoroughly. Use the full context window - read files, run commands, analyze code.
Return a concise summary of what you did and the key findings.`,
			source: "user",
			filePath: "",
		};
	}

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	const args: string[] = ["--mode", "json", "-p"];
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
	if (fs.existsSync(path.join(cwd ?? defaultCwd, '.mcp.json'))) args.push('--mcp-config', path.join(cwd ?? defaultCwd, '.mcp.json'));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: agent.model,
		step,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode). Omit to auto-use a generic worker." })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode / auto mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	async: Type.Optional(Type.Boolean({
		description: "Run all tasks in background; return immediately with taskIds. Notify on completion. Default: false",
		default: false,
	})),
	taskId: Type.Optional(Type.String({ description: "Check status of a previously submitted async task" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

// ── 全局跟踪异步任务 ──
let taskCounter = 0;
let sessionUI: any = null;
let currentSessionId = ""; // 本 pi 会话的 id, session_start 时从 sessionManager 取
let fbParentWritten = false; // fallback spawn 路径的父会话 marker 已写

function generateTaskId(): string {
	const ts = Date.now().toString(36);
	const rand = Math.random().toString(36).slice(2, 6);
	return `task-${ts}-${rand}`;
}
interface AsyncTaskEntry {
	agent: string;
	task: string;
	proc: any;
	startTime: number;
	useRmux: boolean;
	rmuxTarget?: string;     // session:window.pane
	rmuxAttachCmd?: string;  // user-facing attach command
	cwd?: string;            // 任务工作目录（重连时需要 --mcp-config / sessions 定位）
	sessionId?: string;      // pi 会话 id（重连 --session 用，可从 agent-logs 首行 session 事件解析）
	intentionalKill?: boolean; // 主 agent 主动 kill（reload/stop），完成回调不再发通知
	usage?: TaskUsage;       // token/成本/上下文统计（从 agent-logs 增量聚合）
	statsOffset?: number;    // agent-logs 已解析字节偏移
}
// asyncTasks 放在 globalThis 持久引用上：/reload 会重建模块（clearExtensionCache + 重新 import），
// 若用模块级 const，reload 前后的闭包会持有各自的 Map，导致任务状态分裂（TUI 交替显示）。
const GLOBAL_TASKS_KEY = "__pi_subagent_async_tasks__";
function getAsyncTasks(): Map<string, AsyncTaskEntry> {
	const g = globalThis as any;
	if (!g[GLOBAL_TASKS_KEY]) g[GLOBAL_TASKS_KEY] = new Map<string, AsyncTaskEntry>();
	return g[GLOBAL_TASKS_KEY] as Map<string, AsyncTaskEntry>;
}
const asyncTasks = getAsyncTasks();

// 诊断:记录扩展加载 + rmux 可用性(帮助排查"新 pi 看不到 subagent")
function diagLog(msg: string) {
	try {
		fs.appendFileSync(path.join(getAgentLogDir(), "extension-diag.log"), `[${new Date().toISOString()}] pid=${process.pid} ${msg}\n`);
	} catch {}
}
try {
	diagLog(`loaded; rmux=${checkRmuxAvailable()}`);
} catch {}

// ── subagent 管理辅助：主 agent 可直接 kill / 重连运行中的子 agent ──

// 从 agent-logs 首行 session 事件解析 pi 会话 id（--session 重连用）
function getTaskSessionId(taskId: string): string | null {
	try {
		const raw = fs.readFileSync(getAgentLogPath(taskId), "utf-8");
		for (const l of raw.split("\n")) {
			if (!l.trim()) continue;
			const ev = JSON.parse(l);
			if (ev.type === "session" && ev.id) return ev.id;
		}
	} catch {}
	return null;
}

// 任务所属的父会话 id:优先 agent-log 里的 pi_subagent_parent marker
//(spawn 时由 filter 脚本写入);老任务 fallback 到 agent-log 首行 session id
function getTaskParentSessionId(taskId: string): string | null {
	try {
		const raw = fs.readFileSync(getAgentLogPath(taskId), "utf-8");
		for (const l of raw.split("\n")) {
			if (!l.trim()) continue;
			const ev = JSON.parse(l);
			if (ev.type === "pi_subagent_parent" && ev.parentId) return ev.parentId;
		}
	} catch {}
	return getTaskSessionId(taskId);
}

// 主动 kill 一个运行中的任务（rmux 窗口或 spawn 进程），并标记 intentionalKill
// 使该任务随后的完成回调只清理、不通知主会话
// 注意：entry 可能来自本进程 asyncTasks（自己 spawn 的），也可能来自
// discoverExternalTasks（父 pi 已死/其他 pi spawn 的孤儿），两种都要能杀。
async function killTask(taskId: string): Promise<boolean> {
	const entry = asyncTasks.get(taskId) || discoverExternalTasks().get(taskId);
	if (!entry) return false;
	entry.intentionalKill = true;
	try {
		if (entry.useRmux && entry.rmuxTarget) {
			const windowTarget = entry.rmuxTarget.split(".")[0]; // session:window
			// 1) 优先 SDK 客户端；客户端可能已 stale（control-mode 连接断掉会 throw）
			try {
				const rmux = await getRmux();
				if (rmux) {
					await rmux.cmd("kill-window", "-t", windowTarget);
					diagLog(`kill ok (sdk) ${taskId} -> ${windowTarget}`);
					return true;
				}
			} catch (e) {
				diagLog(`kill sdk ERR ${taskId} ${windowTarget}: ${String(e).slice(0, 200)}; fallback cli`);
				rmuxClient = null;
				rmuxAvailable = null; // 重置，下次 getRmux 会重新探测/连接
			}
			// 2) 兜底：直接走 rmux CLI（绕过 stale 的 SDK 客户端）
			try {
				execSync(`rmux kill-window -t ${windowTarget}`, { stdio: "ignore", timeout: 8000 });
				diagLog(`kill ok (cli) ${taskId} -> ${windowTarget}`);
				return true;
			} catch (e) {
				diagLog(`kill cli ERR ${taskId} ${windowTarget}: ${String(e).slice(0, 200)}`);
			}
		}
		// 3) 最终兜底：窗口探测/关闭都失败时按 taskId 杀进程树
		// （父 pi 已死的孤儿，agent-log 路径/子代理 cmdline 都含 taskId）
		try {
			execSync(`pkill -f ${taskId}`, { stdio: "ignore", timeout: 8000 });
			diagLog(`kill ok (pkill) ${taskId}`);
			return true;
		} catch (e) {
			diagLog(`kill pkill ERR ${taskId}: ${String(e).slice(0, 150)}`);
		}
		if (entry.proc) {
			entry.proc.killed = true;
			entry.proc.kill();
			diagLog(`kill ok (proc) ${taskId}`);
			return true;
		}
	} catch (e) {
		diagLog(`kill ERR ${taskId}: ${String(e).slice(0, 200)}`);
	}
	return false;
}

// ── 从文件系统发现运行中的任务 ──
// subagent_list / 实时 UI 只遍历当前 pi 进程内存里的 asyncTasks,看不到其他 pi
// 进程 spawn 的子代理。这里扫描 agent-logs,进程存活(ps)或 rmux 窗口存在即视为
// running,合并进列表(带 3s 缓存,避免高频轮询时反复 execSync)。
let _extCache: { at: number; map: Map<string, AsyncTaskEntry> } | null = null;
function discoverExternalTasks(): Map<string, AsyncTaskEntry> {
	const now = Date.now();
	if (_extCache && now - _extCache.at < 3000) return _extCache.map;
	const out = new Map<string, AsyncTaskEntry>();
	const dir = getAgentLogDir();
	let names: string[] = [];
	try { names = fs.readdirSync(dir); } catch { return out; }
	// rmux pi-agents 窗口名集合(判断 rmux 存活)
	const rmuxWinName = (line: string): string => {
		// "3: _worker-task-xxx (1 panes)..." -> "_worker-task-xxx"
		return line.replace(/^\d+:\s*/, "").split(/\s+/)[0].replace(/\*$/, "");
	};
	let rmuxWindows = new Set<string>();
	try {
		const r = execSync("rmux list-windows -t pi-agents", { stdio: ["ignore", "pipe", "ignore"], timeout: 3000 });
		rmuxWindows = new Set(String(r).split("\n").map((l) => rmuxWinName(l)).filter(Boolean));
	} catch {}
	// 非 rmux 路径:进程存活
	let psOut = "";
	try { psOut = String(execSync("ps -axo command", { stdio: ["ignore", "pipe", "ignore"], timeout: 3000 })); } catch {}
	for (const name of names) {
		if (!name.startsWith("task-") || !name.endsWith(".jsonl")) continue;
		// 保留 task- 前缀:genTaskId() 生成的 taskId 就是带前缀的,
		// getAgentLogPath/asyncTasks 的 key 都按带前缀约定
		const taskId = name.slice(0, -6);
		if (asyncTasks.has(taskId)) continue; // 当前进程 spawn 的,内存里有
		const logPath = path.join(dir, name);
		let raw = "";
		try { raw = fs.readFileSync(logPath, "utf-8"); } catch { continue; }
		const lines = raw.split("\n").filter(Boolean);
		if (!lines.length) continue;
		// 结束检测:最后一行是终态事件则跳过
		let lastType = "";
		try { lastType = (JSON.parse(lines[lines.length - 1]).type || "") as string; } catch {}
		if (lastType === "agent_end" || lastType === "agent_settled") continue;
		const winName = [...rmuxWindows].find((w) => w.includes(taskId));
		const alive = winName ? true : psOut.includes(`${taskId}.jsonl`);
		if (!alive) continue;
		// agent 名:窗口名 <agent>-task-<id>
		let agent = "unknown";
		if (winName) {
			const m = /^([\w-]+)-task-/.exec(winName);
			if (m) agent = m[1];
		}
		// task 文本:首条 user 消息(日志里是 message_start/message_end 事件)
		let task = "";
		try {
			for (const l of lines.slice(1, 30)) {
				const ev = JSON.parse(l);
				if (
					(ev.type === "message_start" || ev.type === "message_end") &&
					ev.message?.role === "user" &&
					Array.isArray(ev.message.content)
				) {
					task = typeof ev.message.content[0]?.text === "string" ? ev.message.content[0].text : "";
					if (task) break;
				}
			}
		} catch {}
		let cwd = "";
		try { cwd = (JSON.parse(lines[0]).cwd as string) || ""; } catch {}
		let startTime = now;
		try { startTime = fs.statSync(logPath).mtimeMs; } catch {}
		out.set(taskId, {
			agent,
			task: task.slice(0, 300),
			startTime,
			useRmux: !!winName,
			rmuxTarget: winName ? `pi-agents:${winName}.0` : undefined,
			rmuxAttachCmd: "rmux attach -t pi-agents",
			cwd: cwd || undefined,
			sessionId: getTaskParentSessionId(taskId) || undefined,
			proc: { killed: false, exitCode: null },
		});
	}
	_extCache = { at: now, map: out };
	diagLog(`discover: found=${out.size} [${[...out.keys()].join(",")}]`);
	return out;
}


// ── 子代理 widget:合并内存 + 文件系统发现的任务,供事件驱动和周期刷新共用 ──
function renderSubagentWidget(u: any) {
	if (!u) return;
	const now = Date.now();
	const lines: string[] = [];
	let running = 0, done = 0;
	// 只显示与当前会话相关的任务:本进程 spawn 的(内存) + 其他进程里
	// 父会话 id == 当前会话的外部任务。原来把全进程任务列表合并进来,
	// 导致每个 pi 会话的 terminal 都显示同样的 widget,而不是只在父会话。
	const all = new Map(asyncTasks);
	for (const [id, e] of discoverExternalTasks()) {
		if (!all.has(id) && e.sessionId === currentSessionId) all.set(id, e);
	}
	for (const [id, t] of all) {
		const alive = t.useRmux ? Boolean(t.rmuxTarget) : (t.proc && !t.proc.killed && t.proc.exitCode === null);
		if (!alive) { done++; continue; }
		running++;
		const summary = (t.task || "").length > 70 ? t.task.slice(0, 70) + "…" : t.task;
		const elapsed = Math.round((now - t.startTime) / 1000);
		lines.push(`  ⏳ [${id}] ${t.agent}: ${summary} (${elapsed}s)${fmtUsageShort(t.usage)}`);
	}
	const status = `⚡ Agents: ${running} running, ${done} done`;
	if (running > 0 || done > 0) u.setWidget("z_subagent_tasks", [status, ...lines]);
	else u.setWidget("z_subagent_tasks", []);
}
// 按 taskId / agent / sessionId 模糊匹配运行中的任务（不传参数 = 全部）
function findRunningTasks(opts: { taskId?: string; agent?: string; sessionId?: string }): { taskId: string; entry: AsyncTaskEntry }[] {
	const q = (opts.taskId || "").toLowerCase();
	const a = (opts.agent || "").toLowerCase();
	const s = (opts.sessionId || "").toLowerCase();
	const out: { taskId: string; entry: AsyncTaskEntry }[] = [];
	const all = new Map(asyncTasks);
	for (const [id, e] of discoverExternalTasks()) {
		if (!all.has(id)) all.set(id, e);
	}
	for (const [id, entry] of all) {
		const alive = entry.useRmux ? Boolean(entry.rmuxTarget) : (entry.proc && !entry.proc.killed && entry.proc.exitCode === null);
		if (!alive) continue;
		if (!q && !a && !s) { out.push({ taskId: id, entry }); continue; }
		const mId = q && id.toLowerCase().includes(q);
		const mAgent = a && entry.agent.toLowerCase().includes(a);
		const mSess = s && (entry.sessionId || "").toLowerCase().includes(s);
		if (mId || mAgent || mSess) out.push({ taskId: id, entry });
	}
	return out;
}

function formatRunningTasks(list: { taskId: string; entry: AsyncTaskEntry }[]): string {
	if (list.length === 0) return "(none)";
	return list.map(({ taskId, entry }) => {
		const sess = entry.sessionId ? ` session=${entry.sessionId}` : "";
		return `- ${taskId} agent=${entry.agent}${sess} task="${entry.task.slice(0, 80)}"`;
	}).join("\n");
}

// 根据 sessionId 找到真实 session 文件，读取其 cwd（重连暂停/已结束的会话时用）
function readSessionInfo(sessionId: string): { cwd?: string } | null {
	try {
		const sessionsRoot = path.join(getAgentDir(), "sessions");
		for (const dirName of fs.readdirSync(sessionsRoot)) {
			const dir = path.join(sessionsRoot, dirName);
			let files: string[] = [];
			try { files = fs.readdirSync(dir); } catch { continue; }
			const hit = files.find((f) => f.includes(sessionId) && !f.includes("subagent-task"));
			if (!hit) continue;
			const raw = fs.readFileSync(path.join(dir, hit), "utf-8");
			const first = raw.split("\n").find((l) => l.trim());
			if (!first) return {};
			const ev = JSON.parse(first);
			return { cwd: ev.cwd };
		}
	} catch {}
	return null;
}

// 按子串在 agent-logs 目录里找 taskId（重连暂停任务时用）
function findTaskIdBySubstring(q: string): string | null {
	try {
		const dir = getAgentLogDir();
		const hit = fs.readdirSync(dir).find((f) => f.includes(q));
		return hit ? hit.replace(/\.jsonl$/, "") : null;
	} catch { return null; }
}

// ── usage / 成本统计（数据来自 pi 原生 message_end.usage，含 cost；窗口来自 models-store.json）──

export interface TaskUsage {
	input: number; output: number; cacheRead: number; cacheWrite: number;
	reasoning: number; totalTokens: number; cost: number; turns: number;
	contextTokens: number;  // 最新一 turn 的上下文占用（cacheRead + input）
	contextWindow?: number; // 模型上下文窗口（/1000.0k 那个）
}

let _ctxWindowCache: Record<string, number> | null = null;
// 从 ~/.pi/agent/models-store.json 读模型 contextWindow（与主 agent footer 的 “/1000.0k” 同源）
function getModelContextWindow(model: string): number | undefined {
	if (!model) return undefined;
	try {
		if (!_ctxWindowCache) {
			_ctxWindowCache = {};
			const p = path.join(getAgentDir(), "models-store.json");
			const data = JSON.parse(fs.readFileSync(p, "utf-8"));
			for (const prov of Object.values(data)) {
				for (const m of ((prov as any)?.models) || []) {
					if (m?.id && m?.contextWindow) _ctxWindowCache[m.id] = m.contextWindow;
				}
			}
		}
		const direct = _ctxWindowCache[model];
		if (direct !== undefined) return direct;
		// 容忍 provider/model 前缀
		const bare = model.split("/").pop()!;
		return _ctxWindowCache[bare];
	} catch { return undefined; }
}

// 增量解析 agent-logs：只读新增字节，聚合 message_end(assistant).usage
function accumulateTaskUsage(taskId: string, entry: AsyncTaskEntry): void {
	const logPath = getAgentLogPath(taskId);
	try {
		const size = fs.statSync(logPath).size;
		const offset = entry.statsOffset || 0;
		if (size <= offset) return;
		const buf = Buffer.alloc(size - offset);
		const fd = fs.openSync(logPath, "r");
		try { fs.readSync(fd, buf, 0, buf.length, offset); } finally { fs.closeSync(fd); }
		entry.statsOffset = size;
		const u = (entry.usage = entry.usage || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: 0, turns: 0, contextTokens: 0 });
		for (const line of buf.toString("utf-8").split("\n")) {
			if (!line.includes("\"message_end\"")) continue;
			let ev: any;
			try { ev = JSON.parse(line); } catch { continue; }
			if (ev.type !== "message_end") continue;
			const m = ev.message || {};
			if (m.role !== "assistant") continue;
			const w = m.usage;
			if (!w) continue;
			u.input += w.input || 0;
			u.output += w.output || 0;
			u.cacheRead += w.cacheRead || 0;
			u.cacheWrite += w.cacheWrite || 0;
			u.reasoning += w.reasoning || 0;
			u.totalTokens += w.totalTokens || 0;
			u.cost += w.cost?.total || 0;
			u.turns++;
			u.contextTokens = (w.cacheRead || 0) + (w.input || 0);
			if (u.contextWindow === undefined) u.contextWindow = getModelContextWindow(m.model);
		}
	} catch {}
}

function fmtCompact(n: number): string {
	if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "m";
	if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
	return String(Math.round(n || 0));
}

// 短格式：` 11%/1000.0k`（与主 agent footer 风格一致；无窗口信息时退回 ` ctx=110k`）
function fmtUsageShort(u?: TaskUsage): string {
	if (!u || u.turns === 0) return "";
	return u.contextWindow
		? ` ${((u.contextTokens / u.contextWindow) * 100).toFixed(1)}%/${fmtCompact(u.contextWindow)}`
		: ` ctx=${fmtCompact(u.contextTokens)}`;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to a subagent with an isolated context window.",
			"",
			"USE SUBAGENT WHEN:",
			"1. Parallel independent tasks — e.g., edit multiple unrelated files simultaneously, each in its own context",
			"2. Deep research — lots of searching/reading without bloating the main conversation",
			"3. Isolated experiments — try things on a separate branch/directory, no side effects on main workspace",
			"4. Decomposition — break a large task into subtasks and run them concurrently",
			"",
			"Modes:",
			'- single: { agent: "scout", task: "..." } — named agent, or omit agent for a generic worker',
			'- parallel: { tasks: [...] } — up to 8 agents run concurrently (for cases 1, 4)',
			'- chain: { chain: [...] } — sequential steps, use {previous} for prior output',
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const hasAuto = Boolean(!params.agent && params.task && !hasChain && !hasTasks);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle) + Number(hasAuto);

			const makeDetails =
				(mode: "single" | "parallel" | "chain" | "auto") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			// ── 检查 async task 状态 ──
			if (params.taskId) {
				const entry = asyncTasks.get(params.taskId);
				if (!entry) return {
					content: [{ type: "text", text: `Task "${params.taskId}" not found or already completed.` }],
					details: makeDetails("single")([]),
				};
				let alive = false;
				let extraLine = "";
				if (entry.useRmux) {
					// RMUX 方式：检查 pane
					try {
						const rmux = await getRmux();
						if (rmux && entry.rmuxTarget) {
							const p = await rmux.cmd("list-panes", "-t", entry.rmuxTarget);
							alive = p.returnCode === 0;
							extraLine = `\n  Attach: ${entry.rmuxAttachCmd}`;
						}
					} catch {}
				} else {
					alive = !entry.proc.killed && entry.proc.exitCode === null;
				}
				return {
					content: [{ type: "text", text: (alive
						? `Task "${params.taskId}" (${entry.agent}) is still running (started ${Math.round((Date.now() - entry.startTime) / 1000)}s ago).`
						: `Task "${params.taskId}" (${entry.agent}) has completed.`) + extraLine,
					}],
					details: makeDetails("single")(alive
						? [{ agent: entry.agent, agentSource: "user", task: entry.task, exitCode: -1, messages: [], stderr: "", usage: ZERO_USAGE }]
						: [{ agent: entry.agent, agentSource: "user", task: entry.task, exitCode: 0, messages: [], stderr: "", usage: ZERO_USAGE }]
					),
				};
			}

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			// ── single 模式（默认异步后台执行）──
			if (hasSingle) {
				const agentName = params.agent!;
				// _worker 是动态构造的通用 worker（runAsyncSingleAgent 内支持），不在预注册列表里，需放行
				if (agentName !== "_worker" && !agents.find((a) => a.name === agentName)) {
					const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
					return { content: [{ type: "text", text: `Unknown agent: "${agentName}". Available: ${available}.` }], details: makeDetails("single")([]) };
				}
				const taskId = await runAsyncSingleAgent(ctx.cwd, agents, agentName, params.task!, ctx.ui);
				const entry = asyncTasks.get(taskId);
				const rmuxLine = entry?.useRmux && entry?.rmuxAttachCmd
					? `\nAttach: ${entry.rmuxAttachCmd}`
					: "";
				const statusMsg = `⏳ Agent "${agentName}" submitted (${taskId}) — will notify on completion.${rmuxLine}`;
				if (sessionUI) sessionUI.notify(statusMsg, "info");
				return {
					content: [{ type: "text", text: statusMsg }],
					details: makeDetails("single")([{ agent: agentName, agentSource: "user", task: params.task!, exitCode: -1, messages: [], stderr: "", usage: ZERO_USAGE }]),
				};
			}

			// ── auto 模式（不指定 agent，自动用通用 worker）──
			if (hasAuto) {
				const taskId = await runAsyncSingleAgent(ctx.cwd, agents, "_worker", params.task!, ctx.ui);
				const entry = asyncTasks.get(taskId);
				const rmuxLine = entry?.useRmux && entry?.rmuxAttachCmd
					? `\nAttach: ${entry.rmuxAttachCmd}`
					: "";
				const statusMsg = `⏳ Task submitted (${taskId}) — will notify on completion.${rmuxLine}`;
				if (sessionUI) sessionUI.notify(statusMsg, "info");
				return {
					content: [{ type: "text", text: statusMsg }],
					details: makeDetails("auto")([{ agent: "_worker", agentSource: "user", task: params.task!, exitCode: -1, messages: [], stderr: "", usage: ZERO_USAGE }]),
				};
			}

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						step.agent,
						taskWithContext,
						step.cwd,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
					);
					results.push(result);

					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = getResultOutput(result);
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
					details: makeDetails("chain")(results),
				};
			}

			// ── parallel 模式（默认异步后台执行）──
			if (params.tasks && params.tasks.length > 0 && (params.async ?? true)) {
				const ids: string[] = [];
				for (const t of params.tasks) {
					const taskId = await runAsyncSingleAgent(ctx.cwd, agents, t.agent, t.task, ctx.ui);
					ids.push(`${t.agent} (${taskId})`);
				}
				if (sessionUI) sessionUI.notify(`⏳ 提交了 ${ids.length} 个后台任务`, "info");
				return {
					content: [{ type: "text", text: `${ids.length} task(s) submitted: ${ids.join(", ")}. You will be notified when done.` }],
					details: makeDetails("parallel")(params.tasks.map(() => ({ agent: "", agentSource: "user" as const, task: "", exitCode: -1, messages: [], stderr: "", usage: ZERO_USAGE }))),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						t.agent,
						t.task,
						t.cwd,
						undefined,
						signal,
						// Per-task update callback
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = truncateParallelOutput(getResultOutput(r));
					const status = isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const isAuto = !args.agent && args.task;
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				(isAuto ? theme.fg("warning", "auto ") : theme.fg("accent", agentName)) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if ((details.mode === "single" || details.mode === "auto") && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
				const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});

	// ── async 模式：后台执行单个 agent ──
	// 优先使用 RMUX pane（持久化 + 可见），fallback 到 spawn
	const runAsyncSingleAgent = async (
		cwd: string,
		agents: AgentConfig[],
		agentName: string,
		taskText: string,
		ui?: any,  // ExtensionUIContext from execute ctx
		resumeSessionId?: string,  // 若提供，则用 --session <id> 重连既有会话而非新建
	): Promise<string> => {
		let agent = agents.find((a) => a.name === agentName);
		// _worker: 通用 worker，不依赖预注册 agent
		if (!agent && agentName === "_worker") {
			agent = {
				name: "_worker",
				description: "Generic worker with full capabilities",
				systemPrompt: `You are a general-purpose coding/research agent. You have access to all tools.
Complete the task thoroughly. Use the full context window - read files, run commands, analyze code.
Return a concise summary of what you did and the key findings.`,
				source: "user",
				filePath: "",
			};
		}
		if (!agent) return "";

		const taskId = generateTaskId();

		// 构建 pi 参数
		const piArgs: string[] = ["--mode", "json", "-p"];
		if (resumeSessionId) piArgs.push("--session", resumeSessionId);
		if (agent.model) piArgs.push("--model", agent.model);
		if (agent.tools && agent.tools.length > 0) piArgs.push("--tools", agent.tools.join(","));
		if (fs.existsSync(path.join(cwd, '.mcp.json'))) piArgs.push('--mcp-config', path.join(cwd, '.mcp.json'));
		let tmpPromptPath: string | null = null;
		if (!resumeSessionId && agent.systemPrompt.trim()) {
			tmpPromptPath = path.join(os.tmpdir(), `pi-${taskId}.md`);
			fs.writeFileSync(tmpPromptPath, agent.systemPrompt, { encoding: "utf-8", mode: 0o600 });
			piArgs.push("--append-system-prompt", tmpPromptPath);
		}
		piArgs.push(`Task: ${taskText}`);

		// 输出日志文件（给 /agent-live 看）
		const logPath = path.join(getAgentLogDir(), `${taskId}.jsonl`);
		try {
			fs.mkdirSync(getAgentLogDir(), { recursive: true });
			fs.writeFileSync(logPath, "", { encoding: "utf-8", mode: 0o600 });
		} catch {}

		// shell 安全地拼接参数，处理空格和引号
		const shellQuote = (s: string) => s.match(/^[a-zA-Z0-9_./-]+$/) ? s : `'${s.replace(/'/g, "'\\''")}'`;
		const piCommand = [process.execPath, process.argv[1]!, ...piArgs].map(shellQuote).join(" ");

		// ── 尝试 RMUX 方式 ──
		const rmux = await getRmux();
		if (rmux) {
			try {
				const winName = makeRmuxWindowName(agentName, taskId);
				const rmuxTarget = `${RMUX_SESSION_NAME}:${winName}.0`;
				const attachCmd = `rmux attach -t ${RMUX_SESSION_NAME}`;

				// 确保 session 存在
				await rmux.cmd("new-session", "-d", "-s", RMUX_SESSION_NAME, "-n", "base").catch(() => {});

				// 创建新 window 运行 agent；jsonl 落盘前过滤 message_update（防日志膨胀）
				// 同时生成 session 格式镜像（sessions 目录），供 pi --export 导出对话 HTML
				ensureJsonlFilterScript();
				const filterExe = process.execPath;
				const filterScript = getJsonlFilterPath();
				const sessionPath = getSubagentSessionPath(taskId, cwd);
				try { fs.writeFileSync(sessionPath, "", { encoding: "utf-8", mode: 0o600 }); } catch {}
				const r = await rmux.cmd("new-window", "-d", "-t", RMUX_SESSION_NAME, "-n", winName,
					`cd ${cwd} && ${piCommand} 2>&1 | ${filterExe} ${filterScript} ${shellQuote(logPath)} ${shellQuote(sessionPath)} ${shellQuote(cwd)} ${shellQuote(currentSessionId)} >> ${logPath}`);

				if (r.returnCode === 0) {
					// 用 dummy proc 占位（checkRmux 时会替换为真正的进程检查）
					const dummyProc = { killed: false, exitCode: null, kill: () => {} } as any;
					asyncTasks.set(taskId, {
						agent: agentName, task: taskText, proc: dummyProc, startTime: Date.now(),
						useRmux: true, rmuxTarget, rmuxAttachCmd: attachCmd,
						cwd, sessionId: resumeSessionId || currentSessionId || undefined,
					});

					const cleanup = () => {
						asyncTasks.delete(taskId);
						if (tmpPromptPath) { try { fs.unlinkSync(tmpPromptPath); } catch {} }
					};

					const updateWidget = () => {
						renderSubagentWidget(ui || sessionUI);
					};

					// 监控完成：轮询 pane 状态（returnCode 为 0 表示窗口/ pane 还活着，非 0 表示已消失=完成）
					const pollInterval = setInterval(async () => {
						try {
							const panes = await rmux.cmd("list-panes", "-t", rmuxTarget);
							const isDead = panes.returnCode !== 0 || (panes.stdout?.includes("(dead)") ?? false);
							if (isDead) {
								clearInterval(pollInterval);
								handleCompletion();
								return;
							}
							// 增量解析新增日志，聚合 usage/成本（不再全量读文件）
							const self = asyncTasks.get(taskId);
							if (self) accumulateTaskUsage(taskId, self);
							updateWidget();
						} catch {
							clearInterval(pollInterval);
							handleCompletion();
						}
					}, 2000);

					const handleCompletion = () => {
						// 主 agent 主动 kill（reload/stop）：只清理，不解析结果、不通知主会话
						if (asyncTasks.get(taskId)?.intentionalKill) {
							cleanup();
							updateWidget();
							return;
						}
						// cleanup 前先取 usage（cleanup 会删除 asyncTasks 条目）
						const usage = asyncTasks.get(taskId)?.usage;
						// 从日志读取完整输出并解析 NDJSON
						let rawOutput = "";
						try { rawOutput = fs.readFileSync(logPath, "utf-8"); } catch {}
						const finalText = extractAssistantFinalText(rawOutput);
						const stopReason = extractStopReason(rawOutput);

						cleanup();
						updateWidget();
						try {
							const resultKey = `agent:${agentName}:${taskId}`;
							const summary = stopReason === "error"
								? `interrupted (${stopReason}): ${finalText.slice(0, 300) || "model/provider error, no text output"}`
								: finalText
									? finalText.slice(0, 500)
									: "(no output)";
							pi.appendEntry({ key: resultKey, value: { agent: agentName, task: taskText, exitCode: 0, output: finalText, summary, usage: usage ? { totalTokens: usage.totalTokens, cost: usage.cost, contextTokens: usage.contextTokens, contextWindow: usage.contextWindow } : undefined, timestamp: Date.now() } });
						} catch (e) { console.warn("[subagent] appendEntry failed:", e); }
						try {
							const usageLine = usage && usage.turns > 0
								? (usage.contextWindow ? ` [ctx ${((usage.contextTokens / usage.contextWindow) * 100).toFixed(1)}%/${fmtCompact(usage.contextWindow)}]` : ` [ctx ${fmtCompact(usage.contextTokens)}]`)
								: "";
							const body = finalText
								? `Agent "${agentName}" 结果${usageLine}:\n${finalText.slice(0, 4000)}`
								: stopReason === "error"
									? `Agent "${agentName}" (${taskId}) 任务中断${usageLine}：最后一轮被模型/provider 错误打断（stopReason=error），无文本输出。可用 subagent_reload 恢复该任务继续。`
									: `Agent "${agentName}" (${taskId}) 已完成${usageLine}，但无文本输出（可能只执行了工具调用就结束）。可用 /agent-results 查看，或 subagent_reload 继续。`;
							pi.sendUserMessage(body, { deliverAs: "steer" });
						} catch (e) { console.warn("[subagent] completion notify failed:", e); }
					};

					updateWidget();

					return taskId;
				}
			} catch (e) {
				console.warn("[subagent] RMUX run failed, falling back to spawn:", e);
			}
		}

		// ── fallback: spawn 方式 ──
		const proc = spawn(process.execPath, [process.argv[1]!, ...piArgs], { cwd, stdio: ["ignore", "pipe", "pipe"] });
		const fbSessionPath = getSubagentSessionPath(taskId, cwd);
		try { fs.writeFileSync(fbSessionPath, "", { encoding: "utf-8", mode: 0o600 }); } catch {}

		asyncTasks.set(taskId, {
			agent: agentName, task: taskText, proc, startTime: Date.now(),
			useRmux: false,
			cwd, sessionId: resumeSessionId || currentSessionId || undefined,
		});

		let rawStdout = "";
		let stderr = "";
		let pendingLine = "";
		proc.stdout.on("data", (d: Buffer) => { rawStdout += d.toString(); });
		proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

		const cleanupFallback = () => {
			asyncTasks.delete(taskId);
			if (tmpPromptPath) { try { fs.unlinkSync(tmpPromptPath); } catch {} }
		};

		// jsonl 落盘前过滤 message_update（防日志膨胀）；处理跨 chunk 的行边界
		const appendFilteredLog = (chunk: string) => {
			pendingLine += chunk;
			let nl: number;
			while ((nl = pendingLine.indexOf("\n")) >= 0) {
				const line = pendingLine.slice(0, nl);
				pendingLine = pendingLine.slice(nl + 1);
				const kept = filterJsonlLine(line, fbSessionPath, cwd);
				if (kept !== null) { try { fs.appendFileSync(logPath, kept + "\n"); } catch {} }
			}
		};

		proc.stdout.on("data", (d: Buffer) => {
			rawStdout += d.toString();
			appendFilteredLog(d.toString());
		});

		proc.on("close", () => {
			if (pendingLine.trim()) {
				const kept = filterJsonlLine(pendingLine, fbSessionPath, cwd);
				if (kept !== null) { try { fs.appendFileSync(logPath, kept + "\n"); } catch {} }
			}
			pendingLine = "";
		});

		const updateWidget = () => {
			renderSubagentWidget(ui || sessionUI);
		};

		proc.on("close", (code: number | null) => {
			// 主 agent 主动 kill（reload/stop）：只清理，不解析结果、不通知主会话
			if (asyncTasks.get(taskId)?.intentionalKill) {
				cleanupFallback();
				updateWidget();
				return;
			}
			// cleanup 前先取 usage（cleanup 会删除 asyncTasks 条目）
			const usage = asyncTasks.get(taskId)?.usage;
			const finalText = extractAssistantFinalText(rawStdout);
			const stopReason = extractStopReason(rawStdout);
			cleanupFallback();
			updateWidget();
			try {
				const resultKey = `agent:${agentName}:${taskId}`;
				const summary = stopReason === "error"
					? `interrupted (${stopReason}): ${finalText.slice(0, 300) || "model/provider error, no text output"}`
					: code === 0
						? (finalText || "(no output)").slice(0, 500)
						: `failed (exit: ${code}): ${stderr.slice(0, 200)}`;
				pi.appendEntry({ key: resultKey, value: { agent: agentName, task: taskText, exitCode: code, output: finalText || stderr, summary, usage: usage ? { totalTokens: usage.totalTokens, cost: usage.cost, contextTokens: usage.contextTokens, contextWindow: usage.contextWindow } : undefined, timestamp: Date.now() } });
			} catch (e) { console.warn("[subagent] appendEntry failed:", e); }
			if (code === 0) {
				try {
					const usageLine = usage && usage.turns > 0
						? (usage.contextWindow ? ` [ctx ${((usage.contextTokens / usage.contextWindow) * 100).toFixed(1)}%/${fmtCompact(usage.contextWindow)}]` : ` [ctx ${fmtCompact(usage.contextTokens)}]`)
						: "";
					const body = finalText
						? `Agent "${agentName}" 结果${usageLine}:\n${finalText.slice(0, 4000)}`
						: stopReason === "error"
							? `Agent "${agentName}" (${taskId}) 任务中断${usageLine}：最后一轮被模型/provider 错误打断（stopReason=error），无文本输出。可用 subagent_reload 恢复该任务继续。`
							: `Agent "${agentName}" (${taskId}) 已完成${usageLine}，但无文本输出（可能只执行了工具调用就结束）。可用 /agent-results 查看，或 subagent_reload 继续。`;
					pi.sendUserMessage(body, { deliverAs: "steer" });
				} catch (e) { console.warn("[subagent] completion notify failed:", e); }
			}
		});

		proc.on("error", () => { cleanupFallback(); updateWidget(); });

		const interval = setInterval(() => {
			if (!asyncTasks.has(taskId)) { clearInterval(interval); return; }
			const self = asyncTasks.get(taskId);
			if (self) accumulateTaskUsage(taskId, self);
			updateWidget();
		}, 2000);

		updateWidget();

		// 安全兜底：60 秒后自动清理
		setTimeout(cleanupFallback, 60000);

		return taskId;
	};

	// 重连一个运行中的任务：kill 后用 --session 恢复上下文，重新加载工具/扩展/MCP
	const reloadTask = async (taskId: string, prompt: string, ui: any): Promise<string> => {
		const entry = asyncTasks.get(taskId) || discoverExternalTasks().get(taskId);
		if (!entry) return `- ${taskId}: task not found`;
		const sessionId = entry.sessionId || getTaskSessionId(taskId);
		if (!sessionId) return `- ${taskId} (${entry.agent}): session id not found in agent-logs yet, retry later`;
		if (!(await killTask(taskId))) return `- ${taskId} (${entry.agent}): kill failed, session not resumed to avoid double-running`;
		// 重新发现原 agent 配置（可能已更新），找不到则退回 _worker（恢复全部工具）
		const cwd = entry.cwd || process.cwd();
		const agents = discoverAgents(cwd, "both").agents;
		const agentName = agents.some((x) => x.name === entry.agent) ? entry.agent : "_worker";
		const newTaskId = await runAsyncSingleAgent(cwd, agents, agentName, prompt, ui, sessionId);
		return newTaskId
			? `- ${taskId} (${entry.agent}) killed → resumed session ${sessionId.slice(0, 8)}… as ${newTaskId}`
			: `- ${taskId} (${entry.agent}): resume failed`;
	};

	// 直接重连一个已暂停/已结束的 session（无需 kill，因为没在跑）
	const resumeSession = async (sessionId: string, prompt: string, ui: any, preferredCwd?: string): Promise<string> => {
		const info = readSessionInfo(sessionId);
		const cwd = preferredCwd || info?.cwd || process.cwd();
		const agents = discoverAgents(cwd, "both").agents;
		return runAsyncSingleAgent(cwd, agents, "_worker", prompt, ui, sessionId);
	};

	// ── /agent-results 命令：查看最近完成的 agent 结果 ──
	pi.registerCommand("agent-results", {
		description: "Show recent subagent task results",
		handler: async (_args, ctx) => {
			const branch = ctx.sessionManager.getBranch();
			let count = 0;
			let output = "Recent agent results:\n";
			for (let i = branch.length - 1; i >= 0 && count < 5; i--) {
				const entry = branch[i];
				if (entry.type === "entry" && (entry.value as any)?.key?.startsWith("agent:")) {
					const v = entry.value as any;
					output += `\n/${v.agent} (${v.exitCode === 0 ? "✓" : "✗"}): ${v.summary}`;
					count++;
				}
			}
			ctx.ui.notify(output || "No results yet.", "info");
		},
	});

	// ── 打开 agent 选择/实时视图（由 /agent-live 和 Ctrl+A 调用）──
	const openAgentView = async (ctx: any) => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Agent view requires TUI mode", "error");
			return;
		}
		await ctx.ui.custom((_tui, theme, _keybindings, done) => {
		class AgentView implements Focusable {
			focused = false;
			private selectedIdx = 0;
			private refreshTimer: any = null;
			private statusText = new Text("", 0, 0);
			private listText = new Text("", 0, 0);
			private outputText = new Text("", 0, 0);
			private footerText = new Text(theme.fg("dim", "↑↓ select  Enter view  Esc close"), 0, 0);
			private container = new Container();

			constructor() {
				this.container.addChild(this.statusText);
				this.container.addChild(new Spacer(1));
				this.container.addChild(this.listText);
				this.container.addChild(new Spacer(1));
				this.container.addChild(this.outputText);
				this.container.addChild(new Spacer(1));
				this.container.addChild(this.footerText);
				this.refresh();
				this.refreshTimer = setInterval(() => this.refresh(), 2000);
				this.container.dispose = () => clearInterval(this.refreshTimer);
			}

			private runningTasks() {
				const all = new Map(asyncTasks);
				for (const [id, e] of discoverExternalTasks()) {
					if (!all.has(id)) all.set(id, e);
				}
				return Array.from(all.entries()).filter(([_, t]) => !t.proc.killed && t.proc.exitCode === null);
			}

			private refresh() {
				const running = this.runningTasks();
				const now = Date.now();
				if (this.selectedIdx >= running.length) this.selectedIdx = running.length - 1;
				if (this.selectedIdx < 0) this.selectedIdx = 0;

				this.statusText.text = theme.fg("accent", `Subagents: ${running.length} running`);

				if (running.length === 0) {
					this.listText.text = theme.fg("dim", "(no running agents)");
					this.outputText.text = "";
					if (this.focused) (_tui as any)?.requestRender?.();
					return;
				}

				// agent 列表，选中项用 > 标记
				const listLines = running.map(([id, t], i) => {
					const elapsed = Math.round((now - t.startTime) / 1000);
					const prefix = i === this.selectedIdx ? theme.fg("success", ">") : " ";
					const name = i === this.selectedIdx ? theme.bold(t.agent) : t.agent;
					const rmuxTag = t.useRmux ? theme.fg("dim", " [rmux]") : "";
					return `  ${prefix} ${name}${rmuxTag}  [${id}]  ${t.task.slice(0, 60)} (${elapsed}s)${fmtUsageShort(t.usage)}`;
				}).join("\n");
				this.listText.text = listLines;

				// 选中项的实时输出
				const [selId, selTask] = running[this.selectedIdx];
				const logPath = path.join(getAgentLogDir(), `${selId}.jsonl`);
				let raw = "";
				try { raw = fs.readFileSync(logPath, "utf-8"); } catch {}
				let output = "";
				for (const line of raw.split("\n")) {
					if (!line.trim()) continue;
					try {
						const ev = JSON.parse(line);
						if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
							output += ev.assistantMessageEvent.delta;
						}
					} catch {}
				}
				this.outputText.text = output ? `├─ ${selTask.agent} output:\n${output.slice(0, 500)}` : "";
				if (selTask.useRmux && selTask.rmuxAttachCmd && !output) {
					this.outputText.text = theme.fg("dim", `Attach: ${selTask.rmuxAttachCmd}`);
				}

				if (this.focused) (_tui as any)?.requestRender?.();
			}

			handleInput(data: string): void {
				const running = this.runningTasks();
				if (matchesKey(data, "escape") || matchesKey(data, "q")) {
					clearInterval(this.refreshTimer);
					done(undefined);
					return;
				}
				if (matchesKey(data, "up") && this.selectedIdx > 0) {
					this.selectedIdx--;
					this.refresh();
					return;
				}
				if (matchesKey(data, "down") && this.selectedIdx < running.length - 1) {
					this.selectedIdx++;
					this.refresh();
					return;
				}
				if (matchesKey(data, "return") && running.length > 0) {
					clearInterval(this.refreshTimer);
					done({ taskId: running[this.selectedIdx][0] });
					return;
				}
			}

			get height(): number { return 0; }
			render(w: number): string[] { return this.container.render(w); }
		}

		return new AgentView();
		}, { overlay: false });
	};

	// ── /agent-live 命令 ──
	pi.registerCommand("agent-live", {
		description: "View running subagents (↑↓ select, Enter view, Esc close)",
		handler: async (_args, ctx) => { await openAgentView(ctx); },
	});

	// ── Alt+A 快捷键 ──
	pi.registerShortcut("alt+a", {
		description: "Open subagent live view",
		handler: async (ctx) => { await openAgentView(ctx); },
	});

	// ── subagent 管理工具：让主 agent（LLM）可以直接 kill / 重连运行中的子 agent ──

	// 列出运行中的 subagent（taskId / agent / sessionId ），供主 agent 匹配
	pi.registerTool({
		name: "subagent_list",
		label: "Subagent List",
		description: "List currently running subagents with their task id, agent name, pi session id and task description. Use this to identify which subagent to kill/reload.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const all = findRunningTasks({});
			const lines = all.map(({ taskId, entry }) => {
				if (!entry.sessionId) entry.sessionId = getTaskSessionId(taskId) || undefined;
				if (!entry.usage || !entry.usage.turns) accumulateTaskUsage(taskId, entry);
				const sess = entry.sessionId ? ` session=${entry.sessionId}` : "";
				return `- ${taskId} agent=${entry.agent}${sess} rmux=${entry.useRmux ? "yes" : "no"}${fmtUsageShort(entry.usage)} task="${entry.task.slice(0, 100)}"`;
			});
			void ctx;
			return {
				content: [{ type: "text", text: all.length ? lines.join("\n") : "No running subagents." }],
			};
		},
	});

	// kill + 重连运行中的 subagent（不丢上下文，重载工具/扩展/MCP）
	pi.registerTool({
		name: "subagent_reload",
		label: "Subagent Reload",
		description: [
			"Kill and reconnect a running subagent WITHOUT losing its context — or resume a paused/previous session directly.",
			"For a RUNNING subagent: it is killed, then resumed from its saved pi session (--session), so it keeps all memory/task state while picking up freshly loaded tools/extensions/MCP after restart.",
			"For a PAUSED/finished session (not running): just resume it directly (no kill needed).",
			"Use this after updating tools (MCP server, extensions, skills) so subagents get the new toolset, or to resume an interrupted subagent.",
			"",
			"Identify by ANY of:",
			"- taskId: task id or substring, e.g. 'task-abc123'",
			"- agent: agent name, e.g. 'scout'",
			"- sessionId: pi session id, e.g. '019f...'",
			"- If none given, ALL running subagents are reloaded.",
			"Run subagent_list first if unsure which subagent matches.",
		].join(" "),
		parameters: Type.Object({
			taskId: Type.Optional(Type.String({ description: "Task id or substring of a running subagent" })),
			agent: Type.Optional(Type.String({ description: "Agent name of the running subagent(s)" })),
			sessionId: Type.Optional(Type.String({ description: "Pi session id of the running subagent" })),
			prompt: Type.Optional(Type.String({ description: "Instructions after reconnect. Default: continue the previous task" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const defaultPrompt = "你被主 agent 重新连接了（工具/环境可能已更新）。请先简要总结当前进度，然后继续完成你之前的任务。";
			const prompt = (params.prompt || "").trim() || defaultPrompt;
			const running = findRunningTasks({ taskId: params.taskId, agent: params.agent, sessionId: params.sessionId });
			if (running.length === 0) {
				// 没有运行中的匹配：尝试直接重连暂停/已结束的 session（不 kill）
				const sid = (params.sessionId || "").trim();
				const q = (params.taskId || "").trim();
				if (sid) {
					const newTaskId = await resumeSession(sid, prompt, ctx.ui);
					return { content: [{ type: "text", text: newTaskId ? `Session ${sid.slice(0, 8)}… resumed as ${newTaskId}` : `Session ${sid} resume failed (not found?)` }] };
				}
				if (q) {
					const taskId = findTaskIdBySubstring(q);
					const sessionId = taskId ? getTaskSessionId(taskId) : null;
					if (sessionId) {
						const newTaskId = await resumeSession(sessionId, prompt, ctx.ui);
						return { content: [{ type: "text", text: newTaskId ? `Task "${taskId}" (session ${sessionId.slice(0, 8)}…) resumed as ${newTaskId}` : "Resume failed" }] };
					}
				}
				const all = findRunningTasks({});
				return {
					content: [{ type: "text", text: `No running subagent matched and nothing to resume. Running subagents:\n${formatRunningTasks(all)}` }],
				};
			}
			const results: string[] = [];
			for (const { taskId } of running) {
				results.push(await reloadTask(taskId, prompt, ctx.ui));
			}
			return { content: [{ type: "text", text: results.join("\n") }] };
		},
	});

	// 只 kill 不重连（停掉跑偏/卡住的子 agent）
	pi.registerTool({
		name: "subagent_stop",
		label: "Subagent Stop",
		description: "Kill a running subagent WITHOUT resuming it. Its session file is preserved, so it can be resumed later (e.g. via /agent:resume or subagent_reload with sessionId). Identify by taskId / agent / sessionId; if none given, all running subagents are stopped.",
		parameters: Type.Object({
			taskId: Type.Optional(Type.String({ description: "Task id or substring" })),
			agent: Type.Optional(Type.String({ description: "Agent name" })),
			sessionId: Type.Optional(Type.String({ description: "Pi session id" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const running = findRunningTasks({ taskId: params.taskId, agent: params.agent, sessionId: params.sessionId });
			if (running.length === 0) {
				const all = findRunningTasks({});
				return {
					content: [{ type: "text", text: `No running subagent matched. Running subagents:\n${formatRunningTasks(all)}` }],
				};
			}
			const results: string[] = [];
			for (const { taskId, entry } of running) {
				const ok = await killTask(taskId);
				results.push(`${ok ? "✓" : "✗"} ${taskId} (${entry.agent}) ${ok ? "killed" : "kill failed"}`);
			}
			void ctx;
			return { content: [{ type: "text", text: results.join("\n") }] };
		},
	});

	// ── /agent:resume <session-id> [继续指令] 命令：重连既有 subagent 会话（显示在 widget）──
	pi.registerCommand("agent:resume", {
		description: "Resume a previous subagent session (shows in widget). Usage: /agent:resume <session-id> [continue instructions]",
		handler: async (args, ctx) => {
			const trimmed = (args || "").trim();
			const parts = trimmed.split(/\s+/);
			const sessionId = parts[0] || "";
			const continueTask = parts.slice(1).join(" ") || "继续你之前的任务";
			if (!sessionId) {
				ctx.ui.notify("Usage: /agent:resume <session-id> [continue instructions]", "error");
				return;
			}
			// 用 _worker 通用 agent 重连既有会话
			const taskId = await runAsyncSingleAgent(ctx.cwd, [], "_worker", continueTask, ctx.ui, sessionId);
			if (!taskId) {
				ctx.ui.notify(`Failed to resume session ${sessionId}`, "error");
				return;
			}
			const entry = asyncTasks.get(taskId);
			const rmuxLine = entry?.useRmux && entry?.rmuxAttachCmd
				? `\nAttach: ${entry.rmuxAttachCmd}`
				: "";
			ctx.ui.notify(`⏳ Resumed session ${sessionId} (${taskId}) — will notify on completion.${rmuxLine}`, "info");
		},
	});

	// ── /agents 命令 ──
	pi.registerCommand("agents", {
		description: "List available subagents",
		handler: async (args, ctx) => {
			const scope: AgentScope = args === "all" ? "both" : "user";
			const discovery = discoverAgents(ctx.cwd, scope);
			const lines = discovery.agents.map((a) =>
				`  /agent:${a.name}  ${a.description}${a.source === "project" ? " (project)" : ""}`
			);
			ctx.ui.notify(`${discovery.agents.length} agent(s) available:\n` + lines.join("\n"), "info");
		},
	});

	// ── /agent:<name> 命令 ──
	const userDir = path.join(getAgentDir(), "agents");
	if (fs.existsSync(userDir)) {
		try {
			for (const entry of fs.readdirSync(userDir, { withFileTypes: true })) {
				if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
				const { frontmatter, body } = parseFrontmatter<Record<string, string>>(fs.readFileSync(path.join(userDir, entry.name), "utf-8"));
				if (!frontmatter.name || !frontmatter.description) continue;
				const agentName = frontmatter.name;
				pi.registerCommand(`agent:${agentName}`, {
					description: frontmatter.description,
					handler: async (args, cmdCtx) => {
						await cmdCtx.ui.sendUserMessage(`用 ${agentName} ${args.trim() || "请执行任务"}`, { deliverAs: "steer" });
					},
				});
			}
		} catch { /* ignore */ }
	}

	// ── session_start: footer + UI 引用 + 周期刷新子代理 widget ──
	// 单引号转义(rmux 选项值)
	const sq = (x: string) => `'${x.replace(/'/g, "'\\''")}'`;
	pi.on("session_start", async (event, ctx) => {
		sessionUI = ctx.ui;
		currentSessionId = (ctx as any).sessionManager?.getSessionId?.() || "";
		// reload 安全:把会话状态存到 globalThis,新模块加载时恢复
		const g = globalThis as any;
		g.__pi_subagent_ui__ = ctx.ui;
		g.__pi_subagent_sid__ = currentSessionId;
		// 自注册:把本 pi 的会话文件写进所在 rmux 窗口的 @pi_session 选项,
		// 桌面端读选项即可精确归属(pim / Open TUI 任何 pane 都可靠),
		// 不再依赖"最接近启动时间"启发式(空闲会话会误判)
		try {
			const sessFile = (ctx as any).sessionManager?.getSessionFile?.() || "";
			let win = "";
			try { win = execSync("rmux display-message -p '#{session_name}:#{window_name}'", { stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).toString().trim(); } catch {}
			// 只在真正身处 rmux pane 时自注册:非 tmux 上下文(终端里的 pi)执行
			// display-message 会返回“上次活跃的 rmux 窗口”,把 @pi_session 写进
			// 别人的窗口,导致桌面端归属错乱(终端 pi 被显示成 rmux)。
			if (sessFile && win && process.env.TMUX) {
				// 窗口创建/自动重命名的竞态会让首次 set-option 失败(实测 reg ERR),
				// 而注册只在 session_start 跑一次——失败就永远没有 @pi_session。
				// 重试几次,最终失败也留下 diag 记录。
				for (let i = 0; i < 3; i++) {
					try {
						execSync(`rmux set-option -w -t ${sq(win)} @pi_session ${sq(sessFile)}`, {
							stdio: ["ignore", "pipe", "ignore"], timeout: 3000,
						});
						break;
					} catch (e: any) {
						if (i === 2) {
							diagLog(`reg ERR ${String(e).slice(0, 150)}`);
						} else {
							await new Promise((r) => setTimeout(r, 800));
						}
					}
				}
			}
			g.__pi_subagent_sfile__ = sessFile;
		} catch (e: any) {
			try { fs.appendFileSync(path.join(getAgentLogDir(), "extension-diag.log"), `[${new Date().toISOString()}] pid=${process.pid} reg ERR ${String(e).slice(0, 150)}\n`); } catch {}
		}
		const discovery = discoverAgents(ctx.cwd, "both");
		ctx.ui.setStatus("z_agents", ctx.ui.theme.fg("accent", `Agents: ${discovery.agents.length}`));
		// 4s 周期刷新:让新 pi 也能显示其他进程运行中的子代理(外部任务)
		if (!globalThis.__pi_subagent_widget_timer__) {
			// 定时器经 globalThis tick 间接调用:reload 后旧定时器仍存在
			//(全局防重),但会调用新模块的 tick -> 新 renderSubagentWidget
			globalThis.__pi_subagent_widget_timer__ = setInterval(() => {
				const tick = (globalThis as any).__pi_subagent_widget_tick__;
				if (tick) tick();
			}, 4000);
			(globalThis.__pi_subagent_widget_timer__ as any).unref?.();
		}
	});

	// reload 安全:模块(重)加载时恢复会话状态、重注册归属、更新 tick
	function initWidgetState() {
		const g = globalThis as any;
		if (g.__pi_subagent_ui__) sessionUI = g.__pi_subagent_ui__;
		if (g.__pi_subagent_sid__) currentSessionId = g.__pi_subagent_sid__;
		const sfile = g.__pi_subagent_sfile__ || "";
		if (sfile) {
			try {
				const win = execSync("rmux display-message -p '#{session_name}:#{window_name}'", { stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).toString().trim();
				if (win) execSync(`rmux set-option -w -t ${sq(win)} @pi_session ${sq(sfile)}`, { stdio: ["ignore", "pipe", "ignore"], timeout: 3000 });
			} catch {}
		}
		g.__pi_subagent_widget_tick__ = () => { if (sessionUI) renderSubagentWidget(sessionUI); };
	}
	initWidgetState();
}
