import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const STALE_LOCK_MS = 30000;
const RECEIVER_HEARTBEAT_MAX_AGE_MS = 90000;
const RECEIVER_HEARTBEAT_FUTURE_TOLERANCE_MS = 5000;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid < 2) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
}

function atomicWriteJson(file, value) {
  ensurePrivateDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(value), "utf8");
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
  try {
    const dirFd = fs.openSync(path.dirname(file), "r");
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch {}
}

function acquireLock(registryPath, timeoutMs = DEFAULT_LOCK_TIMEOUT_MS) {
  const lockPath = `${registryPath}.lock`;
  const deadline = Date.now() + timeoutMs;
  ensurePrivateDir(path.dirname(registryPath));
  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }), "utf8");
      fs.fsyncSync(fd);
      return { fd, lockPath };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let stale = false;
      try {
        const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        const age = Date.now() - Number(lock?.createdAt || fs.statSync(lockPath).mtimeMs);
        stale = age > STALE_LOCK_MS || !pidAlive(Number(lock?.pid));
      } catch {
        try { stale = Date.now() - fs.statSync(lockPath).mtimeMs > STALE_LOCK_MS; } catch { stale = true; }
      }
      if (stale) {
        try { fs.unlinkSync(lockPath); } catch {}
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`timed out acquiring worker registry lock ${lockPath}`);
      sleepSync(10 + Math.floor(Math.random() * 15));
    }
  }
}

function releaseLock(lock) {
  try { fs.closeSync(lock.fd); } catch {}
  try { fs.unlinkSync(lock.lockPath); } catch {}
}

function readRegistry(registryPath) {
  try {
    const value = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    if (value && typeof value === "object" && value.workers && typeof value.workers === "object") {
      return { version: 2, ...value, workers: { ...value.workers } };
    }
  } catch {}
  return { version: 2, updatedAt: new Date(0).toISOString(), workers: {} };
}

function normalizeKeys(record) {
  const keys = Array.isArray(record?.itemKeys) ? record.itemKeys.map(String) : [];
  const legacy = Array.isArray(record?.itemIds) ? record.itemIds.map(String) : [];
  return [...new Set([...keys, ...legacy])];
}

// Receiver identity, not a parent's registry heartbeat, proves ownership. Fail
// closed on missing/partial files, PID reuse with a different task, and bad clocks.
export function validateReceiverIdentity(record, options = {}) {
  try {
    if (typeof record?.taskId !== "string" || !record.taskId) throw new Error("missing task ID");
    if (typeof record.cwd !== "string" || !record.cwd || typeof record.receiverIdentityPath !== "string" || !record.receiverIdentityPath) throw new Error("missing cwd or identity path");
    const identity = JSON.parse(fs.readFileSync(record.receiverIdentityPath, "utf8"));
    const workerPid = record.workerPid ?? identity?.pid;
    if (!Number.isInteger(workerPid) || workerPid < 2 || identity?.version !== 2 || identity.taskId !== record.taskId || identity.pid !== workerPid) throw new Error("task, version or PID mismatch");
    if (typeof identity.cwd !== "string" || !identity.cwd || path.resolve(identity.cwd) !== path.resolve(record.cwd)) throw new Error("cwd mismatch");
    const heartbeat = typeof identity.heartbeatAt === "string" ? Date.parse(identity.heartbeatAt) : NaN;
    const age = (options.now ?? Date.now()) - heartbeat;
    if (!Number.isFinite(heartbeat) || !Number.isFinite(age) || age > RECEIVER_HEARTBEAT_MAX_AGE_MS || age < -RECEIVER_HEARTBEAT_FUTURE_TOLERANCE_MS) throw new Error("heartbeat expired or invalid");
    if (!pidAlive(workerPid)) throw new Error("receiver PID is not alive");
    return identity;
  } catch (error) {
    throw new Error(`invalid or stale receiver identity for ${record?.taskId}: ${error.message}`, { cause: error });
  }
}

function readLiveReceiverIdentity(record, taskId, now) {
  if (record?.taskId !== taskId || !Number.isInteger(record.workerPid)) return null;
  try { return validateReceiverIdentity(record, { now }); } catch { return null; }
}

function receiverOwnershipRecord(record) {
  if (!Number.isInteger(record.workerPid)) throw new Error(`invalid receiver worker PID for ${record.taskId}`);
  const identity = validateReceiverIdentity(record);
  return {
    ...record,
    version: 2,
    ownershipMode: "receiver",
    ownerPid: record.workerPid,
    pid: record.workerPid,
    heartbeatAt: identity.heartbeatAt,
  };
}

function pruneWorkers(data, isSettled) {
  const now = Date.now();
  for (const [taskId, record] of Object.entries(data.workers)) {
    if (record?.ownershipMode === "receiver") {
      if (isSettled?.(taskId) || !readLiveReceiverIdentity(record, taskId, now)) delete data.workers[taskId];
      continue;
    }
    const pid = Number(record?.ownerPid ?? record?.pid);
    const heartbeat = Date.parse(String(record?.heartbeatAt || record?.startedAt || ""));
    const heartbeatExpired = Number.isFinite(heartbeat) && now - heartbeat > 120000;
    if (isSettled?.(taskId) || !pidAlive(pid) || heartbeatExpired) delete data.workers[taskId];
  }
}

function withRegistryLock(registryPath, fn, options = {}) {
  const lock = acquireLock(registryPath, options.timeoutMs);
  try {
    const data = readRegistry(registryPath);
    pruneWorkers(data, options.isSettled);
    const result = fn(data);
    data.version = 2;
    data.updatedAt = new Date().toISOString();
    atomicWriteJson(registryPath, data);
    return result;
  } finally {
    releaseLock(lock);
  }
}

export function registerWorkerOwnership(registryPath, record, options = {}) {
  const itemKeys = normalizeKeys(record);
  return withRegistryLock(registryPath, (data) => {
    const current = data.workers[record.taskId];
    if (current && current.ownerToken && current.ownerToken !== record.ownerToken) {
      throw new Error(`worker ownership token mismatch for ${record.taskId}`);
    }
    // A parent from an older extension generation must not downgrade a receiver
    // reservation or replace its keys, PID, or identity path during /reload.
    if (current?.ownershipMode === "receiver" && record.ownershipMode !== "receiver") return current;
    const receiver = record.ownershipMode === "receiver" ? receiverOwnershipRecord(record) : null;
    const otherWorkers = Object.entries(data.workers).filter(([taskId]) => taskId !== record.taskId);
    const activeTaskIds = new Set(otherWorkers.map(([taskId]) => taskId));
    for (const taskId of options.externalActiveTaskIds || []) {
      if (taskId && taskId !== record.taskId) activeTaskIds.add(String(taskId));
    }
    const maxActiveWorkers = Number(options.maxActiveWorkers);
    if (
      Number.isInteger(maxActiveWorkers) &&
      maxActiveWorkers > 0 &&
      activeTaskIds.size >= maxActiveWorkers
    ) {
      throw new Error(
        `global subagent limit reached (${activeTaskIds.size}/${maxActiveWorkers}); ` +
        "stop existing workers before starting more or explicitly raise PI_SUBAGENT_MAX_ACTIVE",
      );
    }
    for (const [otherTaskId, other] of otherWorkers) {
      if (path.resolve(String(other?.cwd || "")) !== path.resolve(String(record.cwd || ""))) continue;
      const overlap = itemKeys.filter((key) => normalizeKeys(other).includes(key));
      if (overlap.length) throw new Error(`worker item collision: ${overlap.join(",")} already owned by ${otherTaskId}`);
    }
    data.workers[record.taskId] = {
      ...record,
      ...(receiver || {
        version: 2,
        ownerPid: Number(record.ownerPid ?? record.pid ?? process.pid),
        pid: Number(record.ownerPid ?? record.pid ?? process.pid),
        heartbeatAt: new Date().toISOString(),
      }),
      ownerToken: String(record.ownerToken),
      itemKeys,
      itemIds: itemKeys.filter((key) => /^\d{6}$/.test(key)),
    };
  }, options);
}

// Upgrade an existing reservation in the same transaction that authenticates
// its token and the receiver. This cannot recreate a missing/pruned reservation
// or use the transition to change the reserved keys or lease token.
export function migrateWorkerOwnershipToReceiver(registryPath, taskId, ownerToken, receiver, options = {}) {
  return withRegistryLock(registryPath, (data) => {
    const current = data.workers[taskId];
    if (!current) throw new Error(`worker ownership missing for ${taskId}`);
    if (!ownerToken || !current.ownerToken || current.ownerToken !== ownerToken) {
      throw new Error(`worker ownership token mismatch for ${taskId}`);
    }
    if (current.workerPid != null && current.workerPid !== receiver.workerPid) {
      throw new Error(`worker ownership PID mismatch for ${taskId}`);
    }
    if (current.parentSessionId && receiver.parentSessionId && current.parentSessionId !== receiver.parentSessionId) throw new Error(`worker ownership parent mismatch for ${taskId}`);
    const itemKeys = normalizeKeys(current);
    const migrated = receiverOwnershipRecord({
      ...current,
      ownershipMode: "receiver",
      workerPid: receiver.workerPid,
      receiverIdentityPath: receiver.receiverIdentityPath,
      parentSessionId: receiver.parentSessionId ?? current.parentSessionId,
      ownerToken: current.ownerToken,
      itemKeys,
      itemIds: itemKeys.filter((key) => /^\d{6}$/.test(key)),
    });
    data.workers[taskId] = migrated;
    return migrated;
  }, options);
}

export function unregisterWorkerOwnership(registryPath, taskId, ownerToken, options = {}) {
  return withRegistryLock(registryPath, (data) => {
    const current = data.workers[taskId];
    if (!current) return;
    if (ownerToken && current.ownerToken && current.ownerToken !== ownerToken) return;
    delete data.workers[taskId];
  }, options);
}

export function heartbeatWorkerOwnerships(registryPath, ownerships, options = {}) {
  return withRegistryLock(registryPath, (data) => {
    const now = new Date().toISOString();
    for (const [taskId, ownerToken] of ownerships) {
      const current = data.workers[taskId];
      if (!current || current.ownerToken !== ownerToken) continue;
      if (current.ownershipMode === "receiver") {
        const identity = readLiveReceiverIdentity(current, taskId, Date.now());
        if (identity) current.heartbeatAt = identity.heartbeatAt;
        else delete data.workers[taskId];
      } else {
        current.heartbeatAt = now;
      }
    }
  }, options);
}

export function readWorkerOwnershipRegistry(registryPath) {
  return readRegistry(registryPath);
}
