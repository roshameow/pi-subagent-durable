// Reproduce: node tests/recovery-expiry.test.mjs
// Verified pitfalls: TTL renewal cannot revive an epoch; Promise.race alone
// stacks hung probes; a probe's busy flag must never gate controller heartbeats;
// shutdown must authenticate each release and continue after stale credentials.
// All registry/ledger/worker fixtures are disposable. No Pi/RMUX is contacted.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import * as v2 from "../extensions/recovery-v2.mjs";
import * as shim from "../extensions/recovery.mjs";
import {
  acquireControllerLease, releaseControllerLease, assertControllerLease,
  readControllerLeaseRegistry, CONTROLLER_LEASE_TTL_MS as TTL,
} from "../extensions/controller-lease.mjs";

const baseTime = 1700000000000;
const leaseUrl = new URL("../extensions/controller-lease.mjs", import.meta.url).href;
const recoveryUrl = new URL("../extensions/recovery-v2.mjs", import.meta.url).href;
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-recovery-expiry-"));
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: baseTime });
  const errors = [], unknown = [], deliveries = [], lives = [], controllers = [];
  const options = {
    ledgerDir: path.join(dir, "ledger"), controllerRegistryPath: path.join(dir, "controllers.json"),
    parentSessionId: "parent-exact", parentSessionPath: path.join(dir, "parent.jsonl"),
    pollMs: 10000000, heartbeatMs: 15000, probeTimeoutMs: 40,
    probe: async () => ({ state: "live" }), deliver: async record => deliveries.push(record.taskId),
    onError: (error, record) => errors.push({ code: error.code, taskId: record?.taskId }),
    onUnknown: (record, live) => unknown.push({ taskId: record.taskId, ...live }),
    onLive: record => lives.push(record.taskId), ...overrides,
  };
  const create = extra => { const c = new v2.RecoveryController({ ...options, ...extra }); controllers.push(c); return c; };
  const c = create();
  const record = (taskId = "task-expiry-aaaa") => {
    const logPath = path.join(dir, `${taskId}.jsonl`);
    fs.writeFileSync(logPath, '{"type":"agent_settled"}\n');
    return { version: 1, taskId, mode: "async-rmux", parentSessionId: options.parentSessionId,
      parentSessionPath: options.parentSessionPath, status: "running", logPath, rmuxTarget: `fixture:${taskId}.0` };
  };
  const read = taskId => readControllerLeaseRegistry(options.controllerRegistryPath).leases[taskId];
  const disk = r => fs.readFileSync(v2.taskRecordPath(options.ledgerDir, r.taskId), "utf8");
  t.after(() => {
    controllers.forEach(controller => controller.close());
    t.mock.timers.reset();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, options, c, create, record, read, disk, errors, unknown, deliveries, lives };
}
function pauseHeartbeat(c) {
  clearInterval(c.heartbeatTimer); c.heartbeatTimer = null;
}
function successor(f, r, overrides = {}) {
  return acquireControllerLease(f.options.controllerRegistryPath, {
    taskId: r.taskId, parentSessionId: r.parentSessionId, ownerPid: process.pid,
    controllerToken: randomUUID(), ...overrides,
  });
}

test("compatibility exports and direct v2 import bypass a cached old class (isolated Node)", t => {
  const f = fixture(t);
  assert.deepEqual(Object.keys(shim), Object.keys(v2));
  for (const key of Object.keys(v2)) assert.equal(shim[key], v2[key]);
  const cachedPath = path.join(f.dir, "old-recovery.mjs");
  const oldUrl = pathToFileURL(cachedPath).href;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict'; import fs from 'node:fs';
    fs.writeFileSync(${JSON.stringify(cachedPath)}, 'export class RecoveryController { old = true; }');
    const old = await import(${JSON.stringify(oldUrl)});
    fs.writeFileSync(${JSON.stringify(cachedPath)}, 'export * from ${JSON.stringify(recoveryUrl)};');
    assert.equal((await import(${JSON.stringify(oldUrl)})).RecoveryController, old.RecoveryController);
    const fresh = await import(${JSON.stringify(recoveryUrl)});
    assert.notEqual(fresh.RecoveryController, old.RecoveryController);
    assert.equal(typeof fresh.RecoveryController.prototype.heartbeat, 'function');
    console.log('cache bypass verified');
  `], { encoding: "utf8", timeout: 5000 });
  assert.match(output, /cache bypass verified/);
});

test("authenticated expiry acquires a new epoch; old heartbeat is never revived", async t => {
  const f = fixture(t), r = f.record(); f.c.track(r);
  const old = f.read(r.taskId), before = f.disk(r);
  pauseHeartbeat(f.c); t.mock.timers.tick(TTL);
  assert.throws(() => assertControllerLease(f.options.controllerRegistryPath, old), { code: "LEASE_EXPIRED" });
  await f.c.tick();
  const renewed = f.read(r.taskId);
  assert.equal(renewed.generation, old.generation + 1);
  for (const key of ["ownerPid", "parentSessionId", "controllerToken"]) assert.equal(renewed[key], old[key]);
  assert.equal(renewed.heartbeatAt, new Date(baseTime + TTL).toISOString());
  assert.deepEqual(f.c.leases.get(r.taskId), renewed);
  assert.throws(() => assertControllerLease(f.options.controllerRegistryPath, old), { code: "GENERATION_MISMATCH" });
  assert.equal(f.disk(r), before); assert.equal(f.deliveries.length, 0); assert.equal(f.errors.length, 0);
  // Expiry is also handled independently of tick, for callback-only leases.
  const callback = f.record("task-callback-bbbb");
  f.c.options.skipExistingCallback = () => true;
  f.c.retainCallback(callback); pauseHeartbeat(f.c);
  const epoch = f.read(callback.taskId).generation;
  t.mock.timers.tick(TTL); f.c.heartbeat();
  assert.equal(f.read(callback.taskId).generation, epoch + 1);
  assert.equal(f.c.records.has(callback.taskId), false, "no second completion monitor");
});

test("a subprocess takeover fences even expired/dead successors; quarantine reports once and preserves disk", async t => {
  const f = fixture(t), r = f.record(); f.c.track(r);
  const old = f.c.leases.get(r.taskId), before = f.disk(r);
  const worker = path.join(f.dir, "worker-lease.json");
  fs.writeFileSync(worker, '{"runId":"original","nonce":"original","workerLease":"unchanged"}');
  const workerBefore = fs.readFileSync(worker, "utf8");
  pauseHeartbeat(f.c); t.mock.timers.tick(TTL);
  const next = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
    import {acquireControllerLease} from ${JSON.stringify(leaseUrl)};
    console.log(JSON.stringify(acquireControllerLease(${JSON.stringify(f.options.controllerRegistryPath)}, {
      taskId: ${JSON.stringify(r.taskId)}, parentSessionId: ${JSON.stringify(r.parentSessionId)}, ownerPid: process.pid,
      controllerToken: ${JSON.stringify(randomUUID())}
    }, {nowMs: ${Date.now()}})));
  `], { encoding: "utf8", timeout: 5000 }));
  assert.equal(next.generation, old.generation + 1);
  t.mock.timers.tick(TTL); // stale acquire without old generation would now steal
  const registryBefore = fs.readFileSync(f.options.controllerRegistryPath, "utf8");
  for (let i = 0; i < 5; i++) { await f.c.tick(); f.c.heartbeat(); }
  assert.equal(f.c.quarantined.has(r.taskId), true);
  assert.deepEqual(f.errors, [{ code: "GENERATION_MISMATCH", taskId: r.taskId }]);
  assert.equal(f.lives.length, 0); assert.equal(f.deliveries.length, 0);
  assert.throws(() => f.c.guarded(r.taskId, () => assert.fail("stale side effect")), { code: "GENERATION_MISMATCH" });
  assert.equal(f.disk(r), before); assert.equal(fs.readFileSync(worker, "utf8"), workerBefore);
  assert.doesNotThrow(() => f.c.close());
  assert.equal(fs.readFileSync(f.options.controllerRegistryPath, "utf8"), registryBefore);
});

test("takeover between expired assert and acquire is rejected atomically with old generation", async t => {
  const f = fixture(t), r = f.record(); f.c.track(r); pauseHeartbeat(f.c);
  t.mock.timers.tick(TTL);
  const remove = fs.rmdirSync; let next, armed = true;
  fs.rmdirSync = function (dir, ...args) {
    const result = remove.call(fs, dir, ...args);
    if (armed && dir === `${f.options.controllerRegistryPath}.lock`) {
      armed = false; next = successor(f, r);
    }
    return result;
  };
  try { await f.c.tick(); } finally { fs.rmdirSync = remove; }
  assert.equal(next.generation, 2);
  assert.deepEqual(f.read(r.taskId), next);
  assert.equal(f.c.quarantined.has(r.taskId), true);
  assert.equal(f.errors.length, 1); assert.equal(f.lives.length, 0);
  f.c.heartbeat(); await f.c.tick(); assert.deepEqual(f.read(r.taskId), next);
});

test("PID/token/parent conflicts never auto-acquire or rewrite foreign authority", async t => {
  const f = fixture(t);
  for (const [name, override, code] of [
    ["token", { controllerToken: randomUUID() }, "TOKEN_MISMATCH"],
    ["parent", { parentSessionId: "foreign-parent" }, "PARENT_MISMATCH"],
    ["pid", { ownerPid: process.pid + 1 }, "PID_MISMATCH"],
  ]) {
    const r = f.record(`task-${name}-aaaa`); f.c.track(r);
    const registry = readControllerLeaseRegistry(f.options.controllerRegistryPath);
    Object.assign(registry.leases[r.taskId], override, { heartbeatAt: new Date(baseTime - TTL).toISOString() });
    fs.writeFileSync(f.options.controllerRegistryPath, JSON.stringify(registry));
    const before = fs.readFileSync(f.options.controllerRegistryPath, "utf8");
    await f.c.tick(); f.c.heartbeat(); await f.c.tick();
    assert.equal(f.c.quarantined.has(r.taskId), true);
    assert.equal(f.errors.at(-1).code, code);
    assert.equal(fs.readFileSync(f.options.controllerRegistryPath, "utf8"), before);
    f.c.forget(r.taskId);
    assert.equal(fs.readFileSync(f.options.controllerRegistryPath, "utf8"), before);
  }
  assert.equal(f.errors.length, 3);
});

test("explicit recover can retry a released conflict; automatic polls cannot", async t => {
  const f = fixture(t), r = f.record(); f.c.track(r); pauseHeartbeat(f.c);
  t.mock.timers.tick(TTL); const next = successor(f, r);
  await f.c.tick(); assert.equal(f.errors.length, 1);
  releaseControllerLease(f.options.controllerRegistryPath, next);
  await f.c.tick(); f.c.heartbeat();
  assert.equal(f.read(r.taskId).generation, next.generation);
  const report = await f.c.recover();
  assert.match(report.join("\n"), /controller acquired/);
  assert.equal(f.read(r.taskId).generation, next.generation + 1);
  assert.equal(f.c.quarantined.has(r.taskId), false); assert.equal(f.lives.length, 1);
});

test("hung/slow probes have bounded awaits, never accumulate or complete, and do not block ANY lease heartbeat", async t => {
  const f = fixture(t, { heartbeatMs: 10, pollMs: 5, probeTimeoutMs: 40 });
  const hung = f.record("task-hung-aaaa"), other = f.record("task-other-bbbb"), callback = f.record("task-callback-cccc");
  let calls = 0, finish, signal;
  f.c.options.probe = (record, context) => {
    if (record.taskId !== hung.taskId) return Promise.resolve({ state: "live" });
    calls++; signal = context.signal;
    return new Promise(resolve => { finish = resolve; });
  };
  f.c.track(hung); f.c.track(other);
  f.c.options.skipExistingCallback = () => true; f.c.retainCallback(callback);
  const pending = f.c.tick(); await flush();
  assert.equal(f.c.busy, true); assert.equal(calls, 1);
  t.mock.timers.tick(30); await flush();
  assert.equal(f.c.busy, true, "probe not yet timed out");
  for (const r of [hung, other, callback]) {
    assert.equal(f.read(r.taskId).heartbeatAt, new Date(baseTime + 30).toISOString());
    assert.equal(f.read(r.taskId).generation, 1);
  }
  t.mock.timers.tick(10); await pending;
  assert.equal(f.c.busy, false); assert.equal(signal.aborted, true);
  assert.match(f.unknown.at(-1).reason, /timed out/);
  for (let i = 0; i < 5; i++) { t.mock.timers.tick(10); await flush(); await f.c.tick(); }
  assert.equal(calls, 1); assert.equal(f.c.probes.size, 1); assert.equal(f.errors.length, 0);
  assert.equal(f.deliveries.length, 0); assert.equal(f.c.records.get(hung.taskId).result, undefined);
  assert.equal(JSON.parse(f.disk(hung)).status, "running");
  finish({ state: "dead" }); await flush();
  assert.equal(f.c.probes.size, 0); assert.equal(f.deliveries.length, 0, "late dead result is ignored");
  const slowStart = Date.now();
  f.c.options.probe = record => record.taskId === hung.taskId
    ? new Promise(resolve => setTimeout(() => resolve({ state: "live" }), 20)) : Promise.resolve({ state: "live" });
  const slow = f.c.tick(); t.mock.timers.tick(20); await slow;
  assert.equal(f.c.probes.size, 0);
  for (const r of [hung, other, callback]) assert.equal(f.read(r.taskId).heartbeatAt, new Date(slowStart + 20).toISOString());
  f.c.options.probe = () => { throw Error("adapter failure"); };
  await f.c.tick(); assert.equal(f.deliveries.length, 0); assert.equal(f.c.probes.size, 0);
  assert.match(f.unknown.at(-1).reason, /adapter failure/);
});

test("recover starts heartbeats before its first hung probe", async t => {
  const f = fixture(t, { heartbeatMs: 10, probeTimeoutMs: 40 });
  const r = f.record(); v2.atomicRecoveryWrite(v2.taskRecordPath(f.options.ledgerDir, r.taskId), r);
  f.c.options.probe = () => new Promise(() => {});
  const recovering = f.c.recover(); await flush();
  t.mock.timers.tick(30); await flush();
  assert.equal(f.read(r.taskId).heartbeatAt, new Date(baseTime + 30).toISOString());
  t.mock.timers.tick(10); await recovering;
  assert.equal(f.deliveries.length, 0); assert.equal(f.c.busy, false);
});

test("close cancels poll/heartbeat/probe timers and cleans all tasks without releasing a successor", async t => {
  const f = fixture(t, { heartbeatMs: 10, pollMs: 5, probeTimeoutMs: 40 });
  const first = f.record("task-first-aaaa"), other = f.record("task-other-bbbb"), held = f.record("task-held-cccc");
  let finish, signal;
  f.c.options.probe = (_record, context) => { signal = context.signal; return new Promise(resolve => { finish = resolve; }); };
  f.c.track(first); f.c.track(other); f.c.track(held);
  const old = f.read(first.taskId);
  releaseControllerLease(f.options.controllerRegistryPath, old); const next = successor(f, first);
  const pending = f.c.tick(); await flush(); // quarantines first; awaits other
  // Leave another stale lease unobserved: close's release must also fail safely.
  releaseControllerLease(f.options.controllerRegistryPath, f.read(held.taskId)); const nextHeld = successor(f, held);
  const poll = f.c.timer, heartbeat = f.c.heartbeatTimer, probe = f.c.probes.get(other.taskId).timer;
  const clearPoll = t.mock.method(globalThis, "clearInterval");
  const clearProbe = t.mock.method(globalThis, "clearTimeout");
  assert.doesNotThrow(() => f.c.close()); await pending;
  assert.equal(signal.aborted, true);
  assert.equal(f.c.timer, null); assert.equal(f.c.heartbeatTimer, null);
  for (const timer of [poll, heartbeat]) assert.ok(clearPoll.mock.calls.some(call => call.arguments[0] === timer));
  assert.ok(clearProbe.mock.calls.some(call => call.arguments[0] === probe));
  for (const key of ["leases", "records", "callbacks", "probes", "quarantined"]) assert.equal(f.c[key].size, 0);
  assert.deepEqual(f.read(first.taskId), next); assert.deepEqual(f.read(held.taskId), nextHeld);
  assert.ok(f.read(other.taskId).releasedAt, "stale first release did not block cleanup of other lease");
  const before = fs.readFileSync(f.options.controllerRegistryPath, "utf8");
  finish({ state: "dead" }); await flush(); t.mock.timers.tick(TTL); await flush();
  assert.equal(fs.readFileSync(f.options.controllerRegistryPath, "utf8"), before);
  assert.equal(f.deliveries.length, 0); assert.doesNotThrow(() => f.c.close());
  assert.equal(f.errors.length, 2);
});
