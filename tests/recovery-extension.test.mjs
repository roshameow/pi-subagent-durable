// Exercise the real extension commands/lifecycle with host and RMUX adapters.
// No installed Pi, RMUX daemon, provider, or user registry is contacted.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { atomicRecoveryWrite, taskRecordPath, readTaskRecords } from "../extensions/recovery.mjs";
const originalNow = Date.now;
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "durable-extension-test-")));
const oldNotify = process.env.PI_AGENT_NOTIFY_DIR, oldTask = process.env.PI_SUBAGENT_TASK_ID;
delete process.env.PI_SUBAGENT_TASK_ID; process.env.PI_AGENT_NOTIFY_DIR = path.join(root, "notify");
fs.mkdirSync(path.join(root, "agent-logs"));
const peers = {
  "@earendil-works/pi-ai": 'export const StringEnum = () => ({});',
  "@earendil-works/pi-coding-agent": `export const CONFIG_DIR_NAME='.pi';export const getAgentDir=()=>${JSON.stringify(root)};export const getMarkdownTheme=()=>({});export const parseFrontmatter=()=>({frontmatter:{},body:''});export const withFileMutationQueue=async(_p,f)=>f();`,
  "@earendil-works/pi-tui": 'export class Container{};export class Markdown{};export class Spacer{};export class Text{constructor(text){this.text=text}};export const matchesKey=()=>false;',
  "typebox": 'const f=()=>({});export const Type=new Proxy({}, {get:()=>f});',
  "node:child_process": `export const spawn=()=>{throw Error('real spawn forbidden')};export const execSync=(cmd)=>{if(cmd==='rmux -V')return 'fixture';if(cmd.includes('ps -o tty'))return 'fixture-tty';if(cmd.startsWith('rmux'))return '';throw Error('unexpected exec '+cmd)};export const execFileSync=(cmd)=>{if(cmd==='ps')return '';if(cmd==='rmux')return '';throw Error('unexpected exec '+cmd)};`,
};
const source = fs.readFileSync("extensions/index.ts", "utf8").replace('const mod = await import(resolveRmuxSdk());', 'const mod = { Rmux: { builder: () => ({ connectOrStart: async () => globalThis.__fixtureRmux }) } };');
const file = path.join(root, "extension.mjs");
let state = "live";
const taskId = "task-extension-aaaa", target = `pi-agents:fixture-${taskId}.0`;
globalThis.__fixtureRmux = { cmd: async (...args) => {
  assert.equal(args[0], "list-panes", "recovery/prepare must not restart or kill panes");
  if (state === "unknown") return { returnCode: 1, stderr: "fixture connection failure" };
  return { returnCode: 0, stdout: args.includes("#{session_name}|#{window_name}|#{pane_dead}")
    ? `pi-agents|fixture-${taskId}|${state === "dead" ? 1 : 0}`
    : `${target}|${state === "dead" ? 1 : 0}|0` };
} };
const parentId = "fixture-parent", parentPath = path.join(root, "parent.jsonl");
fs.writeFileSync(parentPath, JSON.stringify({ type: "session", id: parentId, cwd: root }) + "\n");
const logPath = path.join(root, "agent-logs", `${taskId}.jsonl`);
fs.writeFileSync(logPath, '{"type":"agent_settled"}\n');
atomicRecoveryWrite(taskRecordPath(path.join(root, "durable-tasks"), taskId), { version: 1, taskId, mode: "async-rmux", parentSessionId: parentId, parentSessionPath: parentPath, agent: "fixture", task: "fixture", cwd: root, rmuxTarget: target, logPath });
const commands = new Map(), tools = new Map(), handlers = new Map(), entries = [], sent = [], queued = [], notices = [];
const ctx = { cwd: root, isIdle: () => true, model: { id: "fixture", provider: "fixture" },
  sessionManager: { getSessionId: () => parentId, getSessionFile: () => parentPath, getEntries: () => entries, getBranch: () => entries },
  ui: { setStatus(){}, setWidget(){}, theme:{fg:(_c,s)=>s}, notify:(s)=>notices.push(s) } };
const pi = { on:(n,f)=>handlers.set(n,f), registerTool:t=>tools.set(t.name,t), registerCommand:(n,d)=>commands.set(n,d), registerShortcut(){}, getActiveTools:()=>[],
  appendEntry:(customType,data)=>{entries.push({type:"custom",customType,data});fs.appendFileSync(parentPath, JSON.stringify(entries.at(-1))+"\n");},
  sendUserMessage:s=>{sent.push(s);queued.push(s);} };
try {
  const mockPaths = new Map();
  let i = 0;
  for (const [name, content] of Object.entries(peers)) {
    const mock = path.join(root, `mock-${i++}.mjs`); fs.writeFileSync(mock, content); mockPaths.set(name, mock);
  }
  const replacePeers = text => { for (const [name, mock] of mockPaths) text = text.replaceAll(JSON.stringify(name), JSON.stringify(mock)); return text; };
  const mockAgents = path.join(root, "agents.ts");
  fs.writeFileSync(mockAgents, replacePeers(fs.readFileSync("extensions/agents.ts", "utf8")));
  let bundledSource = replacePeers(source);
  bundledSource = bundledSource.replace(/"\.\/([^"\n]+)"/g, (_match, name) => JSON.stringify(name === "agents.ts" ? mockAgents : path.resolve("extensions", name)));
  const input = path.join(root, "index.ts"); fs.writeFileSync(input, bundledSource);
  execFileSync("npx", ["--no-install", "esbuild", input, "--bundle", "--platform=node", "--format=esm", `--outfile=${file}`], { stdio: "pipe" });
  const extension = await import(pathToFileURL(file));
  const legacyId="task-legacy-bbbb";
  const legacyEntry={agent:"legacy-fixture",task:"legacy",cwd:root,parentSessionId:parentId,useRmux:true,rmuxTarget:`pi-agents:legacy-${legacyId}.0`,proc:{killed:false,exitCode:null},startTime:Date.now()};
  globalThis.__pi_subagent_async_tasks__.set(legacyId,legacyEntry);
  atomicRecoveryWrite(taskRecordPath(path.join(root,"durable-tasks"),legacyId),{version:1,taskId:legacyId,mode:"async-rmux",parentSessionId:parentId,parentSessionPath:parentPath,agent:"legacy-fixture",task:"legacy",cwd:root,rmuxTarget:legacyEntry.rmuxTarget,logPath});
  extension.default(pi);
  await handlers.get("session_start")({}, ctx);
  assert.ok(globalThis.__pi_subagent_async_tasks__.get(taskId)?.recoveryManaged, "session_start rebuilds the managed live task");
  assert.equal(globalThis.__pi_subagent_async_tasks__.get(legacyId),legacyEntry,"reload preserves the existing callback-owned entry");
  assert.equal(legacyEntry.recoveryManaged,undefined,"legacy callback is not adopted by a second completion monitor");
  const leases=JSON.parse(fs.readFileSync(path.join(root,"durable-tasks",".controllers.json"))).leases;
  assert.equal(leases[legacyId].ownerPid,process.pid,"existing callback retains controller authority without another completion monitor");
  const foreignId="task-foreign-cccc",unknownId="task-unknown-dddd";
  globalThis.__pi_subagent_async_tasks__.set(foreignId,{...legacyEntry,parentSessionId:"another-main",task:"foreign same-cwd task"});
  globalThis.__pi_subagent_async_tasks__.set(unknownId,{...legacyEntry,parentSessionId:undefined,task:"unknown same-cwd task"});
  const listTool=tools.get("subagent_list");
  const ownList=await listTool.execute("own",{},null,null,ctx);
  assert.deepEqual(new Set(ownList.details.taskIds),new Set([taskId,legacyId]),"default list hides foreign and unknown entries even in the same process/cwd");
  const machineList=await listTool.execute("machine",{scope:"machine"},null,null,ctx);
  assert.ok(machineList.details.taskIds.includes(foreignId)&&machineList.details.taskIds.includes(unknownId),"main-only machine scope is explicit");
  const changedCtx={...ctx,sessionManager:{...ctx.sessionManager,getSessionId:()=>"another-main"}};
  const changedList=await listTool.execute("changed",{},null,null,changedCtx);
  assert.deepEqual(changedList.details.taskIds,[foreignId],"list reads the calling session identity, not a stale module-global ID");
  const unknownCtx={...ctx,sessionManager:{...ctx.sessionManager,getSessionId:()=>""}};
  const unknownList=await listTool.execute("unknown",{},null,null,unknownCtx);
  assert.deepEqual(unknownList.details.taskIds,[],"unknown caller session does not fall back to stale module-global ownership");
  globalThis.__pi_subagent_async_tasks__.delete(foreignId);globalThis.__pi_subagent_async_tasks__.delete(unknownId);
  state = "unknown"; await commands.get("agent:recover").handler("",ctx); assert.equal(sent.length,0);
  state = "dead"; await commands.get("agent:recover").handler("",ctx); assert.equal(sent.length,1);
  assert.equal(readTaskRecords(path.join(root,"durable-tasks"),parentId)[0].deliveredAt,undefined,"queued notification is not prematurely acknowledged");
  await commands.get("agent:recover").handler("",ctx); assert.equal(sent.length,1,"one queued notification per runtime");
  // Fire-and-forget rejection/consumed input: nothing reaches the transcript.
  // Once idle and the bounded retry interval elapsed, recover retries publication.
  const realNow=Date.now; const time=realNow(); Date.now=()=>time+31000;
  await commands.get("agent:recover").handler("",ctx);
  assert.equal(sent.length,2,"unacknowledged fire-and-forget delivery retries after 30 seconds while idle");
  while(queued.length) { const content=queued.shift();entries.push({type:"message",message:{role:"user",content}});fs.appendFileSync(parentPath,JSON.stringify(entries.at(-1))+"\n"); }
  await commands.get("agent:recover").handler("",ctx);
  assert.ok(readTaskRecords(path.join(root,"durable-tasks"),parentId)[0].deliveredAt);
  assert.ok(entries.some(e=>e.customType==="agent-delivery"));
  await commands.get("agent-results").handler("",ctx); assert.match(notices.at(-1),/fixture/);
  // prepare refuses before starting the detached keeper or changing reservations.
  await commands.get("agent:prepare-upgrade").handler("",{...ctx,isIdle:()=>false}); assert.match(notices.at(-1),/busy/);
  globalThis.__pi_subagent_async_tasks__.set("task-fallback-bbbb", {parentSessionId:parentId,useRmux:false});
  await commands.get("agent:prepare-upgrade").handler("",ctx); assert.match(notices.at(-1),/live spawn/);
  globalThis.__pi_subagent_async_tasks__.delete("task-fallback-bbbb");
  await handlers.get("session_shutdown")();
  const otherPath=path.join(root,"other.jsonl");fs.writeFileSync(otherPath,JSON.stringify({type:"session",id:"other"})+"\n");
  await handlers.get("session_start")({}, {...ctx,sessionManager:{...ctx.sessionManager,getSessionId:()=>"other",getSessionFile:()=>otherPath}});
  assert.equal(sent.length,2,"other parent cannot collect the completion");
  // Old callbacks clean their Map entry before using the global completion API.
  globalThis.__pi_subagent_async_tasks__.delete(legacyId);
  globalThis.__pi_subagent_completion_sender__('Agent "legacy-fixture" 结果: completed');
  assert.equal(sent.length,2,"body-only pre-reload completion cannot steer into /new after cleanup");
  globalThis.__pi_subagent_completion_sender__('Agent "fixture" completed',parentId);
  assert.equal(sent.length,2,"new callbacks carry exact dispatch parent across /new");
  await handlers.get("session_shutdown")();
  console.log("OK: real extension session_start/recover, queued delivery acknowledgment, custom results and unsafe prepare refusal via mock host/RMUX");
} finally {
  await handlers.get("session_shutdown")?.();
  Date.now = originalNow;
  if(oldNotify===undefined)delete process.env.PI_AGENT_NOTIFY_DIR;else process.env.PI_AGENT_NOTIFY_DIR=oldNotify;
  if(oldTask===undefined)delete process.env.PI_SUBAGENT_TASK_ID;else process.env.PI_SUBAGENT_TASK_ID=oldTask;
  delete globalThis.__fixtureRmux;fs.rmSync(root,{recursive:true,force:true});
}
