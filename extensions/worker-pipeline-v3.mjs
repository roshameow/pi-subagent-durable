// Capture the worker's status, not only the last pipeline/filter status. The
// marker is an ordinary JSONL event and survives slimming/mirror preservation.
export function workerPipelineCommand(worker, filter) {
  return `(${worker}; code=$?; printf '\\n{"type":"pi_subagent_exit","exitCode":%s}\\n' "$code"; exit "$code") 2>&1 | ${filter}`;
}
