import assert from "node:assert/strict";
import { extractItemIds, extractItemKeys, workerControlItemKey, workerItemKeys } from "../extensions/identity.mjs";

assert.deepEqual(extractItemIds("itemId=168373。处理返修；discussion 414557"), ["168373"]);
assert.deepEqual(extractItemIds("继续处理\nitemId: 175906，历史题目 173685"), ["175906"]);
assert.deepEqual(extractItemIds("https://www.talents-ai.com/expert/items/94/activity/176906，批注 414557"), ["176906"]);
assert.deepEqual(extractItemIds("题目 #175906，另参考 173685"), ["175906"]);
assert.deepEqual(extractItemIds("旧格式 176906 后面还有 414557"), ["176906"]);
assert.deepEqual(extractItemKeys("itemKey: mission:hkg_super_v13\nalpha KPO237EN"), ["mission:hkg_super_v13"]);
assert.deepEqual(extractItemKeys("itemKey=alpha:KPO237EN"), ["alpha:KPO237EN"]);
assert.deepEqual(extractItemIds("itemKey=alpha:KPO237EN"), []);
assert.deepEqual(extractItemKeys("itemKey=../../unsafe"), []);
assert.equal(workerControlItemKey("task-mu123"), "worker:task-mu123");
assert.deepEqual(
  workerItemKeys("task-mu123", "itemKey: alpha:KPO237EN"),
  ["worker:task-mu123", "alpha:KPO237EN"],
);
assert.deepEqual(workerItemKeys("task-mu123", "no domain key"), ["worker:task-mu123"]);
console.log("OK: every worker has a default control key plus optional domain itemKey");
