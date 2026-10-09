import { readAuthenticatedTerminalTask, notificationEvidenceBlocksRetirement } from "./terminal-task-v1.mjs";
import { retireLegacyTerminalOwnership } from "./ownership-registry-v3.mjs";

// Both snapshots must be successful, bounded, and parseable. A main PID is not
// a worker PID: match only the exact durable process title, never arbitrary argv.
export function absentTaskInSnapshots(taskId, rmux, processes) {
  if (rmux?.returnCode !== 0 || processes?.returnCode !== 0
      || typeof rmux.stdout !== "string" || typeof processes.stdout !== "string") return false;
  for (const line of String(rmux.stdout || "").split("\n").filter(line => line.trim())) {
    const parts = line.trim().split("|");
    if (parts.length !== 2 || !/^.+:.+\.\d+$/.test(parts[0]) || !/^[01]$/.test(parts[1])) return false;
    if (parts[0].replace(/\.\d+$/, "").endsWith(`-${taskId}`)) return false;
  }
  for (const line of String(processes.stdout || "").split("\n").filter(line => line.trim())) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match) return false;
    const command = match[2].trim();
    if (command === `pi-subagent-${taskId}` || command.startsWith(`pi-subagent-${taskId} `)) return false;
  }
  return true;
}

export async function reconcileLegacyGhosts(options) {
  const { ownerships, ownerPid, parentSessionId, parentSessionPath, ledgerDir, notifyDir, registryPath } = options;
  if (!parentSessionId || !parentSessionPath || !Number.isInteger(ownerPid)) return [];
  const candidates = [];
  // Only locally held IDs, bounded ledger reads. No historical log scans.
  for (const [taskId, ownerToken] of ownerships) {
    const entry = options.tasks.get(taskId);
    if (!entry || entry.parentSessionId !== parentSessionId || !entry.cwd) continue;
    const expected = { ownerToken, ownerPid, parentSessionId, parentSessionPath, cwd: entry.cwd };
    const record = readAuthenticatedTerminalTask(taskId, expected, ledgerDir);
    if (!record || (record.status !== "stopped" && (!record.deliveredAt || record.retirementState !== "retired"))) continue;
    if (record.rmuxTarget !== entry.rmuxTarget || notificationEvidenceBlocksRetirement(notifyDir, taskId, expected.cwd)) continue;
    candidates.push({ taskId, expected });
  }
  if (!candidates.length) return [];
  let rmux, processes;
  const observedAt = Date.now();
  try { [rmux, processes] = await Promise.all([options.probeRmux(), options.probeProcesses()]); }
  catch { return []; }
  const retired = [];
  for (const { taskId, expected } of candidates) {
    if (!absentTaskInSnapshots(taskId, rmux, processes)) continue;
    try {
      const removed = retireLegacyTerminalOwnership(registryPath, taskId, expected, () => {
        const age = Date.now() - observedAt;
        if (age < 0 || age > 5000 || options.isCurrent?.() === false
            || ownerships.get(taskId) !== expected.ownerToken) return false;
        const entry = options.tasks.get(taskId);
        const record = readAuthenticatedTerminalTask(taskId, expected, ledgerDir);
        return Boolean(entry && entry.parentSessionId === parentSessionId && entry.cwd === expected.cwd
          && record && record.rmuxTarget === entry.rmuxTarget
          && (record.status === "stopped" || (record.deliveredAt && record.retirementState === "retired"))
          && !notificationEvidenceBlocksRetirement(notifyDir, taskId, expected.cwd));
      });
      if (removed === true || removed === "already_absent") { options.retireMemory(taskId); retired.push(taskId); }
    } catch (error) { options.onError?.(error, taskId); } // Retry next bounded tick/list/start.
  }
  return retired;
}

// Replace, don't inherit, a pre-upgrade closure that renews stopped ghosts.
export function replaceOwnershipHeartbeat(globals, tick, timers = globalThis) {
  if (globals.__pi_subagent_worker_heartbeat_timer__) timers.clearInterval(globals.__pi_subagent_worker_heartbeat_timer__);
  let busy = false;
  const timer = timers.setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await tick(); } finally { busy = false; }
  }, 15000);
  timer.unref?.();
  globals.__pi_subagent_worker_heartbeat_timer__ = timer;
  return timer;
}
