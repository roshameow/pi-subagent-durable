// Compatibility entry point for scripts and consumers. The extension imports
// v2 directly to avoid a cached handoff module linked to the old registry ABI.
export * from "./upgrade-handoff-v2.mjs";
