import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync("extensions/index.ts", "utf8");
const syncStart = source.indexOf("// ── RMUX 路径:子代理跑在 pi-agents pane");
const syncEnd = source.indexOf("// ── 非 rmux 路径:spawn + stdio", syncStart);
assert.ok(syncStart >= 0 && syncEnd > syncStart, "synchronous rmux completion block must exist");
const block = source.slice(syncStart, syncEnd);

assert.match(
  block,
  /let panes: any \| null = null;[\s\S]*panes = await rmux\.cmd\("list-panes"/,
  "pane result must be declared outside the try block that assigns it",
);
assert.match(
  block,
  /if \(panes\?\.returnCode === 0\)/,
  "completion cleanup must tolerate list-panes throwing before a result exists",
);
assert.doesNotMatch(
  block,
  /try\s*\{\s*const panes = await rmux\.cmd\("list-panes"[\s\S]*?\}\s*catch[\s\S]*?if \(isDead\)[\s\S]*?panes\.returnCode/,
  "a block-scoped pane result must never be referenced by completion cleanup",
);

console.log("OK: synchronous rmux completion keeps pane state in scope and handles missing results");
