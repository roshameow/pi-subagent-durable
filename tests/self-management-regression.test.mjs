import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync("extensions/index.ts", "utf8");

assert.match(source, /REFUSED self-kill task=/, "killTask needs a final self-kill fence");
assert.match(source, /cannot perform selector-free machine-wide stop/, "workers must not invoke global stop");
assert.match(source, /cannot perform selector-free reload/, "workers must not invoke global reload");
assert.match(source, /may stop descendants only/, "subagent_stop must enforce descendant scope");
assert.match(source, /may reload descendants only/, "subagent_reload must enforce descendant scope");
assert.match(source, /The current worker is never returned as its own subagent/, "subagent_list must not induce self-management");
assert.ok((source.match(/restrictManagementTargets\(requested\)/g) || []).length >= 2, "stop and reload must both use target restriction");
assert.match(source, /hasTerminalAgentEvent\(rawOutput\)/, "rmux completion must detect abrupt pre-agent_end exits");
assert.match(source, /hasTerminalAgentEvent\(rawStdout\)/, "spawn completion must detect abrupt pre-agent_end exits");
assert.match(source, /异常中断.*agent_end\/agent_settled/, "abrupt exits must not be reported as successful empty completion");

console.log("OK: worker self-management is fenced and abrupt exits are classified as interruptions");
