// Exercise the real extension commands/lifecycle with host and RMUX adapters.
// No installed Pi, RMUX daemon, provider, or user registry is contacted.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { atomicRecoveryWrite, taskRecordPath, readTaskRecords } from "../extensions/recovery.mjs";
import { registerWorkerOwnership, readWorkerOwnershipRegistry } from "../extensions/ownership-registry.mjs";
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
  "node:fs": `export * from 'node:fs';import fs from 'node:fs';export const renameSync=(from,to)=>{globalThis.__fixtureRuntimeRename?.(from,to);return fs.renameSync(from,to)};`,
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
const parentAlias = path.join(root, "parent-alias.jsonl");
fs.symlinkSync(parentPath, parentAlias);
const runtimeDir = path.join(root, "runtime"), runtimeSlot = path.join(runtimeDir, `${process.pid}.jsonl`);
const readRuntime = () => JSON.parse(fs.readFileSync(runtimeSlot, "utf8"));
const assertNoRuntimeTemps = () => assert.deepEqual(fs.readdirSync(runtimeDir), [`${process.pid}.jsonl`], "atomic runtime writes must not leave temporary files");
const runtimeWrites = [], recoveryStages = [], warnings = [];
const originalWarn = console.warn;
console.warn = (...args) => { warnings.push(args.map(String).join(" ")); originalWarn(...args); };
let expectedIdentity = { sessionId: parentId, sessionPath: parentPath };
const assertRuntimeIdentity = record => {
  assert.equal(record.type, "pi_runtime"); assert.equal(record.pid, process.pid);
  assert.equal(record.sessionId, expectedIdentity.sessionId); assert.equal(record.sessionPath, expectedIdentity.sessionPath);
  assert.equal(record.cwd, root); assert.equal(typeof record.startedAt, "number");
};
globalThis.__fixtureRuntimeRename = (from, to) => {
  if (to !== runtimeSlot) return;
  assert.equal(path.dirname(from), runtimeDir, "atomic rename stays on the slot's filesystem");
  assert.notEqual(from, to); assert.equal(fs.statSync(from).mode & 0o777, 0o600);
  const text = fs.readFileSync(from, "utf8"); assert.ok(text.endsWith("\n"));
  const record = JSON.parse(text); assertRuntimeIdentity(record); runtimeWrites.push(record);
};
globalThis.__fixtureRecoveryStage = stage => {
  const record = readRuntime(); assertRuntimeIdentity(record); assertNoRuntimeTemps();
  assert.equal(record.tty, "", "basic accurate slot precedes recovery and transport discovery");
  assert.equal(record.panePid, null); recoveryStages.push(stage);
};
const logPath = path.join(root, "agent-logs", `${taskId}.jsonl`);
fs.writeFileSync(logPath, '{"type":"agent_settled"}\n');
atomicRecoveryWrite(taskRecordPath(path.join(root, "durable-tasks"), taskId), { version: 1, taskId, mode: "async-rmux", parentSessionId: parentId, parentSessionPath: parentPath, agent: "fixture", task: "fixture", cwd: root, rmuxTarget: target, logPath });
const commands = new Map(), tools = new Map(), handlers = new Map(), entries = [], sent = [], queued = [], notices = [], statusUpdates = [];
const ctx = { cwd: root, isIdle: () => true, model: { id: "fixture", provider: "fixture" },
  sessionManager: { getSessionId: () => parentId, getSessionFile: () => parentAlias, getEntries: () => entries, getBranch: () => entries },
  ui: { setStatus:(key,value)=>statusUpdates.push({key,value}), setWidget(){}, theme:{fg:(_c,s)=>s}, notify:(s)=>notices.push(s) } };
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
  // Keep the real controller implementation; adapter hooks expose constructor /
  // recovery boundaries and allow a dependency failure, not a lifecycle rewrite.
  const mockRecovery = path.join(root, "recovery-adapter.mjs");
  fs.writeFileSync(mockRecovery, `export * from ${JSON.stringify(path.resolve("extensions/recovery.mjs"))};
    import {RecoveryController as RealController} from ${JSON.stringify(path.resolve("extensions/recovery.mjs"))};
    export class RecoveryController extends RealController {
      constructor(options){globalThis.__fixtureRecoveryStage?.('constructor');super(options);globalThis.__fixtureControllerOptions=options;this.firstRecovery=true}
      async recover(){if(this.firstRecovery){this.firstRecovery=false;globalThis.__fixtureRecoveryStage?.('recover')}return super.recover()}
    }`);
  let bundledSource = replacePeers(source);
  bundledSource = bundledSource.replace(/"\.\/([^"\n]+)"/g, (_match, name) => JSON.stringify(name === "agents.ts" ? mockAgents : (name === "recovery.mjs" || name === "recovery-v2.mjs") ? mockRecovery : path.resolve("extensions", name)));
  const input = path.join(root, "index.ts"); fs.writeFileSync(input, bundledSource);
  execFileSync("npx", ["--no-install", "esbuild", input, "--bundle", "--platform=node", "--format=esm", `--outfile=${file}`], { stdio: "pipe" });
  const extension = await import(pathToFileURL(file));
  const legacyId="task-legacy-bbbb";
  const legacyEntry={agent:"legacy-fixture",task:"Batch discussion mentions 131002 first; this worker still owns 131001",cwd:root,parentSessionId:parentId,useRmux:true,rmuxTarget:`pi-agents:legacy-${legacyId}.0`,proc:{killed:false,exitCode:null},startTime:Date.now()};
  const registryPath=path.join(process.env.PI_AGENT_NOTIFY_DIR,".active-workers.json");
  registerWorkerOwnership(registryPath,{taskId:legacyId,ownerPid:process.pid,ownerToken:"legacy-token",cwd:root,itemKeys:[`worker:${legacyId}`,"131001"]});
  registerWorkerOwnership(registryPath,{taskId:"task-other-owner-eeee",ownerPid:process.pid,ownerToken:"other-token",cwd:root,itemKeys:["worker:task-other-owner-eeee","131002"]});
  globalThis.__pi_subagent_worker_ownerships__=new Map([[legacyId,"legacy-token"]]);
  const refusedId="task-refused-ffff";
  registerWorkerOwnership(registryPath,{taskId:refusedId,ownerPid:process.pid,ownerToken:"real-token",cwd:root,itemKeys:[`worker:${refusedId}`,"131003"]});
  globalThis.__pi_subagent_worker_ownerships__.set(refusedId,"stale-token");
  globalThis.__pi_subagent_async_tasks__.set(refusedId,{...legacyEntry,agent:"refused-fixture"});
  globalThis.__pi_subagent_async_tasks__.set(legacyId,legacyEntry);
  atomicRecoveryWrite(taskRecordPath(path.join(root,"durable-tasks"),legacyId),{version:1,taskId:legacyId,mode:"async-rmux",parentSessionId:parentId,parentSessionPath:parentPath,agent:"legacy-fixture",task:"legacy",cwd:root,rmuxTarget:legacyEntry.rmuxTarget,logPath});
  extension.default(pi);
  await handlers.get("session_start")({type:"session_start",reason:"startup"}, ctx);
  assert.deepEqual(recoveryStages, ["constructor", "recover"], "early accurate registration exists before controller construction and recovery");
  assert.equal(runtimeWrites.length, 2, "basic slot and enrichment share the atomic writer");
  assert.equal(runtimeWrites[0].tty, ""); assert.equal(runtimeWrites[1].tty, "fixture-tty");
  assert.equal(runtimeWrites[0].startedAt, runtimeWrites[1].startedAt);
  assertRuntimeIdentity(readRuntime()); assertNoRuntimeTemps();
  const restoredKeys=readWorkerOwnershipRegistry(registryPath).workers[legacyId].itemKeys;
  assert.deepEqual(restoredKeys,[`worker:${legacyId}`,"131001"],"reload must not reinterpret a resumed task's unrelated first number as a new item binding");
  assert.ok(fs.existsSync(path.join(root,"runtime",`${process.pid}.jsonl`)),"a single restore refusal must not abort parent runtime registration");
  assert.equal(readWorkerOwnershipRegistry(registryPath).workers[refusedId].ownerToken,"real-token","restore refusal preserves the actual reservation");
  globalThis.__pi_subagent_async_tasks__.delete(refusedId);globalThis.__pi_subagent_worker_ownerships__.delete(refusedId);
  assert.ok(globalThis.__pi_subagent_async_tasks__.get(taskId)?.recoveryManaged, "session_start rebuilds the managed live task");
  const beforeFaultWarnings=warnings.length;
  const fault=Object.assign(new Error("simulated repeated controller expiry"),{code:"LEASE_EXPIRED"});
  for(let n=0;n<20;n++)globalThis.__fixtureControllerOptions.onError(fault,{taskId});
  assert.equal(warnings.length,beforeFaultWarnings,"background recovery errors never spam console/TUI stdout");
  assert.equal(statusUpdates.filter(s=>s.key==="subagent-recovery").length,1,"one persistent status per task/error, not one popup per poll");
  assert.equal(globalThis.__pi_subagent_async_tasks__.get(legacyId),legacyEntry,"reload preserves the existing callback-owned entry");
  assert.equal(legacyEntry.recoveryManaged,undefined,"legacy callback is not adopted by a second completion monitor");
  const leases=JSON.parse(fs.readFileSync(path.join(root,"durable-tasks",".controllers.json"))).leases;
  assert.equal(leases[legacyId].ownerPid,process.pid,"existing callback retains controller authority without another completion monitor");
  // Emulate host teardown + fresh module/factory, with the same SDK session/PID.
  const beforeReload = fs.readFileSync(runtimeSlot, "utf8");
  await handlers.get("session_shutdown")({type:"session_shutdown",reason:"reload"}, ctx);
  assert.equal(fs.readFileSync(runtimeSlot, "utf8"), beforeReload, "reload gap retains the exact original slot");
  const reloadExtension = await import(`${pathToFileURL(file)}?reload=1`);
  reloadExtension.default(pi);
  assert.equal(fs.readFileSync(runtimeSlot, "utf8"), beforeReload, "factory loading does not clear the slot");
  await handlers.get("session_start")({type:"session_start",reason:"reload"}, ctx);
  assertRuntimeIdentity(readRuntime()); assertNoRuntimeTemps();
  assert.equal(runtimeWrites.length, 4); assert.equal(recoveryStages.length, 4);
  assert.equal(globalThis.__pi_subagent_async_tasks__.get(legacyId), legacyEntry, "ctx reload does not kill or replace callback workers");
  assert.equal(legacyEntry.proc.killed, false);
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
  await handlers.get("session_shutdown")({type:"session_shutdown",reason:"new"}, ctx);
  assert.equal(fs.existsSync(runtimeSlot), false, "/new removes the old session slot");
  const otherPath=path.join(root,"other.jsonl");fs.writeFileSync(otherPath,JSON.stringify({type:"session",id:"other"})+"\n");
  const otherCtx = {...ctx,sessionManager:{...ctx.sessionManager,getSessionId:()=>"other",getSessionFile:()=>otherPath}};
  expectedIdentity = {sessionId:"other",sessionPath:otherPath};
  await handlers.get("session_start")({type:"session_start",reason:"new",previousSessionFile:parentPath}, otherCtx);
  assertRuntimeIdentity(readRuntime()); assertNoRuntimeTemps();
  assert.equal(sent.length,2,"other parent cannot collect the completion");
  // Old callbacks clean their Map entry before using the global completion API.
  globalThis.__pi_subagent_async_tasks__.delete(legacyId);
  globalThis.__pi_subagent_completion_sender__('Agent "legacy-fixture" 结果: completed');
  assert.equal(sent.length,2,"body-only pre-reload completion cannot steer into /new after cleanup");
  globalThis.__pi_subagent_completion_sender__('Agent "fixture" completed',parentId);
  assert.equal(sent.length,2,"new callbacks carry exact dispatch parent across /new");
  await handlers.get("session_shutdown")({type:"session_shutdown",reason:"resume"}, otherCtx);
  assert.equal(fs.existsSync(runtimeSlot), false, "/resume removes the old session slot");
  expectedIdentity = {sessionId:parentId,sessionPath:parentPath};
  await handlers.get("session_start")({type:"session_start",reason:"resume",previousSessionFile:otherPath}, ctx);
  assertRuntimeIdentity(readRuntime()); assertNoRuntimeTemps();

  // A real corrupt ControllerRegistry must fail closed, without losing runtime
  // identity or replacing reservations; recovery catches individual lease errors.
  await handlers.get("session_shutdown")({type:"session_shutdown",reason:"reload"}, ctx);
  const controllerPath = path.join(root,"durable-tasks",".controllers.json");
  const savedControllers = fs.readFileSync(controllerPath,"utf8");
  fs.writeFileSync(controllerPath,"{invalid registry");
  const savedOwnership = fs.readFileSync(registryPath,"utf8");
  await handlers.get("session_start")({type:"session_start",reason:"reload"}, ctx);
  assertRuntimeIdentity(readRuntime()); assert.equal(readRuntime().tty,"fixture-tty"); assertNoRuntimeTemps();
  await commands.get("agent:recover").handler("",ctx);
  assert.match(notices.at(-1),/registry contains invalid JSON/,"the real controller registry failure was exercised");
  assert.equal(fs.readFileSync(controllerPath,"utf8"),"{invalid registry", "runtime registration never repairs/steals controller authority");
  assert.equal(fs.readFileSync(registryPath,"utf8"),savedOwnership, "registry failure must not steal worker reservations");
  await handlers.get("session_shutdown")({type:"session_shutdown",reason:"reload"},ctx);
  fs.writeFileSync(controllerPath,savedControllers);

  // Both controller construction and recover() may throw. Later transport
  // enrichment still completes, and no authority fallback is attempted.
  const checkEarlyRuntime = globalThis.__fixtureRecoveryStage;
  for (const failStage of ["constructor","recover"]) {
    globalThis.__fixtureRecoveryStage = stage => {
      checkEarlyRuntime(stage);
      if(stage===failStage) throw Error(`fixture controller ${failStage} failed`);
    };
    await handlers.get("session_start")({type:"session_start",reason:"reload"},ctx);
    assertRuntimeIdentity(readRuntime()); assert.equal(readRuntime().tty,"fixture-tty"); assertNoRuntimeTemps();
    assert.equal(fs.readFileSync(registryPath,"utf8"),savedOwnership);
    assert.ok(warnings.some(s=>s.includes(`fixture controller ${failStage} failed`)));
    await handlers.get("session_shutdown")({type:"session_shutdown",reason:"reload"},ctx);
  }
  globalThis.__fixtureRecoveryStage = checkEarlyRuntime;

  // Inject atomic-rename failures in both phases. Base failure is diagnostic;
  // enrichment failure retains the published base and cleans its private tmp.
  const observeRename = globalThis.__fixtureRuntimeRename;
  for (const failPhase of [1,2]) {
    await handlers.get("session_shutdown")({type:"session_shutdown",reason:"fork"},ctx);
    assert.equal(fs.existsSync(runtimeSlot),false,"/fork removes the old slot");
    let phase = 0;
    globalThis.__fixtureRuntimeRename = (from,to) => {
      observeRename(from,to);
      if(to===runtimeSlot && ++phase===failPhase) throw Error(`fixture runtime rename failure ${failPhase}`);
    };
    globalThis.__fixtureRecoveryStage = stage => {
      if(failPhase===1) {assert.equal(fs.existsSync(runtimeSlot),false);assert.deepEqual(fs.readdirSync(runtimeDir),[])}
      else checkEarlyRuntime(stage);
    };
    const warningStart = warnings.length;
    await handlers.get("session_start")({type:"session_start",reason:"fork"},ctx);
    assert.equal(phase,2); assertRuntimeIdentity(readRuntime()); assertNoRuntimeTemps();
    assert.equal(readRuntime().tty,failPhase===1?"fixture-tty":"");
    assert.ok(warnings.slice(warningStart).some(s=>s.includes("runtime reg ERR")&&s.includes(`fixture runtime rename failure ${failPhase}`)),"failed write must be explicitly diagnosed");
    assert.match(fs.readFileSync(path.join(root,"agent-logs","extension-diag.log"),"utf8"),new RegExp(`runtime reg ERR.*fixture runtime rename failure ${failPhase}`));
  }
  globalThis.__fixtureRuntimeRename = observeRename; globalThis.__fixtureRecoveryStage = checkEarlyRuntime;
  await handlers.get("session_shutdown")({type:"session_shutdown",reason:"quit"},ctx);
  assert.equal(fs.existsSync(runtimeSlot),false,"quit removes the runtime slot");
  console.log("OK: real extension early/atomic runtime registration, reload continuity, replacement cleanup, fail-closed recovery, queued delivery and unsafe prepare refusal via mock host/RMUX");
} finally {
  await handlers.get("session_shutdown")?.({type:"session_shutdown",reason:"quit"},ctx);
  console.warn = originalWarn;
  Date.now = originalNow;
  if(oldNotify===undefined)delete process.env.PI_AGENT_NOTIFY_DIR;else process.env.PI_AGENT_NOTIFY_DIR=oldNotify;
  if(oldTask===undefined)delete process.env.PI_SUBAGENT_TASK_ID;else process.env.PI_SUBAGENT_TASK_ID=oldTask;
  delete globalThis.__fixtureRmux;delete globalThis.__fixtureRuntimeRename;delete globalThis.__fixtureRecoveryStage;delete globalThis.__fixtureControllerOptions;
  fs.rmSync(root,{recursive:true,force:true});
}
