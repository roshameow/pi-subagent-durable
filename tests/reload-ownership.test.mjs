import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { registerWorkerOwnership, refreshWorkerOwnership, readWorkerOwnershipRegistry } from "../extensions/ownership-registry-v2.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-reload-ownership-"));
const registry = path.join(root, "workers.json");
const cwd = path.join(root, "workspace");
try {
  registerWorkerOwnership(registry, { taskId: "task-original-aaaa", ownerPid: process.pid, ownerToken: "original-token", cwd, itemKeys: ["worker:task-original-aaaa", "131001"], startedAt: new Date().toISOString() });
  registerWorkerOwnership(registry, { taskId: "task-other-bbbb", ownerPid: process.pid, ownerToken: "other-token", cwd, itemKeys: ["worker:task-other-bbbb", "131002"] });
  const before = readWorkerOwnershipRegistry(registry).workers;
  const restored = refreshWorkerOwnership(registry, "task-original-aaaa", process.pid, "original-token");
  assert.deepEqual(restored.itemKeys, ["worker:task-original-aaaa", "131001"]);
  const after = readWorkerOwnershipRegistry(registry).workers;
  for (const field of ["itemKeys", "itemIds", "ownerToken", "ownerPid", "cwd", "startedAt"]) assert.deepEqual(after["task-original-aaaa"][field], before["task-original-aaaa"][field]);
  assert.deepEqual(after["task-other-bbbb"], before["task-other-bbbb"], "refresh must not touch the different live item owner");
  assert.throws(() => refreshWorkerOwnership(registry, "task-original-aaaa", process.pid, "wrong-token"), /token mismatch/);
  assert.throws(() => refreshWorkerOwnership(registry, "task-original-aaaa", 2147483647, "original-token"), /PID mismatch/);
  assert.equal(refreshWorkerOwnership(registry, "task-missing-cccc", process.pid, "missing-token"), null, "reload cannot infer/recreate missing ownership");

  // Reproduce the Node ESM cache boundary behind JITI's native .mjs imports.
  // Rewriting a canonical file cannot add exports to an already loaded namespace.
  const oldRegistry = path.join(root, "registry.mjs");
  const oldHandoff = path.join(root, "handoff.mjs");
  fs.writeFileSync(oldRegistry, "export const oldApi = true;\n");
  fs.writeFileSync(oldHandoff, "import * as r from './registry.mjs'; export const prepare=()=>r.validateReceiverIdentity();\n");
  const cached = await import(pathToFileURL(oldRegistry));
  const cachedHandoff = await import(pathToFileURL(oldHandoff));
  fs.writeFileSync(oldRegistry, "export const oldApi=true; export const validateReceiverIdentity=()=>true;\n");
  assert.equal((await import(pathToFileURL(oldRegistry))).validateReceiverIdentity, undefined);
  assert.equal(cached.validateReceiverIdentity, undefined);
  assert.throws(() => cachedHandoff.prepare(), /not a function/);
  fs.writeFileSync(path.join(root, "registry-v2.mjs"), "export const validateReceiverIdentity=()=>true;\n");
  fs.writeFileSync(path.join(root, "handoff-v2.mjs"), "import {validateReceiverIdentity} from './registry-v2.mjs';export const prepare=()=>validateReceiverIdentity();\n");
  assert.equal((await import(pathToFileURL(path.join(root, "handoff-v2.mjs")))).prepare(), true);
  // Use Pi's own transitive JITI with the loader's cache/native options. A new
  // TS factory still sees the old native .mjs namespace until its path changes.
  const sdkRequire = createRequire(new URL(import.meta.resolve("@earendil-works/pi-coding-agent")));
  const { createJiti } = sdkRequire("jiti");
  const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false, tryNative: false });
  const staleFactory = path.join(root, "stale-factory.ts");
  const freshFactory = path.join(root, "fresh-factory.ts");
  fs.writeFileSync(staleFactory, "import * as r from './registry.mjs';export default function(){return r.validateReceiverIdentity();}\n");
  fs.writeFileSync(freshFactory, "import {prepare} from './handoff-v2.mjs';export default function(){return prepare();}\n");
  const staleLoaded = await jiti.import(staleFactory);
  const staleCall = typeof staleLoaded === "function" ? staleLoaded : staleLoaded.default;
  assert.throws(() => staleCall(), /not a function/, "a reloaded TS factory cannot refresh the native registry namespace");
  const freshLoaded = await jiti.import(freshFactory);
  assert.equal((typeof freshLoaded === "function" ? freshLoaded : freshLoaded.default)(), true, "versioned factory and dependency edges work through the real JITI loader");
  const source = fs.readFileSync("extensions/index.ts", "utf8");
  assert.match(source, /from "\.\/ownership-registry-v2\.mjs"/);
  assert.match(source, /from "\.\/upgrade-handoff-v2\.mjs"/);
  assert.match(fs.readFileSync("extensions/upgrade-handoff-v2.mjs", "utf8"), /from "\.\/ownership-registry-v2\.mjs"/);
  assert.match(fs.readFileSync("scripts/prepare-upgrade.mjs", "utf8"), /from "\.\.\/extensions\/upgrade-handoff-v2\.mjs"/);
  console.log("OK: reload refresh preserves domain keys/tokens, refuses invalid authority, and versioned modules bypass stale native ESM exports");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
