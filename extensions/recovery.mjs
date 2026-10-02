// Compatibility entry point. Import recovery-v2.mjs directly when a live Node
// process may still have the old recovery.mjs implementation in its ESM cache.
export * from "./recovery-v2.mjs";
