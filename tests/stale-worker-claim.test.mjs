// 2026-10-06（211442 实测）：**死掉的 worker 条目曾永久占住 item**。
// 现场：worker 被 stop 后 durable 记录已 status=stopped、PID 不存在，但 `.active-workers.json` 仍留着
// 它的 itemKeys ⇒ 新 worker 领同一题时抛 `worker item collision: 211442 already owned by <dead task>`，
// 而那个 task 连 `.receiver-identity.json` 都没有（notify 也送不进去）。
// 规则：判定冲突/上限前，先按 PID 清掉死条目；活着的条目仍然照旧互斥。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerWorkerOwnership as registerWorker } from "../extensions/ownership-registry-v2.mjs";

const DEAD_PID = 999999; // 极不可能存在的 PID

function freshRegistry() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-stale-claim-"));
  return { dir, file: path.join(dir, ".active-workers.json") };
}

function seed(file, workers) {
  fs.writeFileSync(file, JSON.stringify({ version: 2, workers }));
}

function record(dir, taskId, items) {
  return { taskId, cwd: dir, itemKeys: items, itemIds: items.filter((k) => /^\d{6}$/.test(k)),
           ownerPid: process.pid, pid: process.pid, ownerToken: taskId };
}

{
  const { dir, file } = freshRegistry();
  seed(file, {
    "task-dead": { version: 2, taskId: "task-dead", cwd: dir, itemKeys: ["211442"], itemIds: ["211442"],
                   ownerPid: DEAD_PID, pid: DEAD_PID, heartbeatAt: new Date().toISOString(), ownerToken: "t" },
  });
  registerWorker(file, record(dir, "task-new", ["211442"]), { maxActiveWorkers: 10, isSettled: () => false });
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(data.workers["task-new"], "新 worker 必须能登记");
  assert.ok(!data.workers["task-dead"], "死条目必须被清掉");
}

{
  const { dir, file } = freshRegistry();
  seed(file, {
    "task-live": { version: 2, taskId: "task-live", cwd: dir, itemKeys: ["211442"], itemIds: ["211442"],
                   ownerPid: process.pid, pid: process.pid, heartbeatAt: new Date().toISOString(), ownerToken: "t" },
  });
  assert.throws(
    () => registerWorker(file, record(dir, "task-new2", ["211442"]), { maxActiveWorkers: 10, isSettled: () => false }),
    /worker item collision/,
    "活着的 owner 仍然必须互斥",
  );
}

{
  // 死条目也不该继续占用 maxActiveWorkers 配额。
  const { dir, file } = freshRegistry();
  const dead = {};
  for (let i = 0; i < 3; i += 1) {
    dead[`task-dead-${i}`] = { version: 2, taskId: `task-dead-${i}`, cwd: dir, itemKeys: [`99999${i}`],
                               itemIds: [`99999${i}`], ownerPid: DEAD_PID, pid: DEAD_PID,
                               heartbeatAt: new Date().toISOString(), ownerToken: `d${i}` };
  }
  seed(file, dead);
  assert.doesNotThrow(
    () => registerWorker(file, record(dir, "task-fresh", ["211442"]), { maxActiveWorkers: 2, isSettled: () => false }),
    "死条目不应把并发上限占满",
  );
}

console.log("stale-worker-claim: ok");
