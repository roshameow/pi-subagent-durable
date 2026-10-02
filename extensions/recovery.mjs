import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { acquireControllerLease, renewControllerLease, releaseControllerLease, assertControllerLease, withControllerLease, readControllerLeaseRegistry } from "./controller-lease.mjs";

const SAFE_TASK = /^task-[a-z0-9]+-[a-z0-9]+$/i;
export function atomicRecoveryWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  const dir = fs.openSync(path.dirname(file), "r");
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
export function taskRecordPath(dir, taskId) {
  if (!SAFE_TASK.test(taskId)) throw new Error("unsafe durable task id");
  return path.join(dir, `${taskId}.json`);
}
export function readTaskRecords(dir, parentSessionId) {
  let names; try { names = fs.readdirSync(dir); } catch (e) { if (e.code === "ENOENT") return []; throw e; }
  return names.filter(n => SAFE_TASK.test(n.replace(/\.json$/, "")) && n.endsWith(".json")).map(n => {
    const record = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
    if (record.taskId !== n.slice(0, -5) || record.version !== 1) throw new Error(`invalid task ledger: ${n}`);
    return record;
  }).filter(r => r.parentSessionId === parentSessionId);
}
export function verifyCanonicalSession(file, id) {
  if (!file || !path.isAbsolute(file) || path.basename(file).includes("subagent-task")) throw new Error("a canonical absolute session path is required");
  const fd = fs.openSync(file, "r"); const buffer = Buffer.alloc(8192);
  let count; try { count = fs.readSync(fd, buffer, 0, buffer.length, 0); } finally { fs.closeSync(fd); }
  const header = JSON.parse(buffer.subarray(0, count).toString("utf8").split("\n")[0]);
  if (header.type !== "session" || header.id !== id) throw new Error("canonical session header/id mismatch");
  return fs.realpathSync(file);
}
export function resumeCommand(file, cwd) {
  const q = s => `'${s.replace(/'/g, "'\\''")}'`;
  return `cd ${q(cwd)} && pi --session ${q(file)}`;
}

// A failed RMUX query is UNKNOWN, never an exit. One successful all-pane snapshot
// can establish absence without relying on ambiguous 'target not found' errors.
export async function probeRmuxTask(command, record) {
  try {
    const result = await command("list-panes", "-a", "-F", "#{session_name}:#{window_name}.#{pane_index}|#{pane_dead}|#{pane_dead_status}");
    if (result.returnCode !== 0) return { state: "unknown", reason: "RMUX query failed" };
    const rows = String(result.stdout || "").trim().split("\n").filter(Boolean);
    if (rows.some(row => !/^.+\|[01]\|(?:-?\d+)?$/.test(row))) return { state: "unknown", reason: "unrecognized RMUX pane format" };
    const hit = rows.map(row => row.split("|")).find(parts => parts[0] === record.rmuxTarget);
    return hit ? { state: hit[1] === "1" ? "dead" : "live", exitCode: hit[2] === "" ? undefined : Number(hit[2]) } : { state: "dead" };
  } catch (error) { return { state: "unknown", reason: String(error) }; }
}

export function parseRecoveryResult(raw, taskId, exitCode) {
  let text = "", stopReason, errorMessage, lastLifecycle = "", terminal = false;
  for (const line of raw.split("\n")) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (["agent_start", "agent_end", "agent_settled"].includes(event.type)) lastLifecycle = event.type;
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const m = event.message;
      const value = (m.content || []).filter(p => p.type === "text").map(p => p.text).join("\n").trim();
      if (value) text = value;
      stopReason = m.stopReason; errorMessage = m.errorMessage;
    }
  }
  terminal = lastLifecycle === "agent_settled" || lastLifecycle === "agent_end";
  const interrupted = !terminal || stopReason === "error" || stopReason === "aborted" || (exitCode !== undefined && exitCode !== 0);
  return { resultId: `${taskId}:completion`, output: text, interrupted, exitCode: interrupted ? (exitCode || 1) : 0,
    summary: interrupted ? `interrupted: ${errorMessage || text || "process exited before terminal event"}` : text || "(no output)",
    timestamp: Date.now() };
}

// All side effects are fenced; callbacks never follow a later /new session.
// Disk outbox + parent-session markers provide at-least-once delivery. A crash
// between send and the marker may replay; the stable resultId identifies it.
export class RecoveryController {
  constructor(options) {
    this.options = options; this.leases = new Map(); this.records = new Map(); this.callbacks = new Map();
    this.timer = null; this.busy = false; this.closed = false;
    this.token = options.controllerToken || randomUUID();
  }
  claim(record) {
    if (record.parentSessionId !== this.options.parentSessionId || record.parentSessionPath !== this.options.parentSessionPath) throw new Error("task belongs to another parent session");
    const lease = acquireControllerLease(this.options.controllerRegistryPath, {
      taskId: record.taskId, parentSessionId: record.parentSessionId,
      ownerPid: this.options.ownerPid || process.pid, controllerToken: this.token,
    });
    this.leases.set(record.taskId, lease);
    return lease;
  }
  retainCallback(record) {
    if (record.parentSessionId !== this.options.parentSessionId || record.parentSessionPath !== this.options.parentSessionPath) throw new Error("callback belongs to another parent session");
    const ownerPid = this.options.ownerPid || process.pid;
    const current = readControllerLeaseRegistry(this.options.controllerRegistryPath).leases[record.taskId];
    if (current && !current.releasedAt && current.ownerPid !== ownerPid) throw new Error("existing callback has another controller owner");
    const lease = acquireControllerLease(this.options.controllerRegistryPath, {
      taskId: record.taskId, parentSessionId: record.parentSessionId, ownerPid,
      controllerToken: current && !current.releasedAt ? current.controllerToken : this.token,
    });
    this.leases.set(record.taskId, lease); this.callbacks.set(record.taskId, record);
    this.start(); return lease; // renew authority only; never install another completion monitor
  }
  fence(taskId) {
    const lease = this.leases.get(taskId);
    if (!lease) throw new Error(`no controller lease for ${taskId}`);
    assertControllerLease(this.options.controllerRegistryPath, lease);
    return lease;
  }
  guarded(taskId, operation) {
    const lease = this.leases.get(taskId);
    if (!lease) throw new Error(`no controller lease for ${taskId}`);
    return withControllerLease(this.options.controllerRegistryPath, lease, operation);
  }
  save(record) {
    this.guarded(record.taskId, () => atomicRecoveryWrite(taskRecordPath(this.options.ledgerDir, record.taskId), record));
    this.records.set(record.taskId, record);
  }
  track(record) {
    if (this.closed) throw new Error("controller is closed");
    this.claim(record); this.save({ version: 1, ...record }); this.start();
  }
  async recover() {
    if (this.closed) throw new Error("controller is closed");
    const report = [];
    for (const record of readTaskRecords(this.options.ledgerDir, this.options.parentSessionId)) {
      if (record.mode !== "async-rmux") { report.push(`${record.taskId}: unsupported execution mode`); continue; }
      if (record.deliveredAt || record.status === "stopped") continue;
      if (this.options.skipExistingCallback?.(record)) {
        try { this.retainCallback(record); report.push(`${record.taskId}: existing local completion callback retained`); }
        catch (e) { report.push(`${record.taskId}: ${e.message}`); }
        continue;
      }
      if (this.callbacks.has(record.taskId)) this.forget(record.taskId);
      try { this.claim(record); this.records.set(record.taskId, record); report.push(`${record.taskId}: controller acquired`); }
      catch (e) { report.push(`${record.taskId}: ${e.message}`); }
    }
    await this.tick(); this.start();
    for (const record of this.records.values())
      if (record.result && !record.deliveredAt) report.push(`${record.taskId}: completion persisted, delivery pending acknowledgment`);
    return report;
  }
  start() {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => void this.tick().catch(e => this.options.onError?.(e)), this.options.pollMs || 2000);
    this.timer.unref?.();
  }
  async tick() {
    if (this.busy || this.closed) return;
    this.busy = true;
    try {
      for (const [taskId, record] of this.callbacks) {
        try {
          if (!this.options.skipExistingCallback?.(record)) { this.forget(taskId); continue; }
          const lease = this.fence(taskId);
          if (Date.now() - Date.parse(lease.heartbeatAt) >= 15000)
            this.leases.set(taskId, renewControllerLease(this.options.controllerRegistryPath, lease));
        } catch (e) { this.options.onError?.(e, record); }
      }
      for (const [taskId, record] of this.records) {
        try {
          if (this.closed) break;
          this.fence(taskId);
          const lease = this.leases.get(taskId);
          if (Date.now() - Date.parse(lease.heartbeatAt) >= 15000)
            this.leases.set(taskId, renewControllerLease(this.options.controllerRegistryPath, lease));
          if (record.status === "stopped") { this.forget(taskId); continue; }
          if (!record.result) {
            const live = await this.options.probe(record);
            if (this.closed) break;
            this.fence(taskId); // await may have crossed a takeover/shutdown
            if (live.state === "unknown") { this.options.onUnknown?.(record, live); continue; }
            if (live.state === "live") { this.options.onLive?.(record); continue; }
            if (live.state !== "dead") throw new Error("invalid liveness result");
            let raw;
            try { raw = fs.readFileSync(record.logPath, "utf8"); }
            catch (e) { this.options.onUnknown?.(record, { state: "unknown", reason: `log unreadable: ${e.message}` }); continue; }
            record.result = parseRecoveryResult(raw, taskId, live.exitCode);
            record.status = "completed";
            this.save(record); // durable outbox precedes notification/cleanup
          }
          this.fence(taskId);
          if (!this.options.isAcknowledged?.(record.result.resultId)) {
            const accepted = await this.options.deliver(record, () => this.fence(taskId), operation => this.guarded(taskId, operation));
            if (accepted === false) continue; // queued but not yet persisted in the parent transcript
          }
          if (this.closed) break;
          this.fence(taskId);
          await this.options.acknowledge?.(record, () => this.fence(taskId), operation => this.guarded(taskId, operation));
          record.deliveredAt = new Date().toISOString(); this.save(record);
          await this.options.onCompleted?.(record, () => this.fence(taskId), operation => this.guarded(taskId, operation));
          this.forget(taskId);
        } catch (e) { this.options.onError?.(e, record); }
      }
    } finally { this.busy = false; }
  }
  forget(taskId) {
    const lease = this.leases.get(taskId);
    if (lease) releaseControllerLease(this.options.controllerRegistryPath, lease);
    this.leases.delete(taskId); this.records.delete(taskId); this.callbacks.delete(taskId);
  }
  stopTask(taskId) {
    const record = this.records.get(taskId);
    if (!record) return;
    record.status = "stopped"; this.save(record); this.forget(taskId);
  }
  close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer); this.timer = null;
    for (const taskId of [...this.leases.keys()]) this.forget(taskId);
  }
}
