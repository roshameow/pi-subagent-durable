// Compatibility entry point. New extension generations import the versioned
// implementation directly so a long-lived Pi cannot reuse pre-upgrade exports.
export * from "./ownership-registry-v2.mjs";
