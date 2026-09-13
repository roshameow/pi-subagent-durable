import assert from "node:assert/strict";
import {
  assertBatchWithinLimit,
  assertSubagentSpawnAllowed,
  childSubagentEnvironment,
  collectDescendantTaskIds,
  parseRmuxTaskPanes,
  readSubagentSafetyConfig,
  shouldRunSubagentsAsync,
} from "../extensions/safety.mjs";

assert.deepEqual(readSubagentSafetyConfig({}), { depth: 0, maxDepth: 2, maxActive: 15 });
assert.deepEqual(parseRmuxTaskPanes([
  "pi-agents|base|0",
  "pi-agents|_worker-task-live1-abcd|0",
  "pi-agents|_worker-task-dead1-efgh|1",
  "other|_worker-task-other-zzzz|0",
].join("\n")), [
  { taskId: "task-live1-abcd", windowName: "_worker-task-live1-abcd", dead: false },
  { taskId: "task-dead1-efgh", windowName: "_worker-task-dead1-efgh", dead: true },
]);
assert.equal(shouldRunSubagentsAsync(undefined), false);
assert.equal(shouldRunSubagentsAsync(false), false);
assert.equal(shouldRunSubagentsAsync(true), true);
assert.doesNotThrow(() => assertBatchWithinLimit("parallel", 15, 15));
assert.throws(() => assertBatchWithinLimit("parallel", 16, 15), /Too many parallel tasks \(16\)/);
assert.equal(readSubagentSafetyConfig({ PI_SUBAGENT_TASK_ID: "task-old" }).depth, 1);
assert.doesNotThrow(() => assertSubagentSpawnAllowed({ PI_SUBAGENT_TASK_ID: "task-old" }));
assert.throws(
  () => assertSubagentSpawnAllowed({ PI_SUBAGENT_DEPTH: "2" }),
  /nested subagent creation blocked/,
);
assert.doesNotThrow(() => assertSubagentSpawnAllowed({ PI_SUBAGENT_DEPTH: "1", PI_SUBAGENT_MAX_DEPTH: "2" }));
assert.deepEqual(
  childSubagentEnvironment("task-child", { EXTRA: "yes" }, {
    PI_SUBAGENT_DEPTH: "1",
    PI_SUBAGENT_MAX_DEPTH: "3",
    PI_SUBAGENT_MAX_ACTIVE: "12",
  }),
  {
    EXTRA: "yes",
    PI_SUBAGENT_TASK_ID: "task-child",
    PI_SUBAGENT_DEPTH: "2",
    PI_SUBAGENT_MAX_DEPTH: "3",
    PI_SUBAGENT_MAX_ACTIVE: "12",
  },
);

const relations = new Map([
  ["root", { sessionId: "s-root", parentSessionId: "main" }],
  ["child", { sessionId: "s-child", parentSessionId: "s-root" }],
  ["grandchild", { sessionId: "s-grand", parentTaskId: "child" }],
  ["unrelated", { sessionId: "s-other", parentSessionId: "other" }],
]);
assert.deepEqual(
  [...collectDescendantTaskIds(new Set(["root"]), relations)].sort(),
  ["child", "grandchild", "root"],
);

console.log("OK: nesting guard, child depth propagation, and recursive task selection");
