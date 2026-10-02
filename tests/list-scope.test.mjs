import assert from "node:assert/strict";
import { selectListedTasks } from "../extensions/list-scope.mjs";

const relations = new Map([
  ["task-a", { parentSessionId: "main-a", sessionId: "child-a" }],
  ["task-b", { parentSessionId: "main-b", sessionId: "child-b" }],
  ["task-a-child", { parentTaskId: "task-a", parentSessionId: "child-a", sessionId: "grandchild-a" }],
  ["task-a-legacy-child", { parentSessionId: "child-a" }],
  ["task-a-settled", { parentSessionId: "main-a", sessionId: "settled-child" }],
  ["task-orphan-descendant", { parentTaskId: "task-a-settled", parentSessionId: "settled-child" }],
  ["task-conflict", { parentSessionId: "main-b" }],
  ["task-cycle-one", { parentTaskId: "task-cycle-two" }],
  ["task-cycle-two", { parentTaskId: "task-cycle-one" }],
]);
const ids = ["task-a", "task-b", "task-a-child", "task-a-legacy-child", "task-orphan-descendant", "task-unknown", "task-conflict", "task-cycle-one", "task-cycle-two", "task-memory-a"];
const tasks = ids.map(taskId => ({ taskId, entry: { cwd: "/same/project", agent: "same-agent", ...(taskId === "task-memory-a" || taskId === "task-conflict" ? { parentSessionId: "main-a" } : {}) } }));
const listed = options => selectListedTasks(tasks, relations, options).map(row => row.taskId);
assert.deepEqual(listed({ sessionId: "main-a" }), ["task-a", "task-a-child", "task-a-legacy-child", "task-orphan-descendant", "task-memory-a"]);
assert.deepEqual(listed({ sessionId: "main-b" }), ["task-b", "task-conflict"], "persisted lineage wins over stale in-memory ownership");
assert.deepEqual(listed({ sessionId: "new-main" }), [], "switching main session cannot inherit the same process's task map");
assert.deepEqual(listed({}), [], "unknown current identity does not guess ownership from cwd/agent");
assert.deepEqual(listed({ scope: "machine" }), ids, "machine-wide main inspection is explicit");
assert.throws(() => listed({ sessionId: "main-a", scope: "all" }), /scope/);
assert.deepEqual(listed({ sessionId: "child-a", workerTaskId: "task-a" }), ["task-a-child", "task-a-legacy-child"]);
assert.throws(() => listed({ workerTaskId: "task-a", scope: "machine" }), /REFUSED/);

const reused = new Map([
  ["task-old-a", { parentSessionId: "main-a", sessionId: "reused-worker-session" }],
  ["task-new-b", { parentSessionId: "main-b", sessionId: "reused-worker-session" }],
  ["task-grandchild-b", { parentTaskId: "task-new-b", parentSessionId: "reused-worker-session" }],
  ["task-grandchild-a", { parentTaskId: "task-old-a", parentSessionId: "reused-worker-session" }],
  ["task-ambiguous-legacy", { parentSessionId: "reused-worker-session" }],
  ["task-inconsistent", { parentTaskId: "task-old-a", parentSessionId: "foreign-session" }],
]);
const reusedTasks = [...reused.keys()].map(taskId => ({ taskId, entry: {} }));
assert.deepEqual(selectListedTasks(reusedTasks, reused, { sessionId: "main-a" }).map(row => row.taskId), ["task-old-a", "task-grandchild-a"], "a resumed worker's reused session ID cannot bridge foreign parent task trees");
assert.deepEqual(selectListedTasks(reusedTasks, reused, { sessionId: "main-b" }).map(row => row.taskId), ["task-new-b", "task-grandchild-b"]);
assert.deepEqual(selectListedTasks(reusedTasks, reused, { sessionId: "reused-worker-session", workerTaskId: "task-old-a" }).map(row => row.taskId), ["task-grandchild-a"], "worker listing also refuses foreign descendants reached only by a reused session ID");
console.log("OK: subagent_list defaults to the exact main task tree, isolates same-cwd/session switches/reused worker sessions, and gates machine scope");
