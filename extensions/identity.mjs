export function extractItemIds(taskText = "") {
  const text = taskText || "";
  // A task owns exactly one TalentsAI item. Prefer the canonical declaration at
  // the beginning; do not absorb discussion IDs or historical examples later.
  const canonical = text.match(/(?:^|\n)\s*itemId\s*[=:：#-]*\s*(\d{6})\b/i);
  if (canonical) return [canonical[1]];
  const activity = text.match(/\/activity\/(\d{6})(?:\b|\/)/);
  if (activity) return [activity[1]];
  const explicit = text.match(/(?:item|题目|活动)[\s:=：#-]+(\d{6})\b/i);
  if (explicit) return [explicit[1]];
  const bare = text.match(/\b\d{6}\b/);
  return bare ? [bare[0]] : [];
}
