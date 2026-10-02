import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { atomicRecoveryWrite } from "./recovery.mjs";

// One-time bootstrap for a legacy main which has a live registration but no
// durable notify identity. Never rotate its nonce or overwrite another run.
export function preserveMainNotifyIdentity({ notifyDir, notifyStateDir, parentSessionId, parentSessionPath, parentPid, cwd }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(parentSessionId) || !Number.isInteger(parentPid) || parentPid < 2) throw new Error("invalid main handoff identity");
  const canonical = fs.realpathSync(parentSessionPath);
  const fd = fs.openSync(canonical, "r"), buffer = Buffer.alloc(8192);
  let size; try { size = fs.readSync(fd, buffer, 0, buffer.length, 0); } finally { fs.closeSync(fd); }
  const header = JSON.parse(buffer.subarray(0, size).toString("utf8").split("\n")[0]);
  const absoluteCwd = path.resolve(cwd);
  if (header.type !== "session" || header.id !== parentSessionId || path.resolve(header.cwd || "") !== absoluteCwd) throw new Error("main notify handoff session header mismatch");
  const registrationPath = path.join(notifyDir, ".main-sessions", `${parentSessionId.slice(0, 160)}.json`);
  const raw = JSON.parse(fs.readFileSync(registrationPath, "utf8"));
  const heartbeat = typeof raw.heartbeatAt === "string" ? Date.parse(raw.heartbeatAt) : Number(raw.heartbeat);
  if (raw.sessionId !== parentSessionId || raw.targetKind !== "main" || raw.targetId !== parentSessionId || raw.pid !== parentPid
    || path.resolve(raw.cwd || "") !== absoluteCwd || !raw.sessionFile || fs.realpathSync(raw.sessionFile) !== canonical
    || !Number.isFinite(heartbeat) || Date.now() - heartbeat > 90000 || heartbeat > Date.now() + 5000
    || typeof raw.runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(raw.runId)
    || typeof raw.nonce !== "string" || raw.nonce.length < 16 || raw.nonce.length > 200 || /\s/.test(raw.nonce)) {
    throw new Error("main notify registration is stale or does not match the verified parent");
  }
  process.kill(parentPid, 0);
  const identityPath = path.join(notifyStateDir, "main-identities", `${createHash("sha256").update(parentSessionId).digest("hex").slice(0, 24)}.json`);
  let saved; try { saved = JSON.parse(fs.readFileSync(identityPath, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (saved && (saved.version !== 2 || saved.targetKind !== "main" || saved.targetId !== parentSessionId || saved.sessionId !== parentSessionId
    || saved.sessionFile !== canonical || saved.cwd !== absoluteCwd || saved.runId !== raw.runId || saved.nonce !== raw.nonce)) {
    throw new Error("existing durable main notification identity conflicts with the live parent; refusing to overwrite it");
  }
  // Legacy Pi is already the exclusive live registration for this session.
  // New receivers reject that live PID before acquiring their controller lock.
  // Concurrent bootstraps can only publish this same verified run identity.
  const again = JSON.parse(fs.readFileSync(registrationPath, "utf8"));
  if (again.pid !== parentPid || again.runId !== raw.runId || again.nonce !== raw.nonce) throw new Error("main notify registration changed during bootstrap");
  process.kill(parentPid, 0);
  atomicRecoveryWrite(identityPath, {
    version: 2, targetKind: "main", targetId: parentSessionId, sessionId: parentSessionId,
    sessionFile: canonical, cwd: absoluteCwd, runId: raw.runId, nonce: raw.nonce,
    updatedAt: new Date().toISOString(), offlineUntil: new Date(Date.now() + 86400000).toISOString(),
  });
  return identityPath;
}
