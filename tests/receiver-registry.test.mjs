import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import {
  heartbeatWorkerOwnerships,
  migrateWorkerOwnershipToReceiver,
  readWorkerOwnershipRegistry,
  registerWorkerOwnership,
  unregisterWorkerOwnership,
  validateReceiverIdentity,
} from "../extensions/ownership-registry.mjs";

const moduleUrl = new URL("../extensions/ownership-registry.mjs", import.meta.url).href;

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-receiver-registry-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const registry = path.join(dir, "registry.json");
  const receiverIdentityPath = path.join(dir, "receiver.json");
  const record = {
    taskId: "task-fixture",
    ownershipMode: "receiver",
    ownerPid: process.pid,
    workerPid: process.pid,
    ownerToken: "fixture-token",
    parentSessionId: "fixture-parent",
    cwd: dir,
    itemKeys: ["worker:task-fixture", "mission:fixture", "123456"],
    receiverIdentityPath,
  };
  const identity = {
    version: 2,
    taskId: record.taskId,
    targetId: "fixture-session-not-task-id",
    pid: process.pid,
    cwd: path.join(dir, "nested", ".."),
    itemKeys: record.itemKeys,
    runId: "fixture-run",
    nonce: "fixture-nonce",
    heartbeatAt: new Date(Date.now() - 1000).toISOString(),
  };
  const writeIdentity = (changes = {}) => fs.writeFileSync(receiverIdentityPath, JSON.stringify({ ...identity, ...changes }));
  const read = () => readWorkerOwnershipRegistry(registry).workers[record.taskId];
  const prune = () => heartbeatWorkerOwnerships(registry, []);
  writeIdentity();
  return { dir, registry, record, identity, writeIdentity, read, prune };
}

// Only disposable test processes are used; never inspect/kill a real worker.
async function startParentFixture(t) {
  const child = spawn(process.execPath, ["-e", "process.send('ready'); setInterval(() => {}, 1000)"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  await once(child, "message");
  return child;
}

async function stopParentFixture(child) {
  const exited = once(child, "exit");
  child.kill();
  await exited;
}

function runModule(code, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", status => status === 0 ? resolve() : reject(new Error(stderr || `exit ${status}`)));
  });
}

test("public identity validation checks exact task, resolved cwd, optional PID and heartbeat boundaries", t => {
  const f = fixture(t);
  const now = Date.now();
  const { workerPid, ...withoutPid } = f.record;
  assert.deepEqual(validateReceiverIdentity(f.record), f.identity);
  assert.deepEqual(validateReceiverIdentity(withoutPid), f.identity);
  assert.throws(() => validateReceiverIdentity({ ...f.record, taskId: "task-fixt" }), /receiver identity/);
  assert.throws(() => validateReceiverIdentity({ ...f.record, cwd: path.join(f.dir, "elsewhere") }), /cwd mismatch/);
  assert.throws(() => validateReceiverIdentity({ ...f.record, workerPid: workerPid + 1 }), /PID mismatch/);

  for (const age of [90000, 0, -5000]) {
    f.writeIdentity({ heartbeatAt: new Date(now - age).toISOString() });
    assert.doesNotThrow(() => validateReceiverIdentity(f.record, { now }), `age ${age} should be accepted`);
  }
  for (const age of [90001, -5001]) {
    f.writeIdentity({ heartbeatAt: new Date(now - age).toISOString() });
    assert.throws(() => validateReceiverIdentity(f.record, { now }), /heartbeat/, `age ${age} should be rejected`);
  }
});

test("identity validation fails closed for invalid, missing and dead receiver identities", async t => {
  const f = fixture(t);
  const child = await startParentFixture(t);
  const deadPid = child.pid;
  await stopParentFixture(child);
  const invalid = [
    { version: 1 }, { version: "2" }, { taskId: "other-task" },
    { pid: String(process.pid) }, { pid: 1 }, { cwd: "/elsewhere" },
    { cwd: "" }, { heartbeatAt: "invalid" }, { heartbeatAt: null },
    { heartbeatAt: Date.now() }, { heartbeatAt: new Date(Date.now() - 100000).toISOString() },
    { heartbeatAt: new Date(Date.now() + 60000).toISOString() },
  ];
  for (const change of invalid) {
    f.writeIdentity(change);
    assert.throws(() => validateReceiverIdentity(f.record), /receiver identity/);
  }
  f.writeIdentity({ pid: deadPid });
  assert.throws(() => validateReceiverIdentity({ ...f.record, workerPid: deadPid }), /not alive/);
  fs.writeFileSync(f.record.receiverIdentityPath, "{");
  assert.throws(() => validateReceiverIdentity(f.record), /receiver identity/);
  fs.unlinkSync(f.record.receiverIdentityPath);
  assert.throws(() => validateReceiverIdentity(f.record), /receiver identity/);
});

test("receiver ownership survives parent exit, ignores registry age, and enforces token/collision/cap", async t => {
  const f = fixture(t);
  const parent = await startParentFixture(t);
  registerWorkerOwnership(f.registry, f.record);
  let data = readWorkerOwnershipRegistry(f.registry);
  // Exercise pruning of historical receiver records with an obsolete parent PID.
  data.workers[f.record.taskId].ownerPid = parent.pid;
  data.workers[f.record.taskId].heartbeatAt = new Date(0).toISOString();
  fs.writeFileSync(f.registry, JSON.stringify(data));
  await stopParentFixture(parent);
  f.prune();
  assert.ok(f.read(), "fresh receiver must survive its original parent");
  assert.throws(() => registerWorkerOwnership(f.registry, { ...f.record, ownerToken: "attacker" }), /token mismatch/);
  assert.throws(() => registerWorkerOwnership(f.registry, {
    taskId: "other", ownerPid: process.pid, ownerToken: "other", cwd: path.join(f.dir, "nested", ".."), itemKeys: ["mission:fixture"],
  }), /item collision/);
  assert.throws(() => registerWorkerOwnership(f.registry, {
    taskId: "other", ownerPid: process.pid, ownerToken: "other", cwd: f.dir, itemKeys: [],
  }, { maxActiveWorkers: 1 }), /global subagent limit/);
  unregisterWorkerOwnership(f.registry, f.record.taskId, "wrong-token");
  assert.ok(f.read());
  unregisterWorkerOwnership(f.registry, f.record.taskId, f.record.ownerToken);
  assert.equal(f.read(), undefined);
});

test("receiver heartbeat mirrors identity and cannot manufacture freshness", t => {
  const f = fixture(t);
  registerWorkerOwnership(f.registry, f.record);
  assert.equal(f.read().heartbeatAt, f.identity.heartbeatAt);
  const nextHeartbeat = new Date(Date.now() - 500).toISOString();
  f.writeIdentity({ heartbeatAt: nextHeartbeat });
  heartbeatWorkerOwnerships(f.registry, [[f.record.taskId, "wrong-token"]]);
  assert.equal(f.read().heartbeatAt, f.identity.heartbeatAt);
  heartbeatWorkerOwnerships(f.registry, [[f.record.taskId, f.record.ownerToken]]);
  assert.equal(f.read().heartbeatAt, nextHeartbeat);
  assert.equal(JSON.parse(fs.readFileSync(f.record.receiverIdentityPath)).heartbeatAt, nextHeartbeat);
  f.writeIdentity({ heartbeatAt: new Date(Date.now() - 100000).toISOString() });
  heartbeatWorkerOwnerships(f.registry, [[f.record.taskId, f.record.ownerToken]]);
  assert.equal(f.read(), undefined, "parent heartbeat must not rescue stale receiver identity");
});

test("receiver pruning handles all invalid identities and settled tasks regardless of registry heartbeat", async t => {
  const f = fixture(t);
  const parent = await startParentFixture(t);
  const deadPid = parent.pid;
  await stopParentFixture(parent);
  const invalid = [
    { version: 1 }, { taskId: "other-task" }, { cwd: "/elsewhere" }, { pid: deadPid },
    { heartbeatAt: "bad" }, { heartbeatAt: new Date(Date.now() - 100000).toISOString() },
    { heartbeatAt: new Date(Date.now() + 60000).toISOString() },
    "missing", "partial",
  ];
  for (const change of invalid) {
    f.writeIdentity();
    registerWorkerOwnership(f.registry, f.record);
    if (change === "missing") fs.unlinkSync(f.record.receiverIdentityPath);
    else if (change === "partial") fs.writeFileSync(f.record.receiverIdentityPath, "{");
    else f.writeIdentity(change);
    f.prune();
    assert.equal(f.read(), undefined, `invalid identity ${JSON.stringify(change)} must be pruned`);
  }
  f.writeIdentity();
  registerWorkerOwnership(f.registry, f.record);
  const data = readWorkerOwnershipRegistry(f.registry);
  data.workers[f.record.taskId].workerPid = deadPid;
  f.writeIdentity({ pid: deadPid });
  fs.writeFileSync(f.registry, JSON.stringify(data));
  f.prune();
  assert.equal(f.read(), undefined, "matching identity with a dead worker PID must be pruned");
  f.writeIdentity();
  registerWorkerOwnership(f.registry, f.record);
  heartbeatWorkerOwnerships(f.registry, [], { isSettled: taskId => taskId === f.record.taskId });
  assert.equal(f.read(), undefined);
});

test("stale receiver permits new token, but new receiver registration itself must validate", t => {
  const f = fixture(t);
  registerWorkerOwnership(f.registry, f.record);
  f.writeIdentity({ heartbeatAt: new Date(Date.now() - 100000).toISOString() });
  assert.throws(() => registerWorkerOwnership(f.registry, { ...f.record, ownerToken: "replacement" }), /receiver identity/);
  // A stale identity is not a live reservation; a legacy replacement may claim it.
  registerWorkerOwnership(f.registry, { ...f.record, ownershipMode: "legacy", ownerToken: "replacement" });
  assert.equal(f.read().ownerToken, "replacement");
  unregisterWorkerOwnership(f.registry, f.record.taskId, "replacement");
  f.writeIdentity();
  registerWorkerOwnership(f.registry, { ...f.record, ownerToken: "replacement" });
  assert.equal(f.read().ownerToken, "replacement");
  assert.equal(f.read().ownerPid, process.pid);
  assert.equal(f.read().pid, process.pid);
  // A fresh new identity may replace a stale receiver with a different token.
  f.writeIdentity({ heartbeatAt: new Date(Date.now() - 100000).toISOString() });
  const newPath = path.join(f.dir, "replacement-receiver.json");
  fs.writeFileSync(newPath, JSON.stringify({ ...f.identity, heartbeatAt: new Date().toISOString() }));
  registerWorkerOwnership(f.registry, { ...f.record, receiverIdentityPath: newPath, ownerToken: "replacement-2" });
  assert.equal(f.read().ownerToken, "replacement-2");
  assert.equal(f.read().receiverIdentityPath, newPath);
});

test("migration validates under lock, preserves lease/keys, returns record, and prevents downgrade", async t => {
  const f = fixture(t);
  const parent = await startParentFixture(t);
  const legacy = { ...f.record, ownershipMode: undefined, ownerPid: parent.pid, itemKeys: ["mission:fixture", "mission:fixture"], itemIds: ["123456"], startedAt: new Date().toISOString() };
  registerWorkerOwnership(f.registry, legacy);
  const receiver = { workerPid: process.pid, parentSessionId: f.record.parentSessionId, receiverIdentityPath: f.record.receiverIdentityPath };
  const before = fs.readFileSync(f.registry, "utf8");
  assert.throws(() => migrateWorkerOwnershipToReceiver(f.registry, f.record.taskId, "attacker", receiver), /token mismatch/);
  assert.throws(() => migrateWorkerOwnershipToReceiver(f.registry, "missing-task", f.record.ownerToken, receiver), /ownership missing/);
  assert.throws(() => migrateWorkerOwnershipToReceiver(f.registry, f.record.taskId, f.record.ownerToken, { ...receiver, workerPid: parent.pid }), /PID mismatch/);
  assert.throws(() => migrateWorkerOwnershipToReceiver(f.registry, f.record.taskId, f.record.ownerToken, { ...receiver, parentSessionId: "foreign-parent" }), /parent mismatch/);
  f.writeIdentity({ cwd: "/elsewhere" });
  assert.throws(() => migrateWorkerOwnershipToReceiver(f.registry, f.record.taskId, f.record.ownerToken, receiver), /receiver identity/);
  assert.equal(fs.readFileSync(f.registry, "utf8"), before, "failed migration must not alter registry");
  f.writeIdentity();
  const migrated = migrateWorkerOwnershipToReceiver(f.registry, f.record.taskId, f.record.ownerToken, {
    ...receiver, ownerToken: "not-allowed", itemKeys: ["not-allowed"], cwd: "/not-allowed",
  });
  assert.deepEqual(migrated, f.read());
  assert.equal(migrated.ownershipMode, "receiver");
  assert.equal(migrated.version, 2);
  assert.equal(migrated.ownerToken, f.record.ownerToken);
  assert.equal(migrated.workerPid, process.pid);
  assert.equal(migrated.ownerPid, process.pid);
  assert.equal(migrated.pid, process.pid);
  assert.equal(migrated.parentSessionId, receiver.parentSessionId);
  assert.equal(migrated.cwd, f.dir);
  assert.equal(migrated.receiverIdentityPath, receiver.receiverIdentityPath);
  assert.equal(migrated.heartbeatAt, f.identity.heartbeatAt);
  assert.deepEqual(migrated.itemKeys, ["mission:fixture", "123456"]);
  assert.deepEqual(migrated.itemIds, ["123456"]);
  assert.deepEqual(migrateWorkerOwnershipToReceiver(f.registry, f.record.taskId, f.record.ownerToken, receiver), migrated);
  registerWorkerOwnership(f.registry, { ...legacy, itemKeys: ["changed-by-parent"] });
  assert.deepEqual(f.read(), migrated, "same-token legacy register must not downgrade ownership");
  await stopParentFixture(parent);
  f.prune();
  assert.ok(f.read(), "migration must detach ownership from the original parent PID");
});

test("migration of legacy records without workerPid is supported but invalid/missing PID and stale identity are rejected", t => {
  const f = fixture(t);
  const { workerPid, ...legacy } = f.record;
  registerWorkerOwnership(f.registry, { ...legacy, ownershipMode: undefined });
  const receiver = { workerPid, receiverIdentityPath: f.record.receiverIdentityPath };
  assert.throws(() => migrateWorkerOwnershipToReceiver(f.registry, f.record.taskId, f.record.ownerToken, { ...receiver, workerPid: undefined }), /worker PID/);
  assert.throws(() => migrateWorkerOwnershipToReceiver(f.registry, f.record.taskId, f.record.ownerToken, { ...receiver, workerPid: workerPid + 1 }), /receiver identity/);
  f.writeIdentity({ heartbeatAt: new Date(Date.now() - 100000).toISOString() });
  assert.throws(() => migrateWorkerOwnershipToReceiver(f.registry, f.record.taskId, f.record.ownerToken, receiver), /receiver identity/);
  f.writeIdentity();
  assert.equal(migrateWorkerOwnershipToReceiver(f.registry, f.record.taskId, f.record.ownerToken, receiver).workerPid, workerPid);
  f.writeIdentity({ heartbeatAt: new Date(Date.now() - 100000).toISOString() });
  assert.throws(() => migrateWorkerOwnershipToReceiver(f.registry, f.record.taskId, f.record.ownerToken, receiver), /ownership missing/, "migration must not recreate a pruned receiver reservation");
});

test("legacy pruning and heartbeat behavior remains unchanged", async t => {
  const f = fixture(t);
  const parent = await startParentFixture(t);
  registerWorkerOwnership(f.registry, { ...f.record, ownershipMode: undefined, ownerPid: parent.pid });
  // Legacy ownership is still tied to its owner, not workerPid/identity.
  await stopParentFixture(parent);
  f.prune();
  assert.equal(f.read(), undefined);
  registerWorkerOwnership(f.registry, { ...f.record, ownershipMode: undefined });
  let data = readWorkerOwnershipRegistry(f.registry);
  data.workers[f.record.taskId].heartbeatAt = new Date(Date.now() - 100000).toISOString();
  fs.writeFileSync(f.registry, JSON.stringify(data));
  f.prune();
  assert.ok(f.read(), "legacy retains the original 120s freshness window");
  heartbeatWorkerOwnerships(f.registry, [[f.record.taskId, f.record.ownerToken]]);
  assert.ok(Date.parse(f.read().heartbeatAt) > Date.now() - 5000);
  data = readWorkerOwnershipRegistry(f.registry);
  data.workers[f.record.taskId].heartbeatAt = new Date(Date.now() - 130000).toISOString();
  fs.writeFileSync(f.registry, JSON.stringify(data));
  f.prune();
  assert.equal(f.read(), undefined);
});

test("concurrent migrations/registrations cannot lose records, tokens or keys", async t => {
  const f = fixture(t);
  registerWorkerOwnership(f.registry, { ...f.record, ownershipMode: undefined });
  const migrateCode = `import { migrateWorkerOwnershipToReceiver } from ${JSON.stringify(moduleUrl)};
    const record = migrateWorkerOwnershipToReceiver(process.env.REGISTRY, 'task-fixture', 'fixture-token', {
      workerPid: Number(process.env.PID), parentSessionId: 'fixture-parent', receiverIdentityPath: process.env.IDENTITY,
    });
    if (record.ownerToken !== 'fixture-token' || record.itemKeys.length !== 3) throw new Error('lost lease');`;
  const registerCode = `import { registerWorkerOwnership } from ${JSON.stringify(moduleUrl)};
    registerWorkerOwnership(process.env.REGISTRY, { taskId: 'other-' + process.env.INDEX, ownerPid: Number(process.env.PID),
      ownerToken: 'other-' + process.env.INDEX, cwd: process.env.CWD, itemKeys: [] });`;
  const env = { REGISTRY: f.registry, IDENTITY: f.record.receiverIdentityPath, PID: String(process.pid), CWD: f.dir };
  await Promise.all(Array.from({ length: 8 }, (_, index) => runModule(index % 2 ? migrateCode : registerCode, { ...env, INDEX: String(index) })));
  const workers = readWorkerOwnershipRegistry(f.registry).workers;
  assert.equal(Object.keys(workers).length, 5);
  assert.equal(workers[f.record.taskId].ownershipMode, "receiver");
  assert.equal(workers[f.record.taskId].ownerToken, f.record.ownerToken);
  assert.deepEqual(workers[f.record.taskId].itemKeys, f.record.itemKeys);
  assert.equal(fs.existsSync(`${f.registry}.lock`), false);
  if (process.platform !== "win32") assert.equal(fs.statSync(f.registry).mode & 0o777, 0o600);
});
