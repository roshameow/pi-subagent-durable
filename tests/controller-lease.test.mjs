import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { after, test } from "node:test";
import {
  acquireControllerLease, renewControllerLease, releaseControllerLease,
  assertControllerLease, readControllerLeaseRegistry, withControllerLease,
  CONTROLLER_LEASE_RENEW_INTERVAL_MS, CONTROLLER_LEASE_TTL_MS,
} from "../extensions/controller-lease.mjs";

// Reproduce with: node --test tests/controller-lease.test.mjs
// Verified pitfalls are kept as regressions here:
// deleting tombstones resets fencing/parent binding; TTL-based lock eviction can
// admit two writers; stale reapers must never unlink a successor's unique owner.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-controller-lease-test-"));
const moduleUrl = new URL("../extensions/controller-lease.mjs", import.meta.url).href;
const activeChildren = new Set();
const registry = (name) => path.join(dir, `${name}.json`);
const identity = (taskId = "task-a") => ({
  taskId, parentSessionId: "parent-exact", ownerPid: process.pid, controllerToken: randomUUID(),
});
const at = (nowMs) => ({ nowMs });
const baseTime = Date.now();
const rejects = (fn, code) => assert.throws(fn, (error) => error.code === code);
const read = (file, taskId = "task-a") => readControllerLeaseRegistry(file).leases[taskId];

function childProgram(body) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import fs from 'node:fs';
    import { randomUUID } from 'node:crypto';
    import * as leases from ${JSON.stringify(moduleUrl)};
    process.on('message', async message => {
      if (message.type === 'stop') process.exit(0);
      if (message.type !== 'go') return;
      try { ${body} }
      catch (error) { process.send({ type: 'failure', code: error.code, message: error.message }); }
    });
    process.send({ type: 'ready' });
  `], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  activeChildren.add(child);
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const messages = [];
  const waiters = [];
  child.on("message", (message) => {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(message); else messages.push(message);
  });
  child.on("error", (error) => { for (const waiter of waiters.splice(0)) waiter.reject(error); });
  child.on("exit", (code, signal) => {
    activeChildren.delete(child);
    for (const waiter of waiters.splice(0)) waiter.reject(new Error(`child exited ${code}/${signal}: ${stderr}`));
  });
  const next = () => messages.length ? Promise.resolve(messages.shift()) : new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`child message timed out: ${stderr}`)), 30000);
    waiters.push({ resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
  });
  return { child, next };
}

async function startChildren(count, body) {
  const children = Array.from({ length: count }, () => childProgram(body));
  assert.deepEqual(await Promise.all(children.map((child) => child.next())), Array.from({ length: count }, () => ({ type: "ready" })));
  return children;
}

async function stopChildren(children) {
  await Promise.all(children.map(async ({ child }) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = once(child, "close");
    child.send({ type: "stop" });
    await closed;
  }));
}

after(async () => {
  await Promise.all([...activeChildren].map(async (child) => {
    const closed = once(child, "close");
    child.kill("SIGKILL");
    await closed;
  }));
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(fs.existsSync(dir), false, "all disposable fixtures are removed, even after failure");
});

test("acquire, 15s renewal, assert and release preserve generation and exact parent", () => {
  const file = registry("lifecycle");
  assert.deepEqual(readControllerLeaseRegistry(file).leases, {});
  const input = identity();
  const first = acquireControllerLease(file, input, at(baseTime));
  assert.equal(first.generation, 1);
  assert.equal(first.heartbeatAt, new Date(baseTime).toISOString());
  assert.equal(CONTROLLER_LEASE_RENEW_INTERVAL_MS, 15000);
  assert.equal(CONTROLLER_LEASE_TTL_MS, 120000);
  assert.deepEqual(acquireControllerLease(file, input, at(baseTime + 10000)), first, "idempotent acquire is not a renewal");
  const contents = fs.readFileSync(file, "utf8");
  const snapshot = assertControllerLease(file, first, at(baseTime + 10000));
  assert.equal(fs.readFileSync(file, "utf8"), contents, "assert never rewrites the registry");
  snapshot.generation = 999;
  assert.equal(read(file).generation, 1, "returned records are detached snapshots");
  let renewed = first;
  for (let tick = 1; tick <= 20; tick++) {
    renewed = renewControllerLease(file, renewed, at(baseTime + tick * 15000));
    assert.equal(renewed.generation, 1);
    assert.equal(renewed.heartbeatAt, new Date(baseTime + tick * 15000).toISOString());
  }
  const tombstone = releaseControllerLease(file, renewed, at(baseTime + 300001));
  assert.equal(tombstone.generation, 1);
  assert.equal(tombstone.parentSessionId, input.parentSessionId);
  assert.ok(tombstone.releasedAt);
  assert.equal(read(file).controllerToken, input.controllerToken);
  assert.deepEqual(releaseControllerLease(file, renewed, at(baseTime + 300002)), tombstone, "release is idempotent");
  rejects(() => assertControllerLease(file, renewed, at(baseTime + 300002)), "LEASE_RELEASED");
  rejects(() => renewControllerLease(file, renewed, at(baseTime + 300002)), "LEASE_RELEASED");
  const second = acquireControllerLease(file, input, at(baseTime + 300003));
  assert.equal(second.generation, 2, "even reusing the token/pid needs a new fenced epoch");
  assert.equal(second.releasedAt, undefined);
  for (const operation of [renewControllerLease, releaseControllerLease, assertControllerLease]) {
    rejects(() => operation(file, renewed, at(baseTime + 300003)), "GENERATION_MISMATCH");
  }
  assert.deepEqual(read(file), second);
});

test("live fresh claims reject wrong token, generation, parent or ownerPid without writes", async () => {
  const file = registry("credentials");
  const input = identity();
  const lease = acquireControllerLease(file, input, at(baseTime));
  const [other] = await startChildren(1, "process.send({ type: 'unused' });");
  try {
    const contents = fs.readFileSync(file, "utf8");
    const variants = [
      [{ controllerToken: randomUUID() }, "TOKEN_MISMATCH"],
      [{ generation: 2 }, "GENERATION_MISMATCH"],
      [{ parentSessionId: "parent-exact-suffix" }, "PARENT_MISMATCH"],
      [{ parentSessionId: " parent-exact" }, "PARENT_MISMATCH"],
      [{ ownerPid: other.child.pid }, "PID_MISMATCH"],
    ];
    for (const [override, code] of variants) {
      for (const operation of [acquireControllerLease, renewControllerLease, releaseControllerLease, assertControllerLease]) {
        rejects(() => operation(file, { ...lease, ...override }, at(baseTime + 1)), code);
        assert.equal(fs.readFileSync(file, "utf8"), contents);
      }
    }
    for (const operation of [renewControllerLease, releaseControllerLease, assertControllerLease]) {
      const { generation, ...withoutGeneration } = lease;
      rejects(() => operation(file, withoutGeneration), "INVALID_GENERATION");
      rejects(() => operation(file, { ...lease, taskId: "missing" }), "LEASE_MISSING");
    }
  } finally { await stopChildren([other]); }
});

test("TTL boundary permits same-parent takeover but cannot revive an expired epoch", () => {
  const file = registry("expiry");
  const first = acquireControllerLease(file, identity(), at(baseTime));
  assertControllerLease(file, first, at(baseTime + 119999));
  for (const operation of [assertControllerLease, renewControllerLease]) {
    rejects(() => operation(file, first, at(baseTime + 120000)), "LEASE_EXPIRED");
  }
  const wrongParent = { ...identity(), parentSessionId: "other-parent" };
  rejects(() => acquireControllerLease(file, wrongParent, at(baseTime + 120000)), "PARENT_MISMATCH");
  const second = acquireControllerLease(file, identity(), at(baseTime + 120000));
  assert.equal(second.generation, 2);
  for (const operation of [assertControllerLease, renewControllerLease, releaseControllerLease, acquireControllerLease]) {
    rejects(() => operation(file, first, at(baseTime + 120001)), "GENERATION_MISMATCH");
  }
  releaseControllerLease(file, second, at(baseTime + 240001)); // expired cleanup is safe
  rejects(() => acquireControllerLease(file, wrongParent, at(baseTime + 999999)), "PARENT_MISMATCH");
  assert.equal(read(file).generation, 2);
});

test("dead PID permits immediate fenced takeover, never a different parent", async () => {
  const file = registry("death");
  const [owner] = await startChildren(1, `
    const lease = leases.acquireControllerLease(message.file, {
      taskId: 'task-a', parentSessionId: 'parent-exact', ownerPid: process.pid,
      controllerToken: randomUUID()
    }, { nowMs: message.nowMs });
    process.send({ type: 'acquired', lease });
  `);
  owner.child.send({ type: "go", file, nowMs: baseTime });
  const response = await owner.next();
  assert.equal(response.type, "acquired");
  const first = response.lease;
  assertControllerLease(file, first, at(baseTime + 1));
  await stopChildren([owner]);
  for (const operation of [assertControllerLease, renewControllerLease]) {
    rejects(() => operation(file, first, at(baseTime + 1)), "OWNER_DEAD");
  }
  rejects(() => acquireControllerLease(file, { ...identity(), parentSessionId: "other-parent" }, at(baseTime + 1)), "PARENT_MISMATCH");
  rejects(() => acquireControllerLease(file, { ...first, taskId: "dead-new-task" }, at(baseTime + 1)), "OWNER_DEAD");
  const second = acquireControllerLease(file, identity(), at(baseTime + 1));
  assert.equal(second.generation, 2);
  assertControllerLease(file, second, at(baseTime + 1));
  rejects(() => releaseControllerLease(file, first, at(baseTime + 1)), "GENERATION_MISMATCH");
});

test("permission-denied PID probes do not allow takeover; unknown probe failures abort", () => {
  const file = registry("pid-probe");
  const lease = acquireControllerLease(file, identity(), at(baseTime));
  const contents = fs.readFileSync(file, "utf8");
  const kill = process.kill;
  process.kill = () => { throw Object.assign(new Error("permission denied"), { code: "EPERM" }); };
  try {
    assertControllerLease(file, lease, at(baseTime + 1));
    rejects(() => acquireControllerLease(file, identity(), at(baseTime + 1)), "TOKEN_MISMATCH");
    process.kill = () => { throw Object.assign(new Error("unknown PID probe failure"), { code: "EIO" }); };
    for (const operation of [acquireControllerLease, renewControllerLease, assertControllerLease]) {
      assert.throws(() => operation(file, lease, at(baseTime + 1)), /unknown PID probe failure/);
    }
    assert.equal(fs.readFileSync(file, "utf8"), contents);
  } finally { process.kill = kill; }
});

test("clock rollback fails closed and cannot lower an established heartbeat", () => {
  const file = registry("clock");
  const lease = acquireControllerLease(file, identity(), at(baseTime));
  const tolerance = renewControllerLease(file, lease, at(baseTime - 5000));
  assert.equal(tolerance.heartbeatAt, lease.heartbeatAt);
  for (const operation of [acquireControllerLease, renewControllerLease, assertControllerLease]) {
    rejects(() => operation(file, lease, at(baseTime - 5001)), "CLOCK_SKEW");
  }
});

test("invalid identities, corrupt schemas and generation overflow do not reset authority", () => {
  const file = registry("validation");
  for (const override of [
    { taskId: "" }, { parentSessionId: "" }, { ownerPid: 1 }, { ownerPid: "2" },
    { ownerPid: 2147483648 }, { controllerToken: "guessable" }, { generation: 0 },
    { generation: Number.MAX_SAFE_INTEGER + 1 },
  ]) rejects(() => acquireControllerLease(file, { ...identity(), ...override }), override.generation !== undefined ? "INVALID_GENERATION" : "INVALID_IDENTITY");
  assert.equal(fs.existsSync(file), false);
  const generated = acquireControllerLease(file, { taskId: "generated", parentSessionId: "parent-exact", ownerPid: process.pid });
  assert.match(generated.controllerToken, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
  const another = acquireControllerLease(file, { taskId: "generated-two", parentSessionId: "parent-exact", ownerPid: process.pid });
  assert.notEqual(generated.controllerToken, another.controllerToken);
  const normal = acquireControllerLease(file, identity(), at(baseTime));
  for (const value of ["{", "null", JSON.stringify({ version: 2, leases: {} }), JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), leases: [] }),
    JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), leases: { "task-a": { ...normal, parentSessionId: "" } } }),
    JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), leases: { "task-a": { ...normal, heartbeatAt: "invalid" } } }),
  ]) {
    fs.writeFileSync(file, value);
    rejects(() => readControllerLeaseRegistry(file), "INVALID_REGISTRY");
    rejects(() => acquireControllerLease(file, identity()), "INVALID_REGISTRY");
    assert.equal(fs.readFileSync(file, "utf8"), value);
    assert.equal(fs.existsSync(`${file}.lock`), false);
  }
  fs.writeFileSync(file, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), leases: {
    "task-a": { ...normal, generation: Number.MAX_SAFE_INTEGER, releasedAt: normal.heartbeatAt },
  } }));
  rejects(() => acquireControllerLease(file, identity()), "GENERATION_EXHAUSTED");
  assert.equal(read(file).generation, Number.MAX_SAFE_INTEGER);
  rejects(() => acquireControllerLease(registry("invalid-now"), identity(), at(NaN)), "INVALID_CLOCK");
  rejects(() => acquireControllerLease(registry("invalid-timeout"), identity(), { timeoutMs: -1 }), "INVALID_TIMEOUT");
});

test("special task IDs stay ordinary own keys; files and new directories are private", () => {
  const parent = path.join(dir, "permissions");
  fs.mkdirSync(parent, { mode: 0o755 });
  const before = fs.statSync(parent).mode;
  const file = path.join(parent, "registry.json");
  for (const taskId of ["__proto__", "constructor", "toString"]) {
    const lease = acquireControllerLease(file, identity(taskId));
    assert.equal(lease.generation, 1);
    assertControllerLease(file, lease);
    assert.ok(Object.hasOwn(readControllerLeaseRegistry(file).leases, taskId));
  }
  assert.equal(Object.keys(readControllerLeaseRegistry(file).leases).length, 3);
  assert.equal(fs.statSync(parent).mode, before, "existing project directories are not chmodded");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const nested = path.join(dir, "new-private", "registry.json");
  acquireControllerLease(nested, identity());
  assert.equal(fs.statSync(path.dirname(nested)).mode & 0o777, 0o700);
});

test("12 live competing processes admit exactly one controller", async () => {
  const file = registry("competing");
  const children = await startChildren(12, `
    try {
      const lease = leases.acquireControllerLease(message.file, {
        taskId: 'task-a', parentSessionId: 'parent-exact', ownerPid: process.pid,
        controllerToken: randomUUID()
      });
      process.send({ type: 'acquired', lease });
    } catch (error) { process.send({ type: 'rejected', code: error.code }); }
  `);
  try {
    for (const { child } of children) child.send({ type: "go", file });
    const results = await Promise.all(children.map((child) => child.next()));
    const winners = results.filter((result) => result.type === "acquired");
    assert.equal(winners.length, 1);
    assert.equal(results.filter((result) => result.type === "rejected" && result.code === "TOKEN_MISMATCH").length, 11);
    assert.deepEqual(read(file), winners[0].lease);
    assert.equal(read(file).generation, 1);
    assertControllerLease(file, winners[0].lease);
    rejects(() => acquireControllerLease(file, { ...identity(), parentSessionId: "wrong-parent" }), "PARENT_MISMATCH");
  } finally { await stopChildren(children); }
  assert.equal(activeChildren.size, 0);
});

test("expired takeover competition increments once and fences the old credentials", async () => {
  const file = registry("takeover-competing");
  const first = acquireControllerLease(file, identity(), at(baseTime));
  const children = await startChildren(8, `
    try {
      const lease = leases.acquireControllerLease(message.file, {
        taskId: 'task-a', parentSessionId: 'parent-exact', ownerPid: process.pid,
        controllerToken: randomUUID()
      }, { nowMs: message.nowMs });
      process.send({ type: 'acquired', lease });
    } catch (error) { process.send({ type: 'rejected', code: error.code }); }
  `);
  try {
    for (const { child } of children) child.send({ type: "go", file, nowMs: baseTime + 120000 });
    const results = await Promise.all(children.map((child) => child.next()));
    const winners = results.filter((result) => result.type === "acquired");
    assert.equal(winners.length, 1);
    assert.equal(winners[0].lease.generation, 2);
    assert.equal(results.filter((result) => result.code === "TOKEN_MISMATCH").length, 7);
    for (const operation of [renewControllerLease, releaseControllerLease, assertControllerLease]) {
      rejects(() => operation(file, first, at(baseTime + 120001)), "GENERATION_MISMATCH");
    }
    assert.deepEqual(read(file), winners[0].lease);
  } finally { await stopChildren(children); }
});

test("parallel independent tasks never lose records during atomic replace", async () => {
  const file = registry("many-tasks");
  const children = await startChildren(12, `
    for (let i = 0; i < 10; i++) {
      const lease = leases.acquireControllerLease(message.file, {
        taskId: 'task-' + message.index + '-' + i, parentSessionId: 'parent-exact',
        ownerPid: process.pid, controllerToken: randomUUID()
      }, { timeoutMs: 30000 });
      leases.renewControllerLease(message.file, lease, { timeoutMs: 30000 });
    }
    process.send({ type: 'done' });
  `);
  try {
    children.forEach(({ child }, index) => child.send({ type: "go", file, index }));
    assert.deepEqual(await Promise.all(children.map((child) => child.next())), Array.from({ length: 12 }, () => ({ type: "done" })));
    const records = Object.values(readControllerLeaseRegistry(file).leases);
    assert.equal(records.length, 120);
    assert.ok(records.every((record) => record.generation === 1));
  } finally { await stopChildren(children); }
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

test("commit fsyncs before/after atomic rename and cleans up a failed write", () => {
  const file = registry("commit-failure");
  const lease = acquireControllerLease(file, identity(), at(baseTime));
  const original = fs.readFileSync(file, "utf8");
  const rename = fs.renameSync;
  const sync = fs.fsyncSync;
  const events = [];
  let injectFailure = true;
  fs.fsyncSync = (fd) => {
    events.push(fs.fstatSync(fd).isDirectory() ? "sync-dir" : "sync-file");
    return sync(fd);
  };
  fs.renameSync = (source, target) => {
    if (target === file) {
      assert.equal(events.at(-1), "sync-file", "registry temporary file must be fsynced before rename");
      if (injectFailure) throw Object.assign(new Error("injected rename failure"), { code: "EIO" });
      events.push("registry-rename");
    }
    return rename(source, target);
  };
  try {
    assert.throws(() => renewControllerLease(file, lease, at(baseTime + 15000)), /injected rename failure/);
    assert.equal(fs.readFileSync(file, "utf8"), original);
    assert.equal(fs.existsSync(`${file}.lock`), false);
    assert.ok(!fs.readdirSync(dir).some((name) => name.startsWith("commit-failure.json.") && name.endsWith(".tmp")));
    injectFailure = false;
    const renewed = renewControllerLease(file, lease, at(baseTime + 15000));
    assert.equal(renewed.generation, 1);
    assert.equal(renewed.heartbeatAt, new Date(baseTime + 15000).toISOString());
    assert.equal(events.at(-2), "registry-rename");
    assert.equal(events.at(-1), "sync-dir", "rename must be followed by parent directory fsync");
  } finally {
    fs.renameSync = rename;
    fs.fsyncSync = sync;
  }
});

function fixtureLock(file, pid, token = randomUUID()) {
  const lockPath = `${file}.lock`;
  const ownerFile = `owner-${token}.json`;
  fs.mkdirSync(lockPath);
  fs.writeFileSync(path.join(lockPath, ownerFile), JSON.stringify({ pid, token }));
  return { lockPath, ownerFile };
}

test("old live lock owners cannot be evicted; dead and empty locks recover", async () => {
  const liveFile = registry("old-live-lock");
  const live = fixtureLock(liveFile, process.pid);
  const ancient = new Date(baseTime - 86400000);
  fs.utimesSync(live.lockPath, ancient, ancient);
  fs.utimesSync(path.join(live.lockPath, live.ownerFile), ancient, ancient);
  rejects(() => acquireControllerLease(liveFile, identity(), { timeoutMs: 30 }), "LOCK_TIMEOUT");
  assert.ok(fs.existsSync(path.join(live.lockPath, live.ownerFile)), "TTL is not a safe lock reclamation rule");
  fs.rmSync(live.lockPath, { recursive: true });
  const [dead] = await startChildren(1, "process.send({ type: 'unused' });");
  const deadPid = dead.child.pid;
  await stopChildren([dead]);
  const file = registry("dead-lock-race");
  fixtureLock(file, deadPid);
  const children = await startChildren(12, `
    const lease = leases.acquireControllerLease(message.file, {
      taskId: 'task-' + message.index, parentSessionId: 'parent-exact',
      ownerPid: process.pid, controllerToken: randomUUID()
    });
    process.send({ type: 'acquired', lease });
  `);
  try {
    children.forEach(({ child }, index) => child.send({ type: "go", file, index }));
    const results = await Promise.all(children.map((child) => child.next()));
    assert.ok(results.every((result) => result.type === "acquired"), JSON.stringify(results));
    assert.equal(Object.keys(readControllerLeaseRegistry(file).leases).length, 12, "concurrent dead-lock reapers cannot delete a successor lock");
  } finally { await stopChildren(children); }
  const emptyFile = registry("empty-lock");
  fs.mkdirSync(`${emptyFile}.lock`);
  assert.equal(acquireControllerLease(emptyFile, identity()).generation, 1);
  const malformedFile = registry("malformed-lock");
  fs.mkdirSync(`${malformedFile}.lock`);
  fs.writeFileSync(path.join(`${malformedFile}.lock`, "unknown-owner"), "bad");
  rejects(() => acquireControllerLease(malformedFile, identity(), { timeoutMs: 20 }), "LOCK_TIMEOUT");
  assert.ok(fs.existsSync(path.join(`${malformedFile}.lock`, "unknown-owner")), "unprovable ownership fails closed");
  fs.rmSync(`${malformedFile}.lock`, { recursive: true });
  assert.ok(fs.readdirSync(dir).every((name) => !name.endsWith(".tmp") && !name.endsWith(".lock")), "no lock/write temporary files leak");
});

// Checking authority and then writing without the lock admits a pause/takeover
// race. The guarded callback keeps the controller lock across the side effect.
test("guarded synchronous effects are fenced and execute while authority lock is held", () => {
  const file = registry("guarded");
  const lease = acquireControllerLease(file, identity());
  let effects = 0;
  assert.equal(withControllerLease(file, lease, () => {
    assert.ok(fs.existsSync(`${file}.lock`)); effects++; return 42;
  }), 42);
  releaseControllerLease(file, lease);
  const successor = acquireControllerLease(file, identity());
  assert.throws(() => withControllerLease(file, lease, () => { effects++; }), /mismatch/);
  assert.equal(effects, 1);
  assertControllerLease(file, successor);
  releaseControllerLease(file, successor);
});
