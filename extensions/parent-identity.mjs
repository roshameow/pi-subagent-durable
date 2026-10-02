import fs from "node:fs";
import path from "node:path";
import { readMainNotifyIdentity } from "./main-notify-handoff.mjs";

// Automatic, read-only identity resolution for every persistent main session.
// Runtime is corroborating evidence, not a fragile prerequisite: a failed reload
// may leave it absent. Exact live notify identity remains mandatory in all cases.
export function resolveParentIdentity(options) {
  const main = readMainNotifyIdentity(options);
  const runtimeDir = path.join(options.agentDir, "runtime");
  let names;
  try { names = fs.readdirSync(runtimeDir); }
  catch (error) { if (error.code !== "ENOENT") throw error; names = []; }
  const matchingPids = new Set();
  for (const name of names) {
    if (!/^\d+\.jsonl$/.test(name)) continue;
    let row, canonical;
    try {
      row = JSON.parse(fs.readFileSync(path.join(runtimeDir, name), "utf8"));
      if (row.type !== "pi_runtime" || !Number.isInteger(row.pid) || row.pid < 2
        || Number(name.slice(0, -6)) !== row.pid || typeof row.sessionPath !== "string") continue;
      try { process.kill(row.pid, 0); }
      catch (error) { if (error.code === "ESRCH") continue; throw error; }
      canonical = fs.realpathSync(row.sessionPath);
    } catch (error) {
      if (error.code === "EPERM") throw error; // Unknown liveness is not death.
      continue; // Missing/partial legacy slots are not verified identity.
    }
    if (row.pid === main.pid && (canonical !== main.sessionFile || (row.cwd && path.resolve(row.cwd) !== main.cwd))) {
      throw new Error("live main runtime is bound to a different canonical session/cwd");
    }
    if (canonical === main.sessionFile) matchingPids.add(row.pid);
  }
  if (matchingPids.size > 1) throw new Error("multiple live runtimes claim this canonical parent session");
  if (matchingPids.size === 1 && !matchingPids.has(main.pid)) throw new Error("canonical runtime conflicts with the exact main-notify identity");
  // Close the read/check race before returning a PID to the mutation phase.
  const again = readMainNotifyIdentity({ ...options, parentPid: main.pid });
  if (again.runId !== main.runId || again.nonce !== main.nonce) throw new Error("main identity changed during automatic resolution");
  return { parentPid: main.pid, parentSessionPath: main.sessionFile, cwd: main.cwd, source: matchingPids.size ? "runtime+notify" : "notify" };
}
