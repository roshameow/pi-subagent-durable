import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  readWorkerOwnershipRegistry,
  registerWorkerOwnership,
  unregisterWorkerOwnership,
} from "../extensions/ownership-registry.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-registry-test-"));
const registry = path.join(dir, ".active-workers.json");
const options = { maxActiveWorkers: 2, isSettled: () => false };

try {
  registerWorkerOwnership(registry, {
    taskId: "task-a", ownerPid: process.pid, ownerToken: "a", cwd: "/tmp/a", itemKeys: [],
  }, options);
  registerWorkerOwnership(registry, {
    taskId: "task-b", ownerPid: process.pid, ownerToken: "b", cwd: "/tmp/b", itemKeys: [],
  }, options);
  assert.equal(Object.keys(readWorkerOwnershipRegistry(registry).workers).length, 2);

  assert.throws(
    () => registerWorkerOwnership(registry, {
      taskId: "task-c", ownerPid: process.pid, ownerToken: "c", cwd: "/tmp/c", itemKeys: [],
    }, options),
    /global subagent limit reached \(2\/2\)/,
  );

  // Updating an existing reservation must remain possible at the hard limit,
  // but a different lease token cannot take over a live task ID.
  assert.doesNotThrow(() => registerWorkerOwnership(registry, {
    taskId: "task-b", ownerPid: process.pid, ownerToken: "b", cwd: "/tmp/b", itemKeys: [],
  }, options));
  assert.throws(() => registerWorkerOwnership(registry, {
    taskId: "task-b", ownerPid: process.pid, ownerToken: "attacker", cwd: "/tmp/b", itemKeys: [],
  }, options), /ownership token mismatch/);
  unregisterWorkerOwnership(registry, "task-a", "wrong-token", options);
  assert.ok(readWorkerOwnershipRegistry(registry).workers["task-a"], "wrong token must not release ownership");

  unregisterWorkerOwnership(registry, "task-a", "a", options);
  assert.doesNotThrow(() => registerWorkerOwnership(registry, {
    taskId: "task-c", ownerPid: process.pid, ownerToken: "c", cwd: "/tmp/c", itemKeys: [],
  }, options));
  assert.deepEqual(Object.keys(readWorkerOwnershipRegistry(registry).workers).sort(), ["task-b", "task-c"]);

  const collisionRegistry = path.join(dir, ".collision-workers.json");
  registerWorkerOwnership(collisionRegistry, {
    taskId: "task-mission-a", ownerPid: process.pid, ownerToken: "ma", cwd: "/repo", itemKeys: ["mission:hkg_super_v13"],
  }, { maxActiveWorkers: 10, isSettled: () => false });
  assert.throws(() => registerWorkerOwnership(collisionRegistry, {
    taskId: "task-mission-b", ownerPid: process.pid, ownerToken: "mb", cwd: "/repo", itemKeys: ["mission:hkg_super_v13"],
  }, { maxActiveWorkers: 10, isSettled: () => false }), /worker item collision/);

  const concurrentRegistry = path.join(dir, ".concurrent-workers.json");
  const moduleUrl = pathToFileURL(path.resolve("extensions/ownership-registry.mjs")).href;
  const children = Array.from({ length: 12 }, (_, index) => new Promise((resolve, reject) => {
    const code = `import { registerWorkerOwnership } from ${JSON.stringify(moduleUrl)}; registerWorkerOwnership(process.env.REGISTRY, { taskId: 'task-' + process.env.INDEX, ownerPid: Number(process.env.OWNER_PID), ownerToken: 'token-' + process.env.INDEX, cwd: '/tmp/' + process.env.INDEX, itemKeys: ['ci:run-' + process.env.INDEX] }, { maxActiveWorkers: 100, isSettled: () => false });`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, REGISTRY: concurrentRegistry, INDEX: String(index), OWNER_PID: String(process.pid) } });
    let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject); child.on("exit", status => status === 0 ? resolve() : reject(new Error(stderr)));
  }));
  await Promise.all(children);
  assert.equal(Object.keys(readWorkerOwnershipRegistry(concurrentRegistry).workers).length, 12, "concurrent registry writes must not lose records");

  const orphanRegistry = path.join(dir, ".orphan-workers.json");
  const orphanOptions = {
    maxActiveWorkers: 2,
    externalActiveTaskIds: ["task-orphan"],
    isSettled: () => false,
  };
  registerWorkerOwnership(orphanRegistry, {
    taskId: "task-local", ownerPid: process.pid, ownerToken: "local", cwd: "/tmp/local", itemKeys: [],
  }, orphanOptions);
  assert.throws(
    () => registerWorkerOwnership(orphanRegistry, {
      taskId: "task-overflow", ownerPid: process.pid, ownerToken: "overflow", cwd: "/tmp/overflow", itemKeys: [],
    }, orphanOptions),
    /global subagent limit reached \(2\/2\)/,
  );
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("OK: atomic worker registry enforces the machine-wide active-task cap");
