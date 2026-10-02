import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Callers renew every 15s; there is deliberately no background timer here.
export const CONTROLLER_LEASE_RENEW_INTERVAL_MS = 15000;
export const CONTROLLER_LEASE_TTL_MS = 120000;
const FUTURE_TOLERANCE_MS = 5000;
const DEFAULT_LOCK_TIMEOUT_MS = 5000;

function fail(code, message) {
  const error = new Error(`controller lease ${message}`);
  error.code = code;
  throw error;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    // EPERM means the process exists but cannot be signalled. An unknown
    // failure proves neither death nor liveness: abort without changing state.
    if (error?.code === "EPERM") return true;
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validToken(value) {
  // Supplied tokens MUST be cryptographically random (at least 128 bits).
  // Length checks reject trivial credentials; entropy cannot be inferred here.
  return typeof value === "string" && value.length >= 32 && value.length <= 512 && !/\s/.test(value);
}

function validateIdentity(identity, requireGeneration = true) {
  if (!identity || !nonempty(identity.taskId) || !nonempty(identity.parentSessionId) ||
      !Number.isInteger(identity.ownerPid) || identity.ownerPid < 2 || identity.ownerPid > 2147483647 || !validToken(identity.controllerToken)) {
    fail("INVALID_IDENTITY", "requires exact taskId/parentSessionId, ownerPid and a strong controllerToken");
  }
  if ((requireGeneration || identity.generation !== undefined) &&
      (!Number.isSafeInteger(identity.generation) || identity.generation < 1)) {
    fail("INVALID_GENERATION", "requires a positive safe integer generation");
  }
}

function nowMs(options) {
  const now = options.nowMs ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0 || now > 8640000000000000) fail("INVALID_CLOCK", "invalid nowMs");
  return now;
}

function timestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

// Only ENOENT is an empty registry. Never reset generations or parent bindings
// when JSON is corrupt, partially written, inaccessible or of an unknown version.
export function readControllerLeaseRegistry(registryPath) {
  let text;
  try { text = fs.readFileSync(registryPath, "utf8"); }
  catch (error) {
    if (error?.code === "ENOENT") return { version: 1, updatedAt: new Date(0).toISOString(), leases: {} };
    throw error;
  }
  let data;
  try { data = JSON.parse(text); }
  catch { fail("INVALID_REGISTRY", "registry contains invalid JSON"); }
  if (data?.version !== 1 || !timestamp(data.updatedAt) || !data.leases ||
      typeof data.leases !== "object" || Array.isArray(data.leases)) {
    fail("INVALID_REGISTRY", "registry has an invalid schema");
  }
  for (const [taskId, record] of Object.entries(data.leases)) {
    try { validateIdentity(record); }
    catch { fail("INVALID_REGISTRY", `registry has an invalid record for ${taskId}`); }
    if (record.taskId !== taskId || !timestamp(record.heartbeatAt) ||
        (record.releasedAt !== undefined && !timestamp(record.releasedAt))) {
      fail("INVALID_REGISTRY", `registry has an invalid record for ${taskId}`);
    }
  }
  return data;
}

function syncDir(dir) {
  const fd = fs.openSync(dir, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function writeSynced(file, value) {
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value), "utf8");
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

function atomicWriteJson(file, data) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeSynced(tmp, data);
    fs.renameSync(tmp, file);
    syncDir(path.dirname(file));
  } finally {
    try { fs.unlinkSync(tmp); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
}

// Publish a PREPOPULATED directory by rename: no empty/partial lock owner window.
// Unlike age-based unlink of a shared lock file, a paused live writer is never
// evicted. Dead-owner reapers unlink only the observed UUID file; a losing reaper
// cannot remove a successor's lock. Renaming over an empty, reaped directory is
// safe; renaming over a live nonempty directory fails atomically (POSIX).
function removeLockOwner(lockPath, ownerFile) {
  try { fs.unlinkSync(path.join(lockPath, ownerFile)); }
  catch (error) { if (error?.code === "ENOENT") return; throw error; }
  try { fs.rmdirSync(lockPath); }
  catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error?.code)) throw error;
  }
}

function reapDeadLock(lockPath) {
  try {
    const names = fs.readdirSync(lockPath);
    if (names.length !== 1 || !/^owner-[0-9a-f-]{36}\.json$/.test(names[0])) return;
    const owner = JSON.parse(fs.readFileSync(path.join(lockPath, names[0]), "utf8"));
    if (owner.token === names[0].slice(6, -5) && Number.isInteger(owner.pid) &&
        owner.pid >= 2 && owner.pid <= 2147483647 && !pidAlive(owner.pid)) {
      removeLockOwner(lockPath, names[0]);
    }
  } catch (error) {
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
}

function acquireLock(registryPath, timeoutMs = DEFAULT_LOCK_TIMEOUT_MS) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) fail("INVALID_TIMEOUT", "invalid timeoutMs");
  const dir = path.dirname(registryPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Do not chmod an existing caller-owned directory (possibly a project root).
  const lockPath = `${registryPath}.lock`;
  const token = randomUUID();
  const ownerFile = `owner-${token}.json`;
  const prepared = `${lockPath}.${process.pid}.${token}.tmp`;
  const deadline = performance.now() + timeoutMs;
  fs.mkdirSync(prepared, { mode: 0o700 });
  try {
    writeSynced(path.join(prepared, ownerFile), { pid: process.pid, token });
    syncDir(prepared);
    while (true) {
      try {
        fs.renameSync(prepared, lockPath);
        return { lockPath, ownerFile };
      } catch (error) {
        if (!["ENOTEMPTY", "EEXIST"].includes(error?.code)) throw error;
      }
      reapDeadLock(lockPath);
      if (performance.now() >= deadline) fail("LOCK_TIMEOUT", `timed out acquiring registry lock ${lockPath}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 + Math.floor(Math.random() * 15));
    }
  } finally {
    // After publication this path no longer exists. On errors remove only our
    // unpublished candidate, never a shared/new owner's lock directory.
    fs.rmSync(prepared, { recursive: true, force: true });
  }
}

function withRegistryLock(registryPath, options, mutate, fn) {
  const lock = acquireLock(registryPath, options.timeoutMs);
  try {
    const data = readControllerLeaseRegistry(registryPath);
    const now = nowMs(options);
    const result = fn(data, now);
    if (mutate) {
      data.updatedAt = new Date(now).toISOString();
      atomicWriteJson(registryPath, data);
    }
    return { ...result };
  } finally { removeLockOwner(lock.lockPath, lock.ownerFile); }
}

function currentRecord(data, identity) {
  return Object.hasOwn(data.leases, identity.taskId) ? data.leases[identity.taskId] : undefined;
}

function checkParent(current, identity) {
  if (current.parentSessionId !== identity.parentSessionId) {
    fail("PARENT_MISMATCH", `parentSessionId mismatch for ${identity.taskId}`);
  }
}

function checkCredentials(current, identity) {
  if (!current) fail("LEASE_MISSING", `missing for ${identity.taskId}`);
  checkParent(current, identity);
  if (current.generation !== identity.generation) fail("GENERATION_MISMATCH", `generation fencing mismatch for ${identity.taskId}`);
  if (current.controllerToken !== identity.controllerToken) fail("TOKEN_MISMATCH", `controllerToken mismatch for ${identity.taskId}`);
  if (current.ownerPid !== identity.ownerPid) fail("PID_MISMATCH", `ownerPid mismatch for ${identity.taskId}`);
}

function fresh(current, now) {
  const age = now - Date.parse(current.heartbeatAt);
  if (age < -FUTURE_TOLERANCE_MS) fail("CLOCK_SKEW", `heartbeatAt is in the future for ${current.taskId}`);
  return age < CONTROLLER_LEASE_TTL_MS;
}

function checkActive(current, now) {
  if (current.releasedAt !== undefined) fail("LEASE_RELEASED", `released for ${current.taskId}`);
  if (!pidAlive(current.ownerPid)) fail("OWNER_DEAD", `owner PID is dead for ${current.taskId}`);
  if (!fresh(current, now)) fail("LEASE_EXPIRED", `heartbeat expired for ${current.taskId}`);
}

/**
 * Synchronous, throws on conflicts; returns the persisted lease credentials.
 * Omit controllerToken to generate a UUID, or supply a crypto-random token.
 * options: { timeoutMs = 5000, nowMs = Date.now() } (nowMs is for clock tests).
 * A fresh identical acquire is idempotent, NOT a heartbeat. Every new ownership
 * epoch (dead/expired/released) increments generation, even with the same token.
 */
export function acquireControllerLease(registryPath, identity, options = {}) {
  const candidate = { ...identity, controllerToken: identity?.controllerToken ?? randomUUID() };
  validateIdentity(candidate, false);
  return withRegistryLock(registryPath, options, true, (data, now) => {
    const current = currentRecord(data, candidate);
    if (current) {
      // Parent binding survives expiration, death and explicit release forever.
      checkParent(current, candidate);
      if (candidate.generation !== undefined && candidate.generation !== current.generation) {
        fail("GENERATION_MISMATCH", `generation fencing mismatch for ${candidate.taskId}`);
      }
      if (current.releasedAt === undefined && pidAlive(current.ownerPid) && fresh(current, now)) {
        if (current.controllerToken !== candidate.controllerToken) fail("TOKEN_MISMATCH", `controllerToken mismatch for ${candidate.taskId}`);
        if (current.ownerPid !== candidate.ownerPid) fail("PID_MISMATCH", `ownerPid mismatch for ${candidate.taskId}`);
        return current;
      }
    }
    if (!pidAlive(candidate.ownerPid)) fail("OWNER_DEAD", `cannot acquire with dead owner PID for ${candidate.taskId}`);
    const generation = (current?.generation ?? 0) + 1;
    if (!Number.isSafeInteger(generation)) fail("GENERATION_EXHAUSTED", `generation exhausted for ${candidate.taskId}`);
    const record = {
      taskId: candidate.taskId, parentSessionId: candidate.parentSessionId,
      ownerPid: candidate.ownerPid, controllerToken: candidate.controllerToken,
      generation, heartbeatAt: new Date(now).toISOString(),
    };
    // Safe even for task IDs such as __proto__ and constructor.
    Object.defineProperty(data.leases, record.taskId, { value: record, enumerable: true, writable: true, configurable: true });
    return record;
  });
}

// Pass the complete acquired record, INCLUDING generation, to all operations.
export function renewControllerLease(registryPath, identity, options = {}) {
  validateIdentity(identity);
  return withRegistryLock(registryPath, options, true, (data, now) => {
    const current = currentRecord(data, identity);
    checkCredentials(current, identity);
    checkActive(current, now);
    current.heartbeatAt = new Date(Math.max(now, Date.parse(current.heartbeatAt))).toISOString();
    return current;
  });
}

// Authenticate/fence release too, but allow cleanup after heartbeat expiration.
// Never delete a record: removing it would reset its generation/parent binding.
export function releaseControllerLease(registryPath, identity, options = {}) {
  validateIdentity(identity);
  return withRegistryLock(registryPath, options, true, (data, now) => {
    const current = currentRecord(data, identity);
    checkCredentials(current, identity);
    current.releasedAt ??= new Date(now).toISOString();
    return current;
  });
}

// Read-only under the same lock. Call immediately before each management side
// effect; consumers must propagate generation for downstream fencing as well.
export function assertControllerLease(registryPath, identity, options = {}) {
  validateIdentity(identity);
  return withRegistryLock(registryPath, options, false, (data, now) => {
    const current = currentRecord(data, identity);
    checkCredentials(current, identity);
    checkActive(current, now);
    return current;
  });
}

/** Execute one synchronous side effect under the authority lock, preventing a
 * takeover between the fencing check and disk/session mutation. Never await or
 * acquire another controller lease inside the callback. */
export function withControllerLease(registryPath, identity, operation, options = {}) {
  validateIdentity(identity);
  return withRegistryLock(registryPath, options, false, (data, now) => {
    const current = currentRecord(data, identity);
    checkCredentials(current, identity);
    checkActive(current, now);
    const result = operation();
    if (result && typeof result.then === "function") fail("ASYNC_OPERATION", "controller guarded operations must be synchronous");
    return { result };
  }).result;
}
