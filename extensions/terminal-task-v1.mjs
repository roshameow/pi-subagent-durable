// Task retirement is not model-turn settlement. Only authenticated, canonical
// terminal ledger records can inhibit renewal or authorize ghost reconciliation.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export function defaultLedgerDir() {
  return path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "durable-tasks");
}
export function readAuthenticatedTerminalTask(taskId, expected, ledgerDir = defaultLedgerDir()) {
  try {
    if (!/^task-[a-z0-9]+-[a-z0-9]+$/i.test(taskId) || !expected?.ownerToken) return null;
    const record = JSON.parse(fs.readFileSync(path.join(ledgerDir, `${taskId}.json`), "utf8"));
    if (record.version !== 1 || record.taskId !== taskId || record.ownershipToken !== expected.ownerToken
        || !["stopped", "completed"].includes(record.status) || record.mode !== "async-rmux"
        || typeof record.cwd !== "string" || path.resolve(record.cwd) !== path.resolve(expected.cwd || "")
        || !record.parentSessionId || !path.isAbsolute(record.parentSessionPath || "")
        || path.basename(record.parentSessionPath).includes("subagent-task")) return null;
    if (typeof record.rmuxTarget !== "string" || !record.rmuxTarget.startsWith("pi-agents:")
        || !record.rmuxTarget.replace(/\.\d+$/, "").endsWith(`-${taskId}`)) return null;
    const canonical = fs.realpathSync(record.parentSessionPath);
    if (canonical !== record.parentSessionPath) return null;
    const fd = fs.openSync(canonical, "r"), buf = Buffer.alloc(8192);
    let n; try { n = fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
    const header = JSON.parse(buf.subarray(0, n).toString("utf8").split("\n")[0]);
    if (header.type !== "session" || header.id !== record.parentSessionId
        || (expected.parentSessionId && expected.parentSessionId !== record.parentSessionId)
        || (expected.parentSessionPath && fs.realpathSync(expected.parentSessionPath) !== canonical)) return null;
    return record;
  } catch { return null; } // Missing/corrupt/foreign evidence never authorizes retirement.
}
// Registration must not bypass an immutable retired task ID by presenting a
// different token/cwd. This inhibits writes only; deletion still requires the
// caller's own token, parent, snapshots and notification checks.
export function readCanonicalTerminalTask(taskId, ledgerDir = defaultLedgerDir()) {
  try {
    if (!/^task-[a-z0-9]+-[a-z0-9]+$/i.test(taskId)) return null;
    const saved = JSON.parse(fs.readFileSync(path.join(ledgerDir, `${taskId}.json`), "utf8"));
    return readAuthenticatedTerminalTask(taskId, {
      ownerToken: saved.ownershipToken, cwd: saved.cwd,
      parentSessionId: saved.parentSessionId, parentSessionPath: saved.parentSessionPath,
    }, ledgerDir);
  } catch { return null; }
}
export function assertTaskReservationNotTerminal(record, options = {}) {
  if (readCanonicalTerminalTask(record.taskId, options.ledgerDir)) {
    throw new Error(`terminal task reservation cannot be registered/refreshed: ${record.taskId}`);
  }
}

// A corrupt receiver/wait file is ambiguous, not an absent receiver. Never
// mutate either file here; legitimate notification waits and handoffs survive.
export function notificationEvidenceBlocksRetirement(notifyDir, taskId, cwd, now = Date.now()) {
  for (const name of [".receiver-identity.json", ".notification-wait-lease"]) {
    const file = path.join(notifyDir, taskId, name);
    try {
      if (!fs.lstatSync(file).isFile()) return true;
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      if (value.version !== 2 || value.taskId !== taskId || typeof value.cwd !== "string"
          || path.resolve(value.cwd) !== path.resolve(cwd)) return true;
      if (name === ".notification-wait-lease") {
        if (!Number.isFinite(value.expiresAt)) return true;
        if (value.expiresAt > now) return true;
      } else {
        const time = Date.parse(value.heartbeatAt);
        if (!Number.isFinite(time) || !Number.isInteger(value.pid) || value.pid < 2) return true;
        if (now - time <= 90000) return true; // Includes future timestamps: fail closed.
      }
    } catch (error) { if (error.code !== "ENOENT") return true; }
  }
  return false;
}
