import { spawn } from "node:child_process";

// Each command owns one detached client process group, NOT the shared RMUX
// daemon or worker pane. No SDK control socket is created or assumed here.
export class RmuxCommandScope {
  constructor({ executable = "rmux", timeoutMs = 10000, killGraceMs = 100, maxBytes = 8 * 1024 * 1024 } = {}) {
    Object.assign(this, { executable, timeoutMs, killGraceMs, maxBytes });
    this.pending = new Set(); this.closed = false;
  }
  run(args, { signal, timeoutMs = this.timeoutMs } = {}) {
    if (this.closed || signal?.aborted) return Promise.reject(new Error("RMUX command aborted"));
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, args, { detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "", size = 0, finished = false, cancelling = false, timer, escalation;
      const kill = sig => { if (!child.pid) return; try { process.kill(process.platform === "win32" ? child.pid : -child.pid, sig); } catch (e) { if (e.code !== "ESRCH") throw e; } };
      const finish = (error, code) => {
        if (finished) return; finished = true;
        clearTimeout(timer); clearTimeout(escalation); signal?.removeEventListener("abort", abort);
        this.pending.delete(cancel); child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
        error ? reject(error) : resolve({ returnCode: code ?? 1, stdout, stderr });
      };
      const cancel = (reason = "RMUX command aborted") => {
        if (finished || cancelling) return; cancelling = true; clearTimeout(timer);
        child.stdin?.destroy();
        try { kill("SIGTERM"); } catch {}
        // Do not clear this escalation on leader exit: descendants can hold
        // pipes (or ignore TERM) after the leader has already exited.
        escalation = setTimeout(() => {
          try { kill("SIGKILL"); } catch {}
          finish(new Error(reason));
        }, this.killGraceMs);
      };
      const abort = () => cancel(); this.pending.add(cancel);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) cancel();
      timer = setTimeout(() => cancel("RMUX command timed out"), timeoutMs);
      const consume = (which, chunk) => {
        size += chunk.length;
        if (size > this.maxBytes) { cancel("RMUX command output limit exceeded"); return; }
        if (which === "stdout") stdout += chunk; else stderr += chunk;
      };
      child.stdout.on("data", d => consume("stdout", d)); child.stderr.on("data", d => consume("stderr", d));
      child.on("error", e => { if (!cancelling) finish(e); });
      child.on("close", code => { if (!cancelling) finish(null, code); });
      child.stdin.on("error", () => {}); child.stdin.end();
    });
  }
  close() { this.closed = true; for (const cancel of this.pending) cancel("RMUX scope closed"); }
}
