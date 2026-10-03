import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const supervisor = fileURLToPath(new URL("./rmux-sync-v3.mjs", import.meta.url));
export function runRmuxSync(args, timeoutMs = 3000) {
  // -N prevents a read-only probe from starting (and therefore owning) a daemon.
  const output = execFileSync(process.execPath, [supervisor, JSON.stringify(["-N", ...args]), String(timeoutMs)], {
    stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs + 1500, killSignal: "SIGKILL", maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(String(output));
}
