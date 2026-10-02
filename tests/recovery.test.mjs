import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { RecoveryController, atomicRecoveryWrite, taskRecordPath, readTaskRecords, probeRmuxTask } from "../extensions/recovery.mjs";
import { startReceiverKeeper, mirrorReceiverHeartbeats } from "../extensions/receiver-keeper.mjs";
import { acquireControllerLease, releaseControllerLease, readControllerLeaseRegistry } from "../extensions/controller-lease.mjs";
import { prepareUpgrade } from "../extensions/upgrade-handoff.mjs";
import { registerWorkerOwnership, readWorkerOwnershipRegistry } from "../extensions/ownership-registry.mjs";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "durable-recovery-test-")));
const children = [];
const keeperPids = [];
const ledgerDir = path.join(root, "durable-tasks");
const controllerRegistryPath = path.join(root, "controllers.json");
const parentSessionId = "parent-a", parentSessionPath = path.join(root, "parent.jsonl");
fs.writeFileSync(parentSessionPath, JSON.stringify({ type: "session", id: parentSessionId, cwd: root }) + "\n");
const base = { ledgerDir, controllerRegistryPath, parentSessionId, parentSessionPath, pollMs: 60000 };
const deliveries = [], errors = [];
const options = { ...base, probe: async () => ({ state: "live" }), deliver: async r => deliveries.push(r.result.resultId), onError: e => errors.push(e.message) };
let controllers = [];
const create = overrides => { const c = new RecoveryController({ ...options, ...overrides }); controllers.push(c); return c; };
function record(taskId, parent = parentSessionId) {
  const logPath = path.join(root, `${taskId}.jsonl`);
  fs.writeFileSync(logPath, JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "fixture done" }], stopReason: "stop" } }) + '\n{"type":"agent_settled"}\n');
  return { version: 1, taskId, mode: "async-rmux", parentSessionId: parent, parentSessionPath,
    agent: "fixture", task: "fixture", cwd: root, rmuxTarget: `pi-agents:fixture-${taskId}.0`, logPath, status: "running" };
}
async function subprocess(code, env = {}) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child); let stderr = ""; child.stderr.on("data", d => stderr += d);
  const output = await new Promise((resolve, reject) => {
    child.on("error", reject); child.stdout.once("data", d => resolve(String(d))); child.once("exit", code => code && reject(new Error(stderr)));
  });
  return { child, output };
}
try {
  // A separate controller process exits abruptly, not a simulated global Map reset.
  const r = record("task-cold-aaaa");
  const module = pathToFileURL(path.resolve("extensions/recovery.mjs")).href;
  const boot = await subprocess(`import {RecoveryController} from ${JSON.stringify(module)}; const c=new RecoveryController(${JSON.stringify(base)}); c.track(${JSON.stringify(r)}); console.log('tracked'); process.exit(0);`);
  await new Promise(resolve => boot.child.exitCode !== null ? resolve() : boot.child.once("exit", resolve));
  const restarted = create(); await restarted.recover();
  assert.ok(restarted.records.has(r.taskId), "cold main reclaims dead controller without a worker restart");
  const duplicate = create(); const report = await duplicate.recover();
  assert.match(report.join("\n"), /mismatch/); assert.equal(duplicate.records.size, 0);
  const other = create({ parentSessionId: "parent-other" }); await other.recover();
  assert.equal(other.records.size, 0); assert.equal(deliveries.length, 0);
  restarted.close();

  // Offline completion is recovered from disk and persistent marker deduplicates retry.
  const completed = create({ probe: async () => ({ state: "dead", exitCode: 0 }) }); await completed.recover();
  assert.deepEqual(deliveries, [`${r.taskId}:completion`]);
  assert.ok(readTaskRecords(ledgerDir, parentSessionId)[0].deliveredAt);
  completed.close(); const again = create({ probe: async () => ({ state: "dead" }) }); await again.recover();
  assert.equal(deliveries.length, 1);

  const unknownRecord = record("task-unknown-bbbb"); const unknown = create({ probe: async () => ({ state: "unknown" }) });
  unknown.track(unknownRecord); await unknown.tick();
  assert.equal(unknown.records.get(unknownRecord.taskId).result, undefined); assert.equal(deliveries.length, 1); unknown.close();
  assert.equal((await probeRmuxTask(async () => { throw Error("connection failure"); }, r)).state, "unknown");
  assert.equal((await probeRmuxTask(async () => ({ returnCode: 1 }), r)).state, "unknown");
  assert.equal((await probeRmuxTask(async () => ({ returnCode: 0, stdout: "malformed" }), r)).state, "unknown");
  assert.equal((await probeRmuxTask(async () => ({ returnCode: 0, stdout: "pi-agents:base.0|0|" }), r)).state, "dead");

  // Delivery interrupted after publication replays unless parent has its durable ack.
  const ackRecord = record("task-ack-cccc");
  const crashed = create({ probe: async () => ({ state: "dead" }), deliver: async () => { throw Error("fixture crash before ack"); } });
  crashed.track(ackRecord); await crashed.tick(); assert.ok(readTaskRecords(ledgerDir, parentSessionId).find(x => x.taskId === ackRecord.taskId).result); crashed.close();
  const acked = create({ probe: async () => ({ state: "dead" }), isAcknowledged: id => id === `${ackRecord.taskId}:completion` }); await acked.recover();
  // unknown task remains unknown for this test, ack task is not delivered again.
  assert.ok(!deliveries.includes(`${ackRecord.taskId}:completion`)); acked.close();

  // Fencing is rechecked after asynchronous liveness: a closed old controller cannot deliver.
  const fencedRecord = record("task-fenced-dddd"); let resolveProbe;
  const fenced = create({ probe: () => new Promise(resolve => { resolveProbe = resolve; }) }); fenced.track(fencedRecord);
  const tick = fenced.tick(); fenced.close(); resolveProbe({ state: "dead" }); await tick;
  assert.ok(!deliveries.includes(`${fencedRecord.taskId}:completion`));

  // Prepare existing receiver without modifying its runId, nonce or wait lease.
  const notifyDir = path.join(root, "notify"), registryPath = path.join(notifyDir, ".active-workers.json");
  const logDir = path.join(root, "logs"), sessionsRoot = path.join(root, "sessions");
  fs.mkdirSync(logDir); fs.mkdirSync(path.join(sessionsRoot, "project"), { recursive: true });
  const live = await subprocess(`console.log(process.pid); setInterval(()=>{},1000);`);
  const workerPid = Number(live.output.trim()), taskId = "task-prepare-eeee";
  const identityDir = path.join(notifyDir, taskId); fs.mkdirSync(identityDir, { recursive: true });
  const identity = { version: 2, taskId, targetId: taskId, pid: workerPid, cwd: root, runId: "original-run", nonce: "original-nonce", itemKeys: [`worker:${taskId}`, "ci:fixture"], heartbeatAt: new Date().toISOString() };
  const identityPath = path.join(identityDir, ".receiver-identity.json"); fs.writeFileSync(identityPath, JSON.stringify(identity));
  const waitPath = path.join(identityDir, ".notification-wait-lease"); fs.writeFileSync(waitPath, "original lease bytes");
  registerWorkerOwnership(registryPath, { taskId, ownerPid: process.pid, ownerToken: "original-token", cwd: root, itemKeys: identity.itemKeys });
  const childId = "child-fixture";
  fs.writeFileSync(path.join(sessionsRoot, "project", `real_${childId}.jsonl`), JSON.stringify({ type: "session", id: childId }) + "\n");
  fs.writeFileSync(path.join(logDir, `${taskId}.jsonl`), [
    { type: "pi_subagent_task", taskId, agent: "fixture", task: "itemKey=ci:fixture", cwd: root },
    { type: "pi_subagent_parent", parentId: parentSessionId, parentSessionPath },
    { type: "session", id: childId },
  ].map(JSON.stringify).join("\n") + "\n");
  const prepOptions = { ...base, logDir, sessionsRoot, notifyDir, registryPath, cwd: root, expectedOwnerPid: process.pid,
    probe: async () => ({ state: "live", rmuxTarget: `pi-agents:fixture-${taskId}.0` }) };
  const prep = await prepareUpgrade(prepOptions); assert.match(prep.command, /pi --session/);
  const reservation = readWorkerOwnershipRegistry(registryPath).workers[taskId];
  assert.equal(reservation.ownerPid, workerPid); assert.equal(reservation.ownerToken, "original-token"); assert.equal(reservation.ownershipMode, "receiver");
  assert.deepEqual(JSON.parse(fs.readFileSync(identityPath)), identity); assert.equal(fs.readFileSync(waitPath, "utf8"), "original lease bytes");
  // Compatibility for old notify readers: a bounded keeper mirrors fresh
  // receiver timestamps; it never refreshes a stale identity or changes tokens.
  let oldRegistry = readWorkerOwnershipRegistry(registryPath);
  oldRegistry.workers[taskId].heartbeatAt = new Date(Date.now()-180000).toISOString();
  fs.writeFileSync(registryPath, JSON.stringify(oldRegistry));
  assert.equal(mirrorReceiverHeartbeats(ledgerDir, registryPath), 1);
  assert.equal(readWorkerOwnershipRegistry(registryPath).workers[taskId].heartbeatAt, identity.heartbeatAt);
  const keeper = await startReceiverKeeper({ ledgerDir, registryPath, seconds: 30 }); keeperPids.push(keeper.pid);
  const sameKeeper = await startReceiverKeeper({ ledgerDir, registryPath, seconds: 30 }); keeperPids.push(sameKeeper.pid);
  assert.notEqual(sameKeeper.pid, keeper.pid, "each preparation gets a fresh process/nonce handshake, not PID-only reuse");
  assert.notEqual(sameKeeper.nonce, keeper.nonce);
  assert.equal(readWorkerOwnershipRegistry(registryPath).workers[taskId].ownerToken, "original-token");
  // The legacy bootstrap path loads no Pi runtime and refuses sync/fallback.
  const bin = path.join(root, "bin");fs.mkdirSync(bin);
  const rmux = path.join(bin, "rmux");fs.writeFileSync(rmux, `#!/bin/sh\nprintf 'pi-agents|fixture-${taskId}|0\\n'\n`, {mode:0o700});
  fs.mkdirSync(path.join(root,"runtime"));fs.writeFileSync(path.join(root,"runtime",`${process.pid}.jsonl`),JSON.stringify({type:"pi_runtime",pid:process.pid,sessionPath:parentSessionPath}));
  // bootstrap expects the conventional log/session directories; both are fixture-only.
  fs.mkdirSync(path.join(notifyDir,".main-sessions"),{recursive:true});
  fs.writeFileSync(path.join(notifyDir,".main-sessions",`${parentSessionId}.json`),JSON.stringify({version:2,targetKind:"main",targetId:parentSessionId,sessionId:parentSessionId,pid:process.pid,cwd:root,sessionFile:parentSessionPath,runId:"run-bootstrap-main",nonce:"0123456789abcdef0123456789abcdef",heartbeatAt:new Date().toISOString()}));
  fs.cpSync(logDir,path.join(root,"agent-logs"),{recursive:true});
  const bootstrap = execFileSync(process.execPath,["scripts/prepare-upgrade.mjs","--session",parentSessionPath],{
    env:{...process.env,PI_CODING_AGENT_DIR:root,PI_AGENT_NOTIFY_DIR:notifyDir,PI_AGENT_NOTIFY_STATE_DIR:path.join(root,"notify-state"),PATH:`${bin}:${process.env.PATH}`},encoding:"utf8"});
  assert.match(bootstrap,/No worker was signaled or restarted/);assert.match(bootstrap,/pi --session/);
  assert.match(bootstrap,/Preserved exact main notification identity/);
  const mainIdentityDir=path.join(root,"notify-state","main-identities");
  const importedIdentity=JSON.parse(fs.readFileSync(path.join(mainIdentityDir,fs.readdirSync(mainIdentityDir)[0]),"utf8"));
  assert.equal(importedIdentity.runId,"run-bootstrap-main");assert.equal(importedIdentity.nonce,"0123456789abcdef0123456789abcdef");
  const oldLease = readControllerLeaseRegistry(path.join(ledgerDir,".controllers.json")).leases[taskId];
  const ledgerBefore = fs.readFileSync(taskRecordPath(ledgerDir,taskId),"utf8");
  const registryBefore = fs.readFileSync(registryPath,"utf8");
  await assert.rejects(prepareUpgrade({ ...prepOptions, authorizeTask: () => {
    releaseControllerLease(path.join(ledgerDir,".controllers.json"),oldLease);
    acquireControllerLease(path.join(ledgerDir,".controllers.json"),{taskId,parentSessionId,ownerPid:process.pid});
    return oldLease;
  } }),/mismatch/);
  assert.equal(fs.readFileSync(taskRecordPath(ledgerDir,taskId),"utf8"),ledgerBefore,"stale prepare cannot publish ledger");
  assert.equal(fs.readFileSync(registryPath,"utf8"),registryBefore,"stale prepare cannot migrate ownership");
  const readyManifest=JSON.parse(fs.readFileSync(path.join(root,"agent-upgrades",`${parentSessionId}.json`)));assert.equal(readyManifest.ready,false,"failed prepare invalidates ready manifest");
  // A required legacy candidate that dies before a ledger exists must refuse
  // exit, not silently disappear into historical logs.
  const noLedger=path.join(root,"empty-ledger");
  await assert.rejects(prepareUpgrade({...prepOptions,ledgerDir:noLedger,requiredTaskIds:[taskId],probe:async()=>({state:"dead"})}),/known task completed/);
  await assert.rejects(prepareUpgrade({ ...prepOptions, probe: async () => ({ state: "unknown" }) }), /unknown/);
  await assert.rejects(prepareUpgrade({ ...prepOptions, probe: async () => ({ state: "live" }) }), /fallback\/sync/);
  console.log("OK: subprocess cold recovery, offline outbox, duplicate/foreign controllers, fencing, unknown RMUX, and token-preserving prepare");
} finally {
  controllers.forEach(c => c.close());
  try { keeperPids.push(JSON.parse(fs.readFileSync(path.join(ledgerDir,".receiver-keeper.json"),"utf8")).pid); } catch {}
  for (const pid of new Set(keeperPids)) { try { process.kill(pid); } catch {} }
  for (const child of children) { if (child.exitCode === null) { child.kill(); await new Promise(resolve => child.once("exit", resolve)); } }
  fs.rmSync(root, { recursive: true, force: true });
}
