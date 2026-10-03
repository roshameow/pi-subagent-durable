// Explicit capability, never infer old Pi from the absence of settled in a log.
export function lifecyclePolicy(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version || "");
  // Settled is documented by 0.99.1; unknown/custom hosts fail closed.
  return m && Number(m[1]) === 0 && Number(m[2]) < 99 ? "legacy-end" : "settled";
}
export function currentRunSettled(raw, policy = "settled") {
  let last = "", retry = false;
  for (const line of raw.split("\n")) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === "pi_subagent_task" && e.lifecyclePolicy) policy = e.lifecyclePolicy;
    if (e.type === "agent_start") { last = e.type; retry = false; }
    if (e.type === "agent_end") { last = e.type; retry = e.willRetry === true; }
    if (e.type === "agent_settled") { last = e.type; retry = false; }
    if (e.type === "auto_retry_start" || (e.type === "compaction_end" && e.willRetry)) { last = "retry"; retry = true; }
  }
  return last === "agent_settled" || (policy === "legacy-end" && last === "agent_end" && !retry);
}

// Reload keeps callback monitors, but quit/replacement detaches their resources
// without signaling durable workers. Owned CLI commands have a separate scope.
export class MonitorScope {
  constructor() { this.items = new Map(); }
  add(key, dispose) { this.items.set(key, dispose); }
  retire(key) { try { this.items.get(key)?.(); } finally { this.items.delete(key); } }
  close() {
    const errors = [];
    for (const key of [...this.items.keys()]) { try { this.retire(key); } catch (error) { errors.push(error); } }
    return errors; // one faulty disposer must not strand other referenced timers
  }
}
