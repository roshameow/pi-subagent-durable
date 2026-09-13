import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-parent-test-"));
const parent = path.join(dir, "parent.jsonl");
fs.writeFileSync(parent, "{}\n");
const oldParent = process.env.PI_SUBAGENT_PARENT_SESSION_FILE;
const oldWindow = process.env.PI_SUBAGENT_CONTEXT_WINDOW;
process.env.PI_SUBAGENT_PARENT_SESSION_FILE = parent;
process.env.PI_SUBAGENT_CONTEXT_WINDOW = "1000000";

try {
  const handlers = new Map();
  const extension = await import(pathToFileURL("/tmp/pi-subagent-durable-check/context-inherit.js"));
  extension.default({ on(name, handler) { handlers.set(name, handler); } });

  const header = { type: "session", id: "child" };
  const model = { contextWindow: 100 };
  handlers.get("session_start")({}, {
    model,
    sessionManager: { getHeader: () => header },
  });
  assert.equal(model.contextWindow, 1000000);
  assert.equal(header.parentSession, parent);

  const existing = { type: "session", parentSession: "/original/parent.jsonl" };
  handlers.get("session_start")({}, {
    model: { contextWindow: 100 },
    sessionManager: { getHeader: () => existing },
  });
  assert.equal(existing.parentSession, "/original/parent.jsonl");
} finally {
  if (oldParent === undefined) delete process.env.PI_SUBAGENT_PARENT_SESSION_FILE;
  else process.env.PI_SUBAGENT_PARENT_SESSION_FILE = oldParent;
  if (oldWindow === undefined) delete process.env.PI_SUBAGENT_CONTEXT_WINDOW;
  else process.env.PI_SUBAGENT_CONTEXT_WINDOW = oldWindow;
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("OK: child session receives standard parentSession lineage before first flush");
