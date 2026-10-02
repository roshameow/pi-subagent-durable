#!/usr/bin/env node
// Bootstrap for a parent already running an older extension. This does not load
// or reload Pi, does not send prompts, and never signals any worker.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { startReceiverKeeper } from "../extensions/receiver-keeper.mjs";
import { prepareUpgrade, publishUpgradeManifest } from "../extensions/upgrade-handoff.mjs";
import { preserveMainNotifyIdentity } from "../extensions/main-notify-handoff.mjs";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--session") {
  console.error("Usage: node scripts/prepare-upgrade.mjs --session /absolute/canonical-parent.jsonl"); process.exitCode = 1;
} else {
  try {
    const parentSessionPath = fs.realpathSync(args[1]);
    const fd = fs.openSync(parentSessionPath, "r"), buffer = Buffer.alloc(8192);
    let bytes; try { bytes = fs.readSync(fd, buffer, 0, buffer.length, 0); } finally { fs.closeSync(fd); }
    const header = JSON.parse(buffer.subarray(0, bytes).toString("utf8").split("\n")[0]);
    const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
    const notifyDir = process.env.PI_AGENT_NOTIFY_DIR || "/tmp/pi-agent-notify";
    // The legacy parent's runtime slot binds its PID to this canonical file.
    const runtimeDir = path.join(agentDir, "runtime");
    const owners = fs.readdirSync(runtimeDir).flatMap(name => {
      try {
        const row = JSON.parse(fs.readFileSync(path.join(runtimeDir, name), "utf8"));
        if (row.type !== "pi_runtime" || fs.realpathSync(row.sessionPath) !== parentSessionPath) return [];
        process.kill(row.pid, 0); return [row];
      } catch { return []; }
    });
    if (owners.length !== 1) throw new Error(`expected exactly one live canonical parent runtime, found ${owners.length}`);
    const mainIdentityPath = preserveMainNotifyIdentity({
      notifyDir, notifyStateDir: process.env.PI_AGENT_NOTIFY_STATE_DIR || path.join(os.homedir(), ".pi", "agent", "agent-notify"),
      parentSessionId: header.id, parentSessionPath, parentPid: Number(owners[0].pid), cwd: header.cwd,
    });
    const query = String(execFileSync("rmux", ["list-panes", "-a", "-F", "#{session_name}|#{window_name}|#{pane_dead}"], { timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }));
    const panes = query.trim().split("\n").filter(Boolean).map(line => {
      const parts = line.split("|"); if (parts.length !== 3 || !["0", "1"].includes(parts[2])) throw new Error("unrecognized RMUX pane response"); return parts;
    });
    const ps = String(execFileSync("ps", ["-axo", "command="], { timeout: 5000 }));
    const result = await prepareUpgrade({
      parentSessionId: header.id, parentSessionPath, cwd: header.cwd,
      ledgerDir: path.join(agentDir, "durable-tasks"), logDir: path.join(agentDir, "agent-logs"),
      sessionsRoot: path.join(agentDir, "sessions"), registryPath: path.join(notifyDir, ".active-workers.json"),
      notifyDir, expectedOwnerPid: Number(owners[0].pid),
      probe: async record => {
        const hit = panes.find(([session, window]) => session === "pi-agents" && window.endsWith(`-${record.taskId}`));
        if (hit) return { state: hit[2] === "1" ? "dead" : "live", rmuxTarget: `${hit[0]}:${hit[1]}.0` };
        const fallback = ps.split("\n").some(line => line.trim().startsWith(`pi-subagent-${record.taskId}`));
        return { state: fallback ? "live" : "dead" };
      },
    });
    const keeper = result.records.length ? await startReceiverKeeper({ ledgerDir: path.join(agentDir, "durable-tasks"), registryPath: path.join(notifyDir, ".active-workers.json") }) : null;
    publishUpgradeManifest(result, keeper);
    console.log(`Prepared ${result.records.length} existing async RMUX task(s). No worker was signaled or restarted.`);
    console.log(`Preserved exact main notification identity: ${mainIdentityPath}`);
    console.log("Stop dispatching work and exit only the idle original parent immediately; after installing the new code, restart with:");
    console.log(result.command);
    if (keeper) console.log(`Legacy receiver keeper PID=${keeper.pid}, bound until ${new Date(keeper.expiresAt).toISOString()}`);
    console.log("Use /agent:recover to inspect controller acquisition. taskId/runId/nonce/watcher lease were unchanged.");
  } catch (error) { console.error(`Prepare refused: ${error.message}. Do NOT exit the parent until preparation succeeds.`); process.exitCode = 1; }
}
