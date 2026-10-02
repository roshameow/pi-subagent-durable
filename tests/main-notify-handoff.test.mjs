import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { preserveMainNotifyIdentity } from "../extensions/main-notify-handoff.mjs";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-main-notify-handoff-")));
const sid = "main-identity-test", cwd = path.join(root, "workspace"), session = path.join(root, "main.jsonl");
const notifyDir = path.join(root, "inbox"), notifyStateDir = path.join(root, "state");
fs.mkdirSync(cwd); fs.mkdirSync(path.join(notifyDir, ".main-sessions"), { recursive: true });
fs.writeFileSync(session, JSON.stringify({ type: "session", id: sid, cwd }) + "\n");
const registration = path.join(notifyDir, ".main-sessions", `${sid}.json`);
const original = { version: 2, targetKind: "main", targetId: sid, sessionId: sid, cwd, sessionFile: session, pid: process.pid, heartbeatAt: new Date().toISOString(), runId: "run-legacy-parent", nonce: "0123456789abcdef0123456789abcdef" };
const options = { notifyDir, notifyStateDir, parentSessionId: sid, parentSessionPath: session, parentPid: process.pid, cwd };
const save = (overrides = {}) => fs.writeFileSync(registration, JSON.stringify({ ...original, ...overrides }));
try {
  save(); const file = preserveMainNotifyIdentity(options);
  let stored = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(stored.runId, original.runId); assert.equal(stored.nonce, original.nonce);
  assert.equal(stored.sessionFile, fs.realpathSync(session)); assert(Date.parse(stored.offlineUntil) > Date.now());
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(preserveMainNotifyIdentity(options), file, "same verified parent may retry without rotating identity");
  const before = fs.readFileSync(file, "utf8");
  save({ nonce: "different0123456789abcdef" });
  assert.throws(() => preserveMainNotifyIdentity(options), /conflicts/);
  assert.equal(fs.readFileSync(file, "utf8"), before, "a conflicting run is never overwritten");
  save({ heartbeatAt: new Date(Date.now() - 120000).toISOString() });
  assert.throws(() => preserveMainNotifyIdentity(options), /stale/);
  save({ pid: 2147483647 }); assert.throws(() => preserveMainNotifyIdentity(options), /verified parent/);
  save({ sessionFile: path.join(root, "missing.jsonl") }); assert.throws(() => preserveMainNotifyIdentity(options));
  save(); const alias = path.join(root, "alias.jsonl"); fs.symlinkSync(session, alias);
  assert.equal(preserveMainNotifyIdentity({ ...options, parentSessionPath: alias }), file, "canonical aliases preserve the same session identity");
  console.log("OK: legacy bootstrap preserves exact main notify identity, rejects conflicts/staleness, and canonicalizes paths");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
