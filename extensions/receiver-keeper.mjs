import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { heartbeatWorkerOwnerships, readWorkerOwnershipRegistry } from "./ownership-registry.mjs";
import { atomicRecoveryWrite } from "./recovery.mjs";

const alive = pid => { try { process.kill(pid, 0); return Number.isInteger(pid) && pid >= 2; } catch { return false; } };
// Old notify workers still gate registrationKeys on the registry heartbeat.
// A bounded, detached keeper mirrors fresh receiver identity into that legacy
// field while the main is offline. It does not send events or own controller/
// notification-wait leases, and never modifies taskId/runId/nonce or keys.
export async function startReceiverKeeper({ ledgerDir, registryPath, seconds = 86400 }) {
  if (!Number.isInteger(seconds) || seconds < 30 || seconds > 86400) throw new Error("receiver keeper bound must be 30..86400 seconds");
  fs.mkdirSync(ledgerDir, { recursive: true, mode: 0o700 });
  const marker = path.join(ledgerDir, ".receiver-keeper.json"), lock = `${marker}.start-lock`;
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (e) {
    if (e.code !== "EEXIST") throw e;
    try {
      const owner = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8"));
      if (!alive(owner.pid)) { fs.rmSync(lock, { recursive: true }); return startReceiverKeeper({ ledgerDir, registryPath, seconds }); }
    } catch {}
    throw new Error("receiver keeper startup is already in progress; retry");
  }
  try {
    atomicRecoveryWrite(path.join(lock, "owner.json"), { pid: process.pid });
    let previous; try { previous = JSON.parse(fs.readFileSync(marker, "utf8")); } catch {}
    if (previous && alive(previous.pid) && previous.expiresAt > Date.now()) {
      if (previous.registryPath !== registryPath) throw new Error("a live keeper for another notify registry already owns this ledger directory");
      // Do not borrow a PID-only liveness claim: an exiting keeper or a reused
      // PID is not a fresh handshake. Publish a new nonce/process below; the
      // previous keeper retires when it next observes that nonce change.
    }
    const nonce = randomUUID();
    const log = fs.openSync(path.join(ledgerDir, ".receiver-keeper.log"), "a", 0o600);
    let child;
    try { child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--run", ledgerDir, registryPath, nonce, String(seconds)], { detached: true, stdio: ["ignore", log, log] }); }
    finally { fs.closeSync(log); }
    child.unref();
    await new Promise((resolve, reject) => {
      child.once("error", reject); child.once("spawn", resolve);
    });
    // Bounded startup check only: never a foreground long-running watcher.
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      let value; try { value = JSON.parse(fs.readFileSync(marker, "utf8")); } catch {}
      if (value?.nonce === nonce && value.pid === child.pid && alive(value.pid)) return value;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error("receiver keeper did not publish its PID/nonce marker; prepare is not safe");
  } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

export function mirrorReceiverHeartbeats(ledgerDir, registryPath) {
  const registrations = readWorkerOwnershipRegistry(registryPath).workers;
  const tokens = new Map();
  for (const name of fs.readdirSync(ledgerDir).filter(n => /^task-[a-z0-9]+-[a-z0-9]+\.json$/i.test(n))) {
    const record = JSON.parse(fs.readFileSync(path.join(ledgerDir, name), "utf8"));
    if (record.ownershipMode !== "receiver" || record.deliveredAt || record.status === "stopped") continue;
    const reservation = registrations[record.taskId];
    if (reservation?.ownershipMode === "receiver" && reservation.ownerToken === record.ownershipToken)
      tokens.set(record.taskId, record.ownershipToken);
  }
  if (tokens.size) heartbeatWorkerOwnerships(registryPath, tokens);
  return tokens.size;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === "--run") {
  const [, , , ledgerDir, registryPath, nonce, bound] = process.argv;
  const marker = path.join(ledgerDir, ".receiver-keeper.json");
  process.title = "pi-receiver-keeper";
  atomicRecoveryWrite(marker, { pid: process.pid, nonce, registryPath, expiresAt: Date.now() + Number(bound) * 1000 });
  const tick = () => {
    try {
      const lease = JSON.parse(fs.readFileSync(marker, "utf8"));
      if (lease.nonce !== nonce || lease.pid !== process.pid || Date.now() >= lease.expiresAt) { clearInterval(timer); return; }
      if (!mirrorReceiverHeartbeats(ledgerDir, registryPath)) clearInterval(timer);
    } catch (e) {
      // Missing/corrupt authority must not leave an unbounded detached process.
      console.warn("receiver keeper:", e.message); clearInterval(timer);
    }
  };
  const timer = setInterval(tick, 15000); tick();
}
