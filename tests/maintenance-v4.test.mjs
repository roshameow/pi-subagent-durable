// Disposable ledgers/registries and RMUX adapters ONLY; never contact live Pi.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { RecoveryController, atomicRecoveryWrite, taskRecordPath, readTaskRecords } from "../extensions/recovery-v4.mjs";
import { cleanupDeadWindowResult, cleanupDeadWindow } from "../extensions/dead-window-v4.mjs";
import { acquireControllerLease, releaseControllerLease, readControllerLeaseRegistry, CONTROLLER_LEASE_TTL_MS } from "../extensions/controller-lease.mjs";

function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "durable-maintenance-v4-")), controllers = [];
  const options = { ledgerDir: path.join(root, "ledger"), controllerRegistryPath: path.join(root, "controllers.json"),
    parentSessionId: "parent", parentSessionPath: path.join(root, "parent.jsonl"), pollMs: 10000000, heartbeatMs: 10000000,
    probe: async () => ({state: "dead", exitCode: 0}), deliver: async () => true, onCompleted: () => {}, ...extra };
  fs.writeFileSync(options.parentSessionPath, '{"type":"session","id":"parent"}\n');
  const record = (id = "task-legacy-aaaa", overrides = {}) => {
    const logPath = path.join(root, `${id}.jsonl`); fs.writeFileSync(logPath, '{"type":"agent_settled"}\n');
    return { version: 1, taskId: id, mode: "async-rmux", parentSessionId: "parent", parentSessionPath: options.parentSessionPath,
      logPath, sessionPath: path.join(root, "canonical.jsonl"), rmuxTarget: `pi-agents:worker-${id}.0`, requireRmuxIdentity: true,
      status: "completed", result: { resultId: `${id}:completion`, output: "full result retained", exitCode: 0 },
      deliveredAt: new Date().toISOString(), retirementState: "retired", cleanupState: "cleanup_pending", ...overrides };
  };
  let queries = 0, mutations = 0, rows;
  options.cleanup = async (r, fence, guard) => cleanupDeadWindowResult(async (...args) => {
    if (args[0] !== "list-panes") { mutations++; assert.fail("fixture unexpectedly attempted window mutation"); }
    queries++; return { returnCode: 0, stdout: rows === undefined ? `${r.rmuxTarget}|$2|%3|1` : rows };
  }, r, fence, guard);
  Object.assign(options, extra);
  const create = (overrides = {}) => { const c = new RecoveryController({...options, ...overrides}); controllers.push(c); return c; };
  const disk = r => readTaskRecords(options.ledgerDir).find(v => v.taskId === r.taskId);
  const lease = r => readControllerLeaseRegistry(options.controllerRegistryPath).leases[r.taskId];
  const write = r => atomicRecoveryWrite(taskRecordPath(options.ledgerDir, r.taskId), r);
  t.after(() => { controllers.forEach(c => c.close()); fs.rmSync(root, {recursive:true, force:true}); });
  return { root, options, create, record, disk, lease, write, counts: () => ({queries, mutations}), rows: value => {rows=value;} };
}
function faultRename(t, predicate) {
  const real = fs.renameSync;
  return t.mock.method(fs, "renameSync", (from, to) => {
    if (fs.statSync(from).isFile() && predicate(from, to, JSON.parse(fs.readFileSync(from, "utf8")))) throw Error("fixture durable write failure");
    return real(from, to);
  });
}

 test("22 legacy terminals park once; cold startup and idle loops do zero writes/fsync even with slow fsync", async t => {
  const f = fixture(t), records = Array.from({length:22}, (_, i) => f.record(`task-legacy-a${i}`));
  records.forEach(f.write); const c = f.create();
  const realRename = fs.renameSync, realSync = fs.fsyncSync; let ledgerWrites = 0, startupSyncs = 0;
  const startupSyncMock=t.mock.method(fs,"fsyncSync",fd=>{startupSyncs++;return realSync(fd);});
  const renames = t.mock.method(fs, "renameSync", (from, to) => { if (to.startsWith(f.options.ledgerDir)) ledgerWrites++; return realRename(from,to); });
  const report = await c.recover();
  assert.equal(ledgerWrites,22,"one truthful parking write per terminal, no intermediate false-save");
  assert.equal(report.filter(s=>s.includes("parked blocked_manual")).length,22);
  for (const r of records) {
    const saved = f.disk(r); assert.equal(saved.cleanupState,"blocked_manual"); assert.equal(saved.cleanupBlockCode,"missing_launch_identity");
    assert.deepEqual(saved.result,r.result); assert.equal(saved.deliveredAt,r.deliveredAt); assert.equal(saved.retirementState,"retired");
    assert.equal(saved.rmuxWindowId,undefined); assert.ok(f.lease(r).releasedAt); assert.ok(fs.existsSync(r.logPath));
  }
  assert.equal(c.leases.size,0); assert.equal(c.records.size,0); assert.deepEqual(f.counts(),{queries:22,mutations:0});
  assert.ok(startupSyncs>0,"parking/acquisition/release preserve real fsync barriers");
  startupSyncMock.mock.restore();c.close(); renames.mock.restore();
  const cold = f.create(); let syncs = 0, writes = 0;
  const syncMock = t.mock.method(fs,"fsyncSync", () => {syncs++; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,15);});
  const writeMock = t.mock.method(fs,"writeFileSync", () => {writes++; assert.fail("idle write");});
  assert.equal((await cold.recover()).filter(s=>s.includes("parked blocked_manual")).length,22);
  let pulse = false; setImmediate(()=>{pulse=true;}); const start=performance.now();
  for(let i=0;i<120;i++){await cold.tick();cold.heartbeat();}
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(pulse); assert.ok(performance.now()-start<150,"parked loop must not be slowed by injected synchronous fsync");
  assert.equal(syncs,0); assert.equal(writes,0); assert.deepEqual(f.counts(),{queries:22,mutations:0});
  syncMock.mock.restore(); writeMock.mock.restore();
  console.log(`OK: 22 legacy startup ledger writes=${ledgerWrites}, startup fsync=${startupSyncs}; parked cold startup/120 idle ticks+heartbeats writes=${writes}, fsync=${syncs}`);
});

 test("explicit refusal requires successful exact all-dead snapshot, not missing metadata alone", async () => {
  const r={taskId:"task-fixture-aaaa",rmuxTarget:"pi-agents:worker-task-fixture-aaaa.0",requireRmuxIdentity:true};
  const command = stdout => async () => ({returnCode:0,stdout});
  const dead=`${r.rmuxTarget}|$2|%3|1`;
  assert.equal((await cleanupDeadWindowResult(command(dead),r)).code,"missing_launch_identity");
  assert.equal(await cleanupDeadWindow(command(dead),r),false,"compatibility must not treat object as success");
  for(const rows of [dead.replace(/1$/,"0"),dead+`\n${r.rmuxTarget.replace(/\.0$/,".1")}|$2|%4|0`,`${r.rmuxTarget.replace(/\.0$/,".1")}|$2|%4|0`])
    assert.equal((await cleanupDeadWindowResult(command(rows),r)).state,"retry");
  assert.equal((await cleanupDeadWindowResult(command(""),r)).state,"cleaned");
  await assert.rejects(cleanupDeadWindowResult(async()=>({returnCode:1}),r),/query failed/);
  await assert.rejects(cleanupDeadWindowResult(command("bad row"),r),/unrecognized/);
  await assert.rejects(cleanupDeadWindowResult(command(dead+"\n"+dead.replace("$2","$99").replace("%3","%99")),r),/ambiguous/);
  assert.equal(r.rmuxWindowId,undefined);
});

 test("pending ACK and retrying retirement retain leases; park only after both durable barriers", async t => {
  let ack=false, retirementFault=true, retirementCalls=0;
  const f=fixture(t,{deliver:async()=>ack,onCompleted:()=>{retirementCalls++;if(retirementFault)throw Error("retirement fault");}});
  const r=f.record(undefined,{deliveredAt:undefined,retirementState:"retirement_pending"}),c=f.create();c.track(r);
  await c.tick();assert.equal(f.disk(r).cleanupState,"cleanup_pending");assert.equal(f.disk(r).deliveredAt,undefined);assert.equal(f.lease(r).releasedAt,undefined);
  const queries=f.counts().queries;c.heartbeat();await c.tick();assert.equal(f.counts().queries,queries,"cleanup is backed off without gating ACK checks");
  ack=true;await c.tick();assert.ok(f.disk(r).deliveredAt);assert.equal(f.disk(r).retirementState,"retirement_pending");assert.equal(f.lease(r).releasedAt,undefined);
  retirementFault=false;await c.tick();assert.equal(f.disk(r).cleanupState,"blocked_manual");assert.equal(f.disk(r).retirementState,"retired");assert.equal(retirementCalls,2);assert.ok(f.lease(r).releasedAt);
});

 test("failed durable park retries without losing receipt or authority", async t => {
  const f=fixture(t),r=f.record(),c=f.create();c.track(r);let now=Date.now();t.mock.method(Date,"now",()=>now);
  const rename=faultRename(t,(_from,to,value)=>to===taskRecordPath(f.options.ledgerDir,r.taskId)&&value.cleanupState==="blocked_manual");
  await c.tick();assert.equal(f.disk(r).cleanupState,"cleanup_pending");assert.equal(c.records.get(r.taskId).cleanupState,"cleanup_pending");
  assert.equal(f.lease(r).releasedAt,undefined);assert.ok(c.leases.has(r.taskId));assert.deepEqual(f.disk(r).result,r.result);
  rename.mock.restore();now+=300001;await c.tick();assert.equal(f.disk(r).cleanupState,"blocked_manual");assert.ok(f.lease(r).releasedAt);
});

 test("post-rename park fsync failure cannot be promoted to durable parking by explicit recover", async t => {
  const f=fixture(t),r=f.record(),c=f.create();c.track(r);let fail=true,afterParkRename=false;
  const rename=fs.renameSync,sync=fs.fsyncSync;
  const rm=t.mock.method(fs,"renameSync",(from,to)=>{
    const isPark=to===taskRecordPath(f.options.ledgerDir,r.taskId)&&JSON.parse(fs.readFileSync(from,"utf8")).cleanupState==="blocked_manual";
    const result=rename(from,to);if(isPark)afterParkRename=true;return result;
  });
  const sm=t.mock.method(fs,"fsyncSync",fd=>{
    if(afterParkRename&&fs.fstatSync(fd).isDirectory()){afterParkRename=false;if(fail)throw Error("park dir fsync failure");}
    return sync(fd);
  });
  await c.tick();assert.equal(f.disk(r).cleanupState,"blocked_manual","rename made non-durable bytes visible");
  assert.equal(c.records.get(r.taskId).cleanupState,"cleanup_pending");assert.equal(f.lease(r).releasedAt,undefined);
  await c.recover();assert.equal(c.records.get(r.taskId).cleanupState,"cleanup_pending");assert.equal(f.lease(r).releasedAt,undefined,"explicit recover must retry save, not ACK visible bytes");
  fail=false;await c.recover();assert.equal(f.disk(r).cleanupState,"blocked_manual");assert.ok(f.lease(r).releasedAt);
  rm.mock.restore();sm.mock.restore();
});

 test("failed release and uncertain post-rename fsync release keep retry credentials", async t => {
  const f=fixture(t);let now=Date.now();t.mock.method(Date,"now",()=>now);
  for(const [i,phase] of ["rename","dirsync"].entries()) {
    const r=f.record(`task-release-a${i}`),c=f.create();c.track(r);
    let fail=true,afterReleaseRename=false;
    const rename=fs.renameSync, sync=fs.fsyncSync;
    const rm=t.mock.method(fs,"renameSync",(from,to)=>{
      if(to===f.options.controllerRegistryPath&&JSON.parse(fs.readFileSync(from,"utf8")).leases[r.taskId]?.releasedAt){
        if(fail&&phase==="rename")throw Error("release failure");
        const result=rename(from,to);afterReleaseRename=true;return result;
      }return rename(from,to);
    });
    const sm=t.mock.method(fs,"fsyncSync",fd=>{if(fail&&phase==="dirsync"&&afterReleaseRename&&fs.fstatSync(fd).isDirectory())throw Error("release dir fsync failure");return sync(fd);});
    await c.tick();assert.equal(f.disk(r).cleanupState,"blocked_manual");assert.ok(c.leases.has(r.taskId));assert.ok(c.records.has(r.taskId));
    c.heartbeat();assert.equal(c.quarantined.has(r.taskId),false,"uncertain releasedAt must not quarantine/drop retries");
    fail=false;now+=300001;await c.tick();assert.equal(c.leases.has(r.taskId),false);assert.ok(f.lease(r).releasedAt);
    rm.mock.restore();sm.mock.restore();
  }
});

 test("cold startup retries a parked receipt with an unreleased lease", async t => {
  const f=fixture(t),r=f.record(),c=f.create();c.track(r);
  const rm=faultRename(t,(_from,to,value)=>to===f.options.controllerRegistryPath&&value.leases[r.taskId]?.releasedAt);
  await c.tick();c.close();assert.equal(f.lease(r).releasedAt,undefined);rm.mock.restore();
  // An inactive epoch can be reclaimed; a live/fresh different token cannot.
  const conflicted=f.create();assert.match((await conflicted.recover()).join("\n"),/mismatch/);
  assert.equal(conflicted.leases.size,0,"fresh foreign token is never reclaimed for release");
  let now=Date.now()+CONTROLLER_LEASE_TTL_MS;t.mock.method(Date,"now",()=>now);
  const cold=f.create();const report=await cold.recover();assert.match(report.join("\n"),/parked blocked_manual/);assert.ok(f.lease(r).releasedAt);assert.equal(cold.leases.size,0);
  assert.deepEqual(f.disk(r).result,r.result);
});

 test("cold parked save revalidation failure retains a bounded retry and never releases before fsync", async t => {
  const f=fixture(t),r=f.record(),old=f.create();old.track(r);
  const releaseFault=faultRename(t,(_from,to,value)=>to===f.options.controllerRegistryPath&&value.leases[r.taskId]?.releasedAt);
  await old.tick();old.close();releaseFault.mock.restore();
  let now=Date.now()+CONTROLLER_LEASE_TTL_MS;t.mock.method(Date,"now",()=>now);
  const saveFault=faultRename(t,(_from,to,value)=>to===taskRecordPath(f.options.ledgerDir,r.taskId)&&value.cleanupState==="blocked_manual");
  const cold=f.create();await cold.recover();assert.ok(cold.leases.has(r.taskId));assert.ok(cold.records.has(r.taskId));assert.ok(cold.failedSaves.has(r.taskId));
  assert.equal(f.lease(r).releasedAt,undefined);await cold.tick();assert.equal(f.lease(r).releasedAt,undefined);
  await cold.recover();assert.equal(f.lease(r).releasedAt,undefined,"explicit recovery cannot skip failed cold durability revalidation");
  saveFault.mock.restore();now+=300001;await cold.tick();assert.ok(f.lease(r).releasedAt);assert.equal(cold.records.size,0);
});

 test("transient/unknown/boolean false retries 30..300s with no unchanged ledger saves or 2s fences", async t => {
  for(const kind of ["false","error","undefined"]) {
    let calls=0;const f=fixture(t,{cleanup:async()=>{calls++;if(kind==="error")throw Error("network unavailable");return kind==="false"?false:undefined;}});
    const r=f.record(`task-transient-${kind}`),c=f.create();c.track(r);let now=Date.now();const clock=t.mock.method(Date,"now",()=>now);
    await c.tick();assert.equal(f.disk(r).cleanupState,"cleanup_pending");assert.equal(f.lease(r).releasedAt,undefined);
    let ledgerWrites=0, syncs=0;const rename=fs.renameSync,sync=fs.fsyncSync;
    const rm=t.mock.method(fs,"renameSync",(from,to)=>{if(to===taskRecordPath(f.options.ledgerDir,r.taskId))ledgerWrites++;return rename(from,to);});
    const sm=t.mock.method(fs,"fsyncSync",fd=>{syncs++;return sync(fd);});
    for(let i=0;i<14;i++){now+=2000;await c.tick();}assert.equal(calls,1);assert.equal(syncs,0,"before due no authority-lock fsyncs");
    now+=2000;await c.tick();assert.equal(calls,2);assert.equal(c.cleanupRetries.get(r.taskId).delay,60000);
    for(const delay of [120000,240000,300000,300000]){now=c.cleanupRetries.get(r.taskId).due;await c.tick();assert.equal(c.cleanupRetries.get(r.taskId).delay,delay);}
    assert.equal(ledgerWrites,0);assert.equal(f.disk(r).cleanupState,"cleanup_pending");assert.ok(c.leases.has(r.taskId));
    rm.mock.restore();sm.mock.restore();clock.mock.restore();
  }
});

 test("ACK/retirement save failures cannot become in-memory receipts that bypass durable save", async t => {
  for(const barrier of ["ack","retired"]) {
    let retirementCalls=0,ackCalls=0;const f=fixture(t,{acknowledge:()=>ackCalls++,onCompleted:()=>retirementCalls++});
    const r=f.record(`task-barrier-${barrier}`,{deliveredAt:undefined,retirementState:"retirement_pending"}),c=f.create();c.track(r);
    const rm=faultRename(t,(_from,to,value)=>to===taskRecordPath(f.options.ledgerDir,r.taskId)&&(barrier==="ack"?Boolean(value.deliveredAt):value.retirementState==="retired"));
    await c.tick();assert.equal(f.lease(r).releasedAt,undefined);assert.equal(f.disk(r).cleanupState,"cleanup_pending");
    if(barrier==="ack"){assert.equal(f.disk(r).deliveredAt,undefined);assert.equal(c.records.get(r.taskId).deliveredAt,undefined);assert.equal(retirementCalls,0);}
    else {assert.ok(f.disk(r).deliveredAt);assert.equal(c.records.get(r.taskId).retirementState,"retirement_pending");}
    rm.mock.restore();await c.tick();assert.equal(f.disk(r).cleanupState,"blocked_manual");assert.ok(f.lease(r).releasedAt);
    assert.equal(barrier==="ack"?ackCalls:retirementCalls,2);
  }
});

 test("manual fenced retry never infers identity; supports authoritative absence and preserves foreign/live wait", async t => {
  const f=fixture(t),r=f.record(),c=f.create();c.track(r);await c.tick();const epoch=f.lease(r).generation;
  assert.equal(await c.retryCleanup(r.taskId),false);assert.equal(f.disk(r).rmuxWindowId,undefined);assert.equal(f.lease(r).generation,epoch+1);assert.ok(f.lease(r).releasedAt);
  const other=f.create({parentSessionId:"foreign"});await assert.rejects(other.retryCleanup(r.taskId),/another parent/);
  f.rows("");assert.equal(await c.retryCleanup(r.taskId),true);assert.equal(f.disk(r).cleanupState,"cleaned");assert.deepEqual(f.disk(r).result,r.result);
  const live=f.record("task-live-aaaa",{status:"running",result:undefined,deliveredAt:undefined,retirementState:undefined,cleanupState:undefined});
  const waitPath=path.join(f.root,"armed-wait.json");fs.writeFileSync(waitPath,JSON.stringify({runId:"run-exact",nonce:randomUUID(),workerPid:process.pid,armedWait:true}));const waitBefore=fs.readFileSync(waitPath,"utf8");
  const worker=f.create({probe:async()=>({state:"live"})});worker.track(live);const leaseBefore=f.lease(live);
  for(let i=0;i<4;i++){await worker.tick();worker.heartbeat();}
  assert.equal(f.disk(live).status,"running");assert.equal(f.disk(live).result,undefined);assert.equal(f.lease(live).releasedAt,undefined);
  for(const key of ["generation","ownerPid","controllerToken","parentSessionId"])assert.equal(f.lease(live)[key],leaseBefore[key]);
  assert.equal(fs.readFileSync(waitPath,"utf8"),waitBefore);
});

 test("takeover during cleanup fences stale parking/release; exact epoch remains untouched", async t => {
  const f=fixture(t),r=f.record(),c=f.create();c.track(r);const old=f.lease(r);let next;
  c.options.cleanup=async()=>{
    releaseControllerLease(f.options.controllerRegistryPath,old);
    next=acquireControllerLease(f.options.controllerRegistryPath,{taskId:r.taskId,parentSessionId:r.parentSessionId,ownerPid:process.pid,controllerToken:randomUUID()});
    return {state:"blocked_manual",code:"missing_launch_identity",reason:"confirmed fixture refusal"};
  };
  const before=f.disk(r);await c.tick();assert.equal(c.quarantined.has(r.taskId),true);assert.deepEqual(f.disk(r),before);assert.deepEqual(f.lease(r),next);
  c.heartbeat();await c.tick();c.close();assert.deepEqual(f.lease(r),next);
});

 test("new native ESM paths bypass warmed old recovery/dead-window modules without reload", () => {
  const output=execFileSync(process.execPath,["--input-type=module","-e",`
    import assert from 'node:assert/strict';
    const old=await import(${JSON.stringify(new URL('../extensions/recovery-v3.mjs',import.meta.url).href)});
    const oldDead=await import(${JSON.stringify(new URL('../extensions/dead-window-v3.mjs',import.meta.url).href)});
    const fresh=await import(${JSON.stringify(new URL('../extensions/recovery-v4.mjs',import.meta.url).href)});
    const freshDead=await import(${JSON.stringify(new URL('../extensions/dead-window-v4.mjs',import.meta.url).href)});
    assert.notEqual(old.RecoveryController,fresh.RecoveryController);
    assert.notEqual(oldDead.cleanupDeadWindow,freshDead.cleanupDeadWindow);
    assert.equal(typeof fresh.RecoveryController.prototype.retryCleanup,'function');
    assert.equal(typeof freshDead.cleanupDeadWindowResult,'function');
    console.log('versioned paths verified');
  `],{encoding:"utf8",timeout:5000});assert.match(output,/versioned paths verified/);
});
