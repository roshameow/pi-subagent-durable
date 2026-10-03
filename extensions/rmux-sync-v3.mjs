// Supervisor for synchronous discovery callers. The parent event loop cannot
// await a signal here; this private process still bounds/cancels the CLI group.
import { RmuxCommandScope } from "./rmux-command-v3.mjs";
const scope = new RmuxCommandScope({ timeoutMs: Number(process.argv[3]) || 3000 });
process.on("SIGTERM", () => scope.close());
process.on("SIGHUP", () => scope.close());
try {
  const result = await scope.run(JSON.parse(process.argv[2]));
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stdout.write(JSON.stringify({ returnCode: 1, stdout: "", stderr: String(error.message || error) }));
} finally { scope.close(); }
