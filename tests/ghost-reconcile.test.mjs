import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, after } from "node:test";
const inheritedWorker = process.env.PI_SUBAGENT_TASK_ID;
delete process.env.PI_SUBAGENT_TASK_ID; // These fixtures model a MAIN, even when run by a worker.
after(() => { if (inheritedWorker === undefined) delete process.env.PI_SUBAGENT_TASK_ID; else process.env.PI_SUBAGENT_TASK_ID = inheritedWorker; });
import { reconcileLegacyGhosts, absentTaskInSnapshots, replaceOwnershipHeartbeat } from "../extensions/ghost-reconcile-v1.mjs";
import { registerWorkerOwnership, refreshWorkerOwnership, heartbeatWorkerOwnerships, readWorkerOwnershipRegistry } from "../extensions/ownership-registry-v3.mjs";
import { registerWorkerOwnership as registerLegacy } from "../extensions/ownership-registry-v2.mjs";

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "durable-ghost-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const taskId = "task-ghost-aaaa", token = "fixture-token", parentSessionId = "fixture-parent";
  const parentSessionPath = path.join(root, "parent.jsonl"), ledgerDir = path.join(root, "ledger"), notifyDir = path.join(root, "notify");
  const registryPath = path.join(notifyDir, ".active-workers.json");
  fs.mkdirSync(ledgerDir); fs.mkdirSync(path.join(notifyDir, taskId), { recursive: true });
  fs.writeFileSync(parentSessionPath, JSON.stringify({ type: "session", id: parentSessionId, cwd: root }) + "\n");
  const registration = { taskId, ownerPid: process.pid, ownerToken: token, cwd: root, itemKeys: [`worker:${taskId}`] };
  registerLegacy(registryPath, registration);
  const record = { version: 1, taskId, status: "stopped", mode: "async-rmux", ownershipToken: token,
    parentSessionId, parentSessionPath, cwd: root, rmuxTarget: `pi-agents:fixture-${taskId}.0` };
  const file = path.join(ledgerDir, `${taskId}.json`);
  const save = () => fs.writeFileSync(file, JSON.stringify(record)); save();
  const ownerships = new Map([[taskId, token]]), tasks = new Map([[taskId, { ...record, proc: { killed: false, exitCode: null } }]]);
  const managed = new Set([taskId]), monitors = new Set([taskId]);
  let rmux = { returnCode: 0, stdout: "pi-main:node.0|0" }, processes = { returnCode: 0, stdout: `${process.pid} pi --session ${parentSessionPath}\n` }, probes = 0;
  const options = { ownerships, tasks, ownerPid: process.pid, parentSessionId, parentSessionPath, ledgerDir, notifyDir, registryPath,
    probeRmux: async () => { probes++; return rmux; }, probeProcesses: async () => processes,
    retireMemory: id => { ownerships.delete(id); tasks.delete(id); managed.delete(id); monitors.delete(id); } };
  return { root, taskId, token, record, registration, file, save, options, ownerships, tasks, managed, monitors,
    read: () => readWorkerOwnershipRegistry(registryPath).workers[taskId],
    setRmux: x => { rmux = x; }, setProcesses: x => { processes = x; }, probes: () => probes };
}

test("stopped old-generation ghost retires without signaling its live MAIN PID or erasing history", async t => {
  const f = fixture(t), before = fs.readFileSync(f.file, "utf8");
  const oldKill = process.kill; process.kill = () => { throw Error("reconciliation must not signal any PID, even signal 0"); };
  try { assert.deepEqual(await reconcileLegacyGhosts(f.options), [f.taskId]); }
  finally { process.kill = oldKill; }
  assert.equal(f.read(), undefined); assert.equal(f.ownerships.size, 0); assert.equal(f.tasks.size, 0);
  assert.equal(f.managed.size, 0); assert.equal(f.monitors.size, 0);
  assert.equal(fs.readFileSync(f.file, "utf8"), before);
  assert.equal(fs.readFileSync(f.options.parentSessionPath, "utf8").split("\n").filter(Boolean).length, 1);
});

for (const mode of ["missing", "corrupt", "token", "parent", "canonical", "registration-token", "registration-parent", "registration-pid", "missing-registry-file", "corrupt-registry", "receiver", "wait", "fresh-identity", "corrupt-identity", "pane", "worker", "unknown", "bad-process-snapshot"]) {
  test(`preserve ambiguous/live/foreign evidence: ${mode}`, async t => {
    const f = fixture(t);
    if (mode === "missing") fs.unlinkSync(f.file);
    if (mode === "corrupt") fs.writeFileSync(f.file, "{");
    if (mode === "token") { f.record.ownershipToken = "other"; f.save(); }
    if (mode === "parent") { f.options.parentSessionId = "foreign"; }
    if (mode === "missing-registry-file") fs.unlinkSync(f.options.registryPath);
    if (mode === "corrupt-registry") fs.writeFileSync(f.options.registryPath, "{");
    if (mode === "canonical") { const mirror = path.join(f.root, "subagent-task-mirror.jsonl"); fs.copyFileSync(f.options.parentSessionPath, mirror); f.record.parentSessionPath = mirror; f.save(); }
    if (["registration-token", "registration-parent", "registration-pid", "receiver"].includes(mode)) {
      const data = readWorkerOwnershipRegistry(f.options.registryPath), row = data.workers[f.taskId];
      if (mode === "registration-token") row.ownerToken = "foreign";
      if (mode === "registration-parent") row.parentSessionId = "foreign";
      if (mode === "registration-pid") row.ownerPid = process.pid + 1;
      if (mode === "receiver") { row.ownershipMode = "receiver"; row.workerPid = process.pid; }
      fs.writeFileSync(f.options.registryPath, JSON.stringify(data));
    }
    if (mode === "wait") fs.writeFileSync(path.join(f.options.notifyDir, f.taskId, ".notification-wait-lease"), JSON.stringify({ version: 2, taskId: f.taskId, cwd: f.root, expiresAt: Date.now() + 60000 }));
    if (mode === "fresh-identity") fs.writeFileSync(path.join(f.options.notifyDir, f.taskId, ".receiver-identity.json"), JSON.stringify({ version: 2, taskId: f.taskId, cwd: f.root, pid: process.pid, heartbeatAt: new Date().toISOString() }));
    if (mode === "corrupt-identity") fs.writeFileSync(path.join(f.options.notifyDir, f.taskId, ".receiver-identity.json"), "{");
    if (mode === "pane") f.setRmux({ returnCode: 0, stdout: `${f.record.rmuxTarget}|0` });
    if (mode === "worker") f.setProcesses({ returnCode: 0, stdout: `12345 pi-subagent-${f.taskId}\n${process.pid} pi` });
    if (mode === "unknown") f.setRmux({ returnCode: 1 });
    if (mode === "bad-process-snapshot") f.setProcesses({ returnCode: 0, stdout: "malformed" });
    const readBytes = () => fs.existsSync(f.options.registryPath) ? fs.readFileSync(f.options.registryPath, "utf8") : null;
    const before = readBytes();
    assert.deepEqual(await reconcileLegacyGhosts(f.options), []);
    assert.equal(readBytes(), before, "no other reservation should be opportunistically pruned");
    assert.ok(f.tasks.has(f.taskId)); assert.ok(f.ownerships.has(f.taskId));
  });
}

test("ownership changing across await and cleanup failure are preserved and retried", async t => {
  const f = fixture(t); let calls = 0;
  f.options.isCurrent = () => { if (++calls === 1) throw Error("simulated cleanup failure under registry lock"); return true; };
  assert.deepEqual(await reconcileLegacyGhosts(f.options), []); assert.ok(f.read());
  assert.ok(f.tasks.has(f.taskId)); assert.equal(fs.existsSync(`${f.options.registryPath}.lock`), false);
  assert.deepEqual(await reconcileLegacyGhosts(f.options), [f.taskId]);
  const g = fixture(t);
  g.options.probeProcesses = async () => { g.ownerships.set(g.taskId, "new-local-token"); return { returnCode: 0, stdout: "" }; };
  assert.deepEqual(await reconcileLegacyGhosts(g.options), []); assert.ok(g.read());
});

test("terminal registration/refresh never revives stopped tasks; heartbeat cannot renew them", t => {
  const f = fixture(t), opts = { ledgerDir: f.options.ledgerDir, isSettled: () => true };
  const before = f.read().heartbeatAt;
  assert.throws(() => registerWorkerOwnership(f.options.registryPath, f.registration, opts), /terminal task/);
  assert.throws(() => registerWorkerOwnership(f.options.registryPath, { ...f.registration, ownerToken: "replacement" }, opts), /terminal task|token mismatch/);
  assert.throws(() => refreshWorkerOwnership(f.options.registryPath, f.taskId, process.pid, f.token, opts), /terminal task/);
  heartbeatWorkerOwnerships(f.options.registryPath, f.ownerships, opts);
  assert.equal(f.read().heartbeatAt, before, "even generic settlement pruning must not bypass conservative reconciliation");
  fs.unlinkSync(f.file);
  refreshWorkerOwnership(f.options.registryPath, f.taskId, process.pid, f.token, { ledgerDir: f.options.ledgerDir });
  assert.ok(f.read(), "missing terminal evidence does not revoke a legitimate reservation");
});

test("completed pending receipts are not ghost-retired; nonterminal tasks do not trigger probes", async t => {
  const f = fixture(t); f.record.status = "completed"; f.record.result = { resultId: "fixture" }; f.save();
  assert.deepEqual(await reconcileLegacyGhosts(f.options), []); assert.equal(f.probes(), 0);
  f.record.status = "running"; f.save();
  assert.deepEqual(await reconcileLegacyGhosts(f.options), []); assert.equal(f.probes(), 0);
});

test("reload replaces the owned old timer and serializes new async heartbeats", async () => {
  const old = {}, globals = { __pi_subagent_worker_heartbeat_timer__: old }, cleared = [];
  let callback, calls = 0, release;
  const timers = { clearInterval: x => cleared.push(x), setInterval: f => { callback = f; return { unref() {} }; } };
  const timer = replaceOwnershipHeartbeat(globals, async () => { calls++; await new Promise(r => { release = r; }); }, timers);
  assert.deepEqual(cleared, [old]); assert.equal(globals.__pi_subagent_worker_heartbeat_timer__, timer);
  const first = callback(); await callback(); assert.equal(calls, 1); release(); await first;
});

test("failed/malformed snapshots and retained dead panes are never absence proof", () => {
  assert.equal(absentTaskInSnapshots("task-ghost-aaaa", { returnCode: 0, stdout: "broken" }, { returnCode: 0 }), false);
  assert.equal(absentTaskInSnapshots("task-ghost-aaaa", { returnCode: 0, stdout: "pi-agents:x-task-ghost-aaaa.0|1" }, { returnCode: 0 }), false);
  assert.equal(absentTaskInSnapshots("task-ghost-aaaa", { returnCode: 0 }, { returnCode: 1 }), false);
});


test("expiry, session change and fresh notification evidence across probes preserve ownership", async t => {
  for (const change of ["expired", "clock-backwards", "session", "new-wait"]) {
    const f = fixture(t), realNow = Date.now, now = realNow();
    f.options.probeProcesses = async () => {
      if (change === "expired") Date.now = () => now + 6000;
      if (change === "clock-backwards") Date.now = () => now - 100;
      if (change === "session") f.options.isCurrent = () => false;
      if (change === "new-wait") fs.writeFileSync(path.join(f.options.notifyDir, f.taskId, ".notification-wait-lease"), JSON.stringify({ version: 2, taskId: f.taskId, cwd: f.root, expiresAt: now + 60000 }));
      return { returnCode: 0, stdout: "" };
    };
    try { assert.deepEqual(await reconcileLegacyGhosts(f.options), []); }
    finally { Date.now = realNow; }
    assert.ok(f.read()); assert.ok(f.tasks.has(f.taskId));
  }
});


function installReceiver(f, { pid = process.pid, heartbeatAt = new Date().toISOString(), token = f.token } = {}) {
  const receiverIdentityPath = path.join(f.options.notifyDir, f.taskId, ".receiver-identity.json");
  const identity = { version: 2, taskId: f.taskId, pid, cwd: f.root, heartbeatAt };
  fs.writeFileSync(receiverIdentityPath, JSON.stringify(identity));
  const data = readWorkerOwnershipRegistry(f.options.registryPath);
  Object.assign(data.workers[f.taskId], { ownershipMode: "receiver", workerPid: pid, ownerPid: pid, pid,
    receiverIdentityPath, ownerToken: token, heartbeatAt: "2000-01-01T00:00:00Z" });
  fs.writeFileSync(f.options.registryPath, JSON.stringify(data));
  return { identity, receiverIdentityPath };
}

for (const status of ["stopped", "completed"]) {
  for (const failure of ["dead", "expired", "missing", "foreign-token-dead"]) {
    test(`${status} terminal receiver with ${failure} identity is pruned normally`, t => {
      const f = fixture(t); f.record.status = status; f.save();
      const { receiverIdentityPath } = installReceiver(f, {
        pid: failure.includes("dead") ? 2147483647 : process.pid,
        heartbeatAt: failure === "expired" ? new Date(Date.now() - 100000).toISOString() : new Date().toISOString(),
        token: failure === "foreign-token-dead" ? "new-receiver-token" : f.token,
      });
      if (failure === "missing") fs.unlinkSync(receiverIdentityPath);
      if (failure.includes("dead")) fs.writeFileSync(path.join(f.options.notifyDir, f.taskId, ".notification-wait-lease"), JSON.stringify({ version: 2, taskId: f.taskId, cwd: f.root, expiresAt: Date.now() + 60000 }));
      heartbeatWorkerOwnerships(f.options.registryPath, [], { ledgerDir: f.options.ledgerDir });
      assert.equal(f.read(), undefined, "terminal status must not bypass reliable receiver pruning");
    });
  }
  test(`${status} live receiver with active wait renews identity despite terminal/settled evidence`, t => {
    const f = fixture(t); f.record.status = status; f.save();
    const { identity } = installReceiver(f);
    fs.writeFileSync(path.join(f.options.notifyDir, f.taskId, ".notification-wait-lease"), JSON.stringify({ version: 2, taskId: f.taskId, cwd: f.root, expiresAt: Date.now() + 60000 }));
    const opts = { ledgerDir: f.options.ledgerDir, isSettled: () => true };
    heartbeatWorkerOwnerships(f.options.registryPath, f.ownerships, opts);
    assert.equal(f.read().heartbeatAt, identity.heartbeatAt);
    const refreshed = refreshWorkerOwnership(f.options.registryPath, f.taskId, process.pid, f.token, opts);
    assert.equal(refreshed.heartbeatAt, identity.heartbeatAt, "refresh authenticates the receiver before legacy terminal guard");
    const row = f.read(); registerWorkerOwnership(f.options.registryPath, row, opts);
    assert.equal(f.read().workerPid, process.pid, "existing valid terminal receiver registration is preserved, not rebound");
    assert.throws(() => registerWorkerOwnership(f.options.registryPath, { ...row, receiverIdentityPath: "another-file" }, opts), /cannot be rebound/);
  });
}

test("mismatched terminal ledger token does not block ordinary live receiver renewal", t => {
  const f = fixture(t), token = "new-receiver-token";
  const { identity } = installReceiver(f, { token });
  heartbeatWorkerOwnerships(f.options.registryPath, [[f.taskId, token]], { ledgerDir: f.options.ledgerDir });
  assert.equal(f.read().heartbeatAt, identity.heartbeatAt);
  assert.equal(refreshWorkerOwnership(f.options.registryPath, f.taskId, process.pid, token, { ledgerDir: f.options.ledgerDir }).ownerToken, token);
  registerWorkerOwnership(f.options.registryPath, f.read(), { ledgerDir: f.options.ledgerDir });
  assert.equal(f.read().ownerToken, token, "terminal ledger token mismatch cannot block existing receiver registration");
});

for (const failure of ["dead-parent", "foreign-token", "foreign-parent"]) {
  test(`terminal legacy ${failure} retains ordinary pruning semantics`, t => {
    const f = fixture(t), data = readWorkerOwnershipRegistry(f.options.registryPath), row = data.workers[f.taskId];
    if (failure === "dead-parent") row.ownerPid = row.pid = 2147483647;
    if (failure === "foreign-token") row.ownerToken = "new-token";
    if (failure === "foreign-parent") row.parentSessionId = "different-parent";
    fs.writeFileSync(f.options.registryPath, JSON.stringify(data));
    heartbeatWorkerOwnerships(f.options.registryPath, [], { ledgerDir: f.options.ledgerDir, isSettled: () => true });
    assert.equal(f.read(), undefined);
  });
}


test("already-absent registered row clears old local state under lock without registry writes", async t => {
  const f = fixture(t), data = readWorkerOwnershipRegistry(f.options.registryPath);
  delete data.workers[f.taskId];
  data.workers["task-other-bbbb"] = { taskId: "task-other-bbbb", ownerPid: process.pid, ownerToken: "other-token", cwd: f.root, heartbeatAt: "2000-01-01T00:00:00Z" };
  fs.writeFileSync(f.options.registryPath, JSON.stringify(data));
  const before = fs.readFileSync(f.options.registryPath, "utf8"), ledger = fs.readFileSync(f.file, "utf8");
  const metadata = fs.statSync(f.options.registryPath);
  const oldRetire = f.options.retireMemory;
  f.options.retireMemory = id => {
    assert.equal(fs.existsSync(`${f.options.registryPath}.lock`), false, "memory retirement follows the authenticated locked classification");
    oldRetire(id);
  };
  assert.deepEqual(await reconcileLegacyGhosts(f.options), [f.taskId]);
  assert.equal(fs.readFileSync(f.options.registryPath, "utf8"), before);
  assert.equal(fs.statSync(f.options.registryPath).mtimeMs, metadata.mtimeMs);
  assert.equal(fs.readFileSync(f.file, "utf8"), ledger);
  assert.equal(f.tasks.size, 0); assert.equal(f.ownerships.size, 0); assert.equal(f.managed.size, 0); assert.equal(f.monitors.size, 0);
});

for (const replacement of ["token", "receiver", "invalid-slot"]) {
  test(`new ${replacement} row appearing after absent-row snapshot preserves old local state`, async t => {
    const f = fixture(t), data = readWorkerOwnershipRegistry(f.options.registryPath);
    delete data.workers[f.taskId]; fs.writeFileSync(f.options.registryPath, JSON.stringify(data));
    let racedBytes;
    f.options.probeProcesses = async () => {
      const current = readWorkerOwnershipRegistry(f.options.registryPath);
      current.workers[f.taskId] = replacement === "invalid-slot" ? null : {
        ...f.registration, ownerToken: replacement === "token" ? "new-owner-token" : f.token,
        ...(replacement === "receiver" ? { ownershipMode: "receiver", workerPid: process.pid, receiverIdentityPath: "new-receiver" } : {}),
      };
      racedBytes = JSON.stringify(current); fs.writeFileSync(f.options.registryPath, racedBytes);
      return { returnCode: 0, stdout: `${process.pid} pi` };
    };
    assert.deepEqual(await reconcileLegacyGhosts(f.options), []);
    assert.equal(fs.readFileSync(f.options.registryPath, "utf8"), racedBytes);
    assert.ok(f.tasks.has(f.taskId)); assert.ok(f.ownerships.has(f.taskId));
  });
}
