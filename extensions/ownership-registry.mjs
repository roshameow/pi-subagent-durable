import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const STALE_LOCK_MS = 30000;

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

function pruneWorkers(data, isSettled) {
  const now = Date.now();
  for (const [taskId, record] of Object.entries(data.workers)) {
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
    if (current && current.ownerToken && current.ownerToken !== record.ownerToken && pidAlive(Number(current.ownerPid ?? current.pid))) {
      throw new Error(`worker ownership token mismatch for ${record.taskId}`);
    }
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
      version: 2,
      ownerPid: Number(record.ownerPid ?? record.pid ?? process.pid),
      pid: Number(record.ownerPid ?? record.pid ?? process.pid),
      ownerToken: String(record.ownerToken),
      itemKeys,
      itemIds: itemKeys.filter((key) => /^\d{6}$/.test(key)),
      heartbeatAt: new Date().toISOString(),
    };
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
      if (current?.ownerToken === ownerToken) current.heartbeatAt = now;
    }
  }, options);
}

export function readWorkerOwnershipRegistry(registryPath) {
  return readRegistry(registryPath);
}
