import assert from "node:assert/strict";
import fs from "node:fs";
import { currentRunSettled, lifecyclePolicy } from "../extensions/lifecycle-v3.mjs";
import { parseRecoveryResult } from "../extensions/recovery-v3.mjs";
const raw = events => events.map(e => JSON.stringify(typeof e === "string" ? {type:e} : e)).join("\n");
for (const [events, settled] of [
  [["agent_start","agent_end","agent_settled"],true],
  [["agent_start",{type:"agent_end",willRetry:true},"auto_retry_start"],false],
  [["agent_start",{type:"agent_end",willRetry:false}],false],
  [["agent_settled","agent_start"],false],
  [["agent_settled","entry_appended"],true],
  [["agent_settled","agent_start","agent_end"],false],
]) {
  assert.equal(currentRunSettled(raw(events)),settled);
  assert.equal(parseRecoveryResult(raw(events),"task-fixture-aaaa",0).interrupted,!settled);
}
assert.equal(lifecyclePolicy("0.99.1"),"settled"); assert.equal(lifecyclePolicy("1.0.0"),"settled");
assert.equal(lifecyclePolicy("0.80.0"),"legacy-end"); assert.equal(lifecyclePolicy(undefined),"settled");
assert.equal(currentRunSettled(raw(["agent_start","agent_end"]),"legacy-end"),true);
assert.equal(currentRunSettled(raw(["agent_start",{type:"agent_end",willRetry:true}]),"legacy-end"),false);
assert.equal(currentRunSettled(raw(["agent_end","agent_start"]),"legacy-end"),false);
const source=fs.readFileSync("extensions/index.ts","utf8");
assert.doesNotMatch(source,/--mcp-config/); assert.match(source,/recovery-v3\.mjs/);
assert.doesNotMatch(source,/rmuxClient\.close|connectOrStart/);
console.log("OK: explicit lifecycle capability; current-run settlement, retry and old-version compatibility; MCP neutral launch");
