import assert from "node:assert/strict";
import { extractItemIds } from "../extensions/identity.mjs";

assert.deepEqual(extractItemIds("itemId=168373。处理返修；discussion 414557"), ["168373"]);
assert.deepEqual(extractItemIds("继续处理\nitemId: 175906，历史题目 173685"), ["175906"]);
assert.deepEqual(extractItemIds("https://www.talents-ai.com/expert/items/94/activity/176906，批注 414557"), ["176906"]);
assert.deepEqual(extractItemIds("题目 #175906，另参考 173685"), ["175906"]);
assert.deepEqual(extractItemIds("旧格式 176906 后面还有 414557"), ["176906"]);
console.log("OK: worker item identity prefers canonical task target and ignores later IDs");
