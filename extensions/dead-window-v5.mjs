import { isRmuxWindowId } from "./window-binding-v4.mjs";

// Exact targets and stable daemon IDs; never accept a failed query as absence.
export const DEAD_FORMAT = "#{session_name}:#{window_name}.#{pane_index}|#{window_id}|#{pane_id}|#{pane_dead}";
async function snapshot(command) {
  const result = await command("list-panes", "-a", "-F", DEAD_FORMAT);
  if (result.returnCode !== 0) throw new Error("dead-window query failed");
  const panes = String(result.stdout || "").split("\n").filter(Boolean).map(line => {
    const [target, windowId, paneId, dead, ...extra] = line.split("|");
    if (extra.length || !isRmuxWindowId(windowId) || !/^%\d+$/.test(paneId) || !/^[01]$/.test(dead) || !/^.+:.+\.\d+$/.test(target)) throw new Error("unrecognized dead-window identity");
    return { target, windowId, paneId, dead: dead === "1" };
  });
  if (new Set(panes.map(p => p.target)).size !== panes.length || new Set(panes.map(p => p.paneId)).size !== panes.length)
    throw new Error("ambiguous dead-window identity");
  return panes;
}
const windowTarget = target => target.replace(/\.\d+$/, "");
const literal = s => s.replace(/#/g, "##").replace(/,/g, "#,").replace(/}/g, "#}");
const quote = s => `'${s.replace(/'/g, "'\\''")}'`;
export async function cleanupDeadWindowResult(command, record, fence = () => {}, guard = op => op(), persist = () => {}) {
  if (!record.rmuxTarget?.startsWith("pi-agents:") || !windowTarget(record.rmuxTarget).endsWith(record.taskId)) throw new Error("cleanup target/task mismatch");
  if (record.rmuxWindowId !== undefined && !isRmuxWindowId(record.rmuxWindowId)) throw new Error("unsafe recorded window identity: expected @digits, not a session selector");
  fence(); const first = await snapshot(command); fence();
  const hit = first.find(p => p.target === record.rmuxTarget);
  if (!hit) {
    // A renamed window with the recorded ID is not absence / permission to kill.
    if (first.some(p => windowTarget(p.target) === windowTarget(record.rmuxTarget) ||
        (record.rmuxWindowId && p.windowId === record.rmuxWindowId))) return { state: "retry" };
    return { state: "cleaned" };
  }
  if (record.rmuxWindowId && record.rmuxWindowId !== hit.windowId) return { state: "retry" };
  const panes = first.filter(p => p.windowId === hit.windowId);
  if (panes.some(p => !p.dead || windowTarget(p.target) !== windowTarget(record.rmuxTarget))) return { state: "retry" };
  if (record.requireRmuxIdentity && !record.rmuxWindowId) {
    // Permanent launch-metadata refusal, NOT proof of process death or cleanup.
    // Only an authoritative exact all-dead snapshot may produce this outcome.
    return { state: "blocked_manual", code: "missing_launch_identity",
      reason: "launch window identity unavailable; refusing inferred replacement" };
  }
  // Persist identity before mutation so crash/recovery cannot delete a replaced
  // window that later acquires the same name.
  if (record.rmuxWindowId !== hit.windowId) {
    record.rmuxWindowId = hit.windowId;
    persist(record);
  }
  const second = await snapshot(command); fence();
  const checked = second.filter(p => p.windowId === hit.windowId);
  if (JSON.stringify(checked) !== JSON.stringify(panes)) return { state: "retry" };
  // Daemon-side conditional rechecks every pane at mutation time. Unsupported
  // if-shell/format commands fail closed (cleanup_pending), never fallback to
  // an unconditional kill-window. Stable IDs prevent killing a reused name.
  let nested = `kill-window -t ${hit.windowId}`;
  for (const pane of panes) {
    const exact = `#{==:#{session_name}:#{window_name}.#{pane_index},${literal(pane.target)}}`;
    const deadIdentity = `#{&&:#{pane_dead},#{==:#{window_id},${hit.windowId}}}`;
    nested = `if-shell -F -t ${pane.paneId} ${quote(`#{&&:${deadIdentity},${exact}}`)} ${quote(nested)}`;
  }
  const count = `#{==:#{window_panes},${panes.length}}`;
  let operation;
  guard(() => { operation = command("if-shell", "-F", "-t", hit.windowId, count, nested); });
  const result = await operation;
  fence();
  if (result.returnCode !== 0) throw new Error("conditional dead-window cleanup failed/unsupported");
  // returnCode=0 can mean condition was false: confirm authoritative absence.
  const after = await snapshot(command); fence();
  return { state: after.some(p => p.windowId === hit.windowId || windowTarget(p.target) === windowTarget(record.rmuxTarget)) ? "retry" : "cleaned" };
}

// Boolean compatibility for non-recovery callers. Never treat a refusal object
// as truthy success; recovery consumes the explicit result above.
export async function cleanupDeadWindow(...args) {
  return (await cleanupDeadWindowResult(...args)).state === "cleaned";
}
