// Exact targets and stable daemon IDs; never accept a failed query as absence.
export const DEAD_FORMAT = "#{session_name}:#{window_name}.#{pane_index}|#{window_id}|#{pane_id}|#{pane_dead}";
async function snapshot(command) {
  const result = await command("list-panes", "-a", "-F", DEAD_FORMAT);
  if (result.returnCode !== 0) throw new Error("dead-window query failed");
  return String(result.stdout || "").split("\n").filter(Boolean).map(line => {
    const [target, windowId, paneId, dead, ...extra] = line.split("|");
    if (extra.length || !/^\$\d+$/.test(windowId) || !/^%\d+$/.test(paneId) || !/^[01]$/.test(dead) || !/^.+:.+\.\d+$/.test(target)) throw new Error("unrecognized dead-window identity");
    return { target, windowId, paneId, dead: dead === "1" };
  });
}
const windowTarget = target => target.replace(/\.\d+$/, "");
const literal = s => s.replace(/#/g, "##").replace(/,/g, "#,").replace(/}/g, "#}");
const quote = s => `'${s.replace(/'/g, "'\\''")}'`;
export async function cleanupDeadWindow(command, record, fence = () => {}, guard = op => op(), persist = () => {}) {
  if (!record.rmuxTarget?.startsWith("pi-agents:") || !windowTarget(record.rmuxTarget).endsWith(record.taskId)) throw new Error("cleanup target/task mismatch");
  fence(); const first = await snapshot(command); fence();
  const hit = first.find(p => p.target === record.rmuxTarget);
  if (!hit) {
    // A renamed window with the recorded ID is not absence / permission to kill.
    if (record.rmuxWindowId && first.some(p => p.windowId === record.rmuxWindowId)) return false;
    return true;
  }
  if (record.requireRmuxIdentity && !record.rmuxWindowId) {
    record.cleanupError = "launch window identity unavailable; refusing inferred replacement";
    return false;
  }
  if (record.rmuxWindowId && record.rmuxWindowId !== hit.windowId) return false;
  const panes = first.filter(p => p.windowId === hit.windowId);
  if (panes.some(p => !p.dead || windowTarget(p.target) !== windowTarget(record.rmuxTarget))) return false;
  // Persist identity before mutation so crash/recovery cannot delete a replaced
  // window that later acquires the same name.
  record.rmuxWindowId = hit.windowId;
  persist(record);
  const second = await snapshot(command); fence();
  const checked = second.filter(p => p.windowId === hit.windowId);
  if (JSON.stringify(checked) !== JSON.stringify(panes)) return false;
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
  return !after.some(p => p.windowId === hit.windowId || windowTarget(p.target) === windowTarget(record.rmuxTarget));
}
