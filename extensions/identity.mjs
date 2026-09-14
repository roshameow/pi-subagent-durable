const SAFE_ITEM_KEY = /^[A-Za-z0-9][A-Za-z0-9._:@+/-]{0,199}$/;

export function isSafeItemKey(value) {
  return typeof value === "string" && SAFE_ITEM_KEY.test(value) && value !== "." && value !== ".." && !value.includes("//");
}

export function workerControlItemKey(taskId) {
  const key = `worker:${String(taskId || "")}`;
  if (!isSafeItemKey(key)) throw new Error(`unsafe worker control itemKey: ${key}`);
  return key;
}

export function workerItemKeys(taskId, taskText = "") {
  return [...new Set([workerControlItemKey(taskId), ...extractItemKeys(taskText)])];
}

export function extractItemKeys(taskText = "") {
  const text = taskText || "";
  // Prefer an explicit domain-neutral declaration. Keys may identify an alpha,
  // simulation, review, CI run, ticket, or a legacy six-digit item.
  const canonical = text.match(/(?:^|\n)\s*itemKey\s*[=:：#-]*\s*([^\s,，;；]+)/i);
  if (canonical && isSafeItemKey(canonical[1])) return [canonical[1]];

  // Backwards-compatible TalentsAI declarations and activity URLs.
  const legacy = text.match(/(?:^|\n)\s*itemId\s*[=:：#-]*\s*(\d{6})\b/i);
  if (legacy) return [legacy[1]];
  const activity = text.match(/\/activity\/(\d{6})(?:\b|\/)/);
  if (activity) return [activity[1]];
  const explicit = text.match(/(?:item|题目|活动)[\s:=：#-]+(\d{6})\b/i);
  if (explicit) return [explicit[1]];
  const bare = text.match(/\b\d{6}\b/);
  return bare ? [bare[0]] : [];
}

// Kept for callers that still consume the old helper. Generic keys are not
// silently exposed as numeric IDs.
export function extractItemIds(taskText = "") {
  return extractItemKeys(taskText).filter((key) => /^\d{6}$/.test(key));
}
