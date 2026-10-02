import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { resolveParentIdentity } from "../extensions/parent-identity.mjs";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-auto-parent-identity-")));
const agentDir = path.join(root, "agent"), notifyDir = path.join(root, "notify"), cwd = path.join(root, "same-workspace");
fs.mkdirSync(cwd); fs.mkdirSync(path.join(notifyDir, ".main-sessions"), { recursive: true });
const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
const ids = ["main-alpha", "main-beta"];
const sessions = ids.map(id => path.join(root, `${id}.jsonl`));
const pids = [process.pid, child.pid];
for (let i = 0; i < ids.length; i++) fs.writeFileSync(sessions[i], JSON.stringify({ type: "session", id: ids[i], cwd }) + "\n");
const registration = i => ({ version: 2, targetKind: "main", targetId: ids[i], sessionId: ids[i], cwd, sessionFile: sessions[i], pid: pids[i], heartbeatAt: new Date().toISOString(), runId: `run-${ids[i]}`, nonce: "0123456789abcdef0123456789abcdef" });
const saveMain = (i, overrides = {}) => fs.writeFileSync(path.join(notifyDir, ".main-sessions", `${ids[i]}.json`), JSON.stringify({ ...registration(i), ...overrides }));
const options = i => ({ agentDir, notifyDir, parentSessionId: ids[i], parentSessionPath: sessions[i], cwd });
const runtimeDir = path.join(agentDir, "runtime");
const saveRuntime = (pid, file, extra = {}) => fs.writeFileSync(path.join(runtimeDir, `${pid}.jsonl`), JSON.stringify({ type: "pi_runtime", pid, sessionPath: file, cwd, ...extra }) + "\n");
try {
  saveMain(0); saveMain(1);
  assert.equal(resolveParentIdentity(options(0)).parentPid, pids[0]);
  assert.equal(resolveParentIdentity(options(1)).parentPid, pids[1], "same-cwd sessions resolve their own exact live registration, never latest PID");
  assert.equal(resolveParentIdentity(options(0)).source, "notify", "missing runtime is repaired automatically from exact verified identity");
  fs.mkdirSync(runtimeDir, { recursive: true }); saveRuntime(pids[0], sessions[0]);
  assert.equal(resolveParentIdentity(options(0)).source, "runtime+notify");
  saveRuntime(pids[1], sessions[0]);
  assert.throws(() => resolveParentIdentity(options(0)), /multiple live runtimes/);
  fs.unlinkSync(path.join(runtimeDir, `${pids[0]}.jsonl`));
  assert.throws(() => resolveParentIdentity(options(0)), /conflicts with the exact/);
  fs.unlinkSync(path.join(runtimeDir, `${pids[1]}.jsonl`));
  saveRuntime(pids[0], sessions[1]);
  assert.throws(() => resolveParentIdentity(options(0)), /bound to a different canonical/);
  fs.unlinkSync(path.join(runtimeDir, `${pids[0]}.jsonl`));
  saveMain(0, { heartbeatAt: new Date(Date.now() - 120000).toISOString() });
  assert.throws(() => resolveParentIdentity(options(0)), /stale/);
  saveMain(0, { sessionFile: sessions[1] }); assert.throws(() => resolveParentIdentity(options(0)), /verified parent/);
  saveMain(0, { pid: 2147483647 }); assert.throws(() => resolveParentIdentity(options(0)));
  saveMain(0); const alias = path.join(root, "alias.jsonl"); fs.symlinkSync(sessions[0], alias);
  assert.equal(resolveParentIdentity({ ...options(0), parentSessionPath: alias }).parentSessionPath, sessions[0]);
  console.log("OK: automatic parent identity works across same-cwd sessions and missing runtimes; ambiguity, stale/dead identity and conflicting bindings fail closed");
} finally {
  if (child.exitCode === null) { child.kill(); await new Promise(resolve => child.once("exit", resolve)); }
  fs.rmSync(root, { recursive: true, force: true });
}
