import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

  // Updating an existing reservation must remain possible at the hard limit.
  assert.doesNotThrow(() => registerWorkerOwnership(registry, {
    taskId: "task-b", ownerPid: process.pid, ownerToken: "b", cwd: "/tmp/b", itemKeys: [],
  }, options));

  unregisterWorkerOwnership(registry, "task-a", "a", options);
  assert.doesNotThrow(() => registerWorkerOwnership(registry, {
    taskId: "task-c", ownerPid: process.pid, ownerToken: "c", cwd: "/tmp/c", itemKeys: [],
  }, options));
  assert.deepEqual(Object.keys(readWorkerOwnershipRegistry(registry).workers).sort(), ["task-b", "task-c"]);

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
