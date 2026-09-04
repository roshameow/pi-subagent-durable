import assert from "node:assert/strict";
import { resolveDispatchConfig } from "../extensions/dispatch.mjs";

assert.deepEqual(
  resolveDispatchConfig(undefined, {
    model: "openai-codex/gpt-5.4",
    thinkingLevel: "high",
  }),
  {
    model: "openai-codex/gpt-5.4",
    thinkingLevel: "high",
    inheritsParent: true,
  },
);

assert.deepEqual(
  resolveDispatchConfig("anthropic/claude-sonnet-4-5", {
    model: "openai-codex/gpt-5.4",
    thinkingLevel: "high",
  }),
  {
    model: "anthropic/claude-sonnet-4-5",
    thinkingLevel: undefined,
    inheritsParent: false,
  },
);

console.log("OK: subagents inherit the dispatching model unless explicitly pinned");
