#!/usr/bin/env node
// Bootstrap for a parent already running an older extension. This does not load
// or reload Pi, does not send prompts, and never signals any worker.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { startReceiverKeeper } from "../extensions/receiver-keeper.mjs";
import { prepareUpgrade, publishUpgradeManifest } from "../extensions/upgrade-handoff-v2.mjs";
import { preserveMainNotifyIdentity } from "../extensions/main-notify-handoff.mjs";

const args = process.argv.slice(2);
let requestedSession, explicitParentPid, validArgs = true;
for (let i = 0; i < args.length; i += 2) {
  if (!args[i + 1]) { validArgs = false; break; }
  if (args[i] === "--session" && requestedSession === undefined) requestedSession = args[i + 1];
  else if (args[i] === "--parent-pid" && explicitParentPid === undefined && /^\d+$/.test(args[i + 1])) explicitParentPid = Number(args[i + 1]);
  else { validArgs = false; break; }
}
if (!validArgs || !requestedSession || (explicitParentPid !== undefined && (!Number.isInteger(explicitParentPid) || explicitParentPid < 2 || explicitParentPid > 2147483647))) {
  console.error("Usage: node scripts/prepare-upgrade.mjs --session /absolute/canonical-parent.jsonl [--parent-pid VERIFIED_LIVE_MAIN_PID]"); process.exitCode = 1;
} else {
  try {
    const parentSessionPath = fs.realpathSync(requestedSession);
    const fd = fs.openSync(parentSessionPath, "r"), buffer = Buffer.alloc(8192);
    let bytes; try { bytes = fs.readSync(fd, buffer, 0, buffer.length, 0); } finally { fs.closeSync(fd); }
    const header = JSON.parse(buffer.subarray(0, bytes).toString("utf8").split("\n")[0]);
    const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
    const notifyDir = process.env.PI_AGENT_NOTIFY_DIR || "/tmp/pi-agent-notify";
    // The legacy parent's runtime slot binds its PID to this canonical file.
    const runtimeDir = path.join(agentDir, "runtime");
    let runtimeFiles;
    try { runtimeFiles = fs.readdirSync(runtimeDir); } catch (error) { if (error.code !== "ENOENT") throw error; runtimeFiles = []; }
    const owners = runtimeFiles.flatMap(name => {
      try {
        const row = JSON.parse(fs.readFileSync(path.join(runtimeDir, name), "utf8"));
        if (row.type !== "pi_runtime" || fs.realpathSync(row.sessionPath) !== parentSessionPath) return [];
        process.kill(row.pid, 0); return [row];
      } catch { return []; }
    });
    if (owners.length > 1) throw new Error(`expected exactly one live canonical parent runtime, found ${owners.length}`);
    if (owners.length === 1 && explicitParentPid !== undefined && Number(owners[0].pid) !== explicitParentPid) throw new Error("explicit parent PID conflicts with the canonical runtime slot");
    if (owners.length === 0 && explicitParentPid === undefined) throw new Error("no live canonical parent runtime; after a failed reload, verify the exact main PID and supply --parent-pid (never guess it)");
    const parentPid = owners.length ? Number(owners[0].pid) : explicitParentPid;
    // Failed session_start can remove the old runtime slot before writing its
    // replacement. An explicit operator-verified PID may use the separately
    // validated fresh main-notify identity; it never overrides another runtime.
    const mainIdentityPath = preserveMainNotifyIdentity({
      notifyDir, notifyStateDir: process.env.PI_AGENT_NOTIFY_STATE_DIR || path.join(os.homedir(), ".pi", "agent", "agent-notify"),
      parentSessionId: header.id, parentSessionPath, parentPid, cwd: header.cwd,
    });
    if (!owners.length) console.log(`Verified exact main-notify registration for explicitly selected parent PID=${parentPid}; runtime slot was absent.`);
    const query = String(execFileSync("rmux", ["list-panes", "-a", "-F", "#{session_name}|#{window_name}|#{pane_dead}"], { timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }));
    const panes = query.trim().split("\n").filter(Boolean).map(line => {
      const parts = line.split("|"); if (parts.length !== 3 || !["0", "1"].includes(parts[2])) throw new Error("unrecognized RMUX pane response"); return parts;
    });
    const ps = String(execFileSync("ps", ["-axo", "command="], { timeout: 5000 }));
    const result = await prepareUpgrade({
      parentSessionId: header.id, parentSessionPath, cwd: header.cwd,
      ledgerDir: path.join(agentDir, "durable-tasks"), logDir: path.join(agentDir, "agent-logs"),
      sessionsRoot: path.join(agentDir, "sessions"), registryPath: path.join(notifyDir, ".active-workers.json"),
      notifyDir, expectedOwnerPid: parentPid,
      probe: async record => {
        const hit = panes.find(([session, window]) => session === "pi-agents" && window.endsWith(`-${record.taskId}`));
        if (hit) return { state: hit[2] === "1" ? "dead" : "live", rmuxTarget: `${hit[0]}:${hit[1]}.0` };
        const fallback = ps.split("\n").some(line => line.trim().startsWith(`pi-subagent-${record.taskId}`));
        return { state: fallback ? "live" : "dead" };
      },
    });
    const keeper = result.records.length ? await startReceiverKeeper({ ledgerDir: path.join(agentDir, "durable-tasks"), registryPath: path.join(notifyDir, ".active-workers.json") }) : null;
    publishUpgradeManifest(result, keeper);
    console.log(`Prepared ${result.records.length} existing async RMUX task(s). No worker was signaled or restarted.`);
    console.log(`Preserved exact main notification identity: ${mainIdentityPath}`);
    console.log("Stop dispatching work and exit only the idle original parent immediately; after installing the new code, restart with:");
    console.log(result.command);
    if (keeper) console.log(`Legacy receiver keeper PID=${keeper.pid}, bound until ${new Date(keeper.expiresAt).toISOString()}`);
    console.log("Use /agent:recover to inspect controller acquisition. taskId/runId/nonce/watcher lease were unchanged.");
  } catch (error) { console.error(`Prepare refused: ${error.message}. Do NOT exit the parent until preparation succeeds.`); process.exitCode = 1; }
}
