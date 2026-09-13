const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_MAX_ACTIVE = 15;
const HARD_MAX_DEPTH = 16;
const HARD_MAX_ACTIVE = 64;

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function readSubagentSafetyConfig(env = process.env) {
  // Old workers created before PI_SUBAGENT_DEPTH existed still carry a task id.
  // Treat them as depth 1 so reloading the extension closes the recursion hole.
  const inferredDepth = env.PI_SUBAGENT_TASK_ID ? 1 : 0;
  return {
    depth: boundedInteger(env.PI_SUBAGENT_DEPTH, inferredDepth, 0, HARD_MAX_DEPTH),
    maxDepth: boundedInteger(env.PI_SUBAGENT_MAX_DEPTH, DEFAULT_MAX_DEPTH, 0, HARD_MAX_DEPTH),
    maxActive: boundedInteger(env.PI_SUBAGENT_MAX_ACTIVE, DEFAULT_MAX_ACTIVE, 1, HARD_MAX_ACTIVE),
  };
}

export function parseRmuxTaskPanes(output, expectedSession = "pi-agents") {
  const panes = [];
  for (const line of String(output || "").split("\n")) {
    const [sessionName, windowName, deadValue] = line.trim().split("|");
    if (sessionName !== expectedSession || !windowName) continue;
    const match = /task-[a-z0-9]+-[a-z0-9]+/i.exec(windowName);
    if (match) panes.push({ taskId: match[0], windowName, dead: deadValue === "1" });
  }
  return panes;
}

export function shouldRunSubagentsAsync(value) {
  return value === true;
}

export function assertBatchWithinLimit(kind, count, max) {
  if (count > max) throw new Error(`Too many ${kind} tasks (${count}). Max is ${max}.`);
}

export function assertSubagentSpawnAllowed(env = process.env) {
  const config = readSubagentSafetyConfig(env);
  if (config.depth >= config.maxDepth) {
    throw new Error(
      `nested subagent creation blocked at depth ${config.depth}; ` +
      `PI_SUBAGENT_MAX_DEPTH=${config.maxDepth} (safe default: 2)`,
    );
  }
  return config;
}

export function childSubagentEnvironment(taskId, extra = {}, env = process.env) {
  const config = assertSubagentSpawnAllowed(env);
  return {
    ...extra,
    PI_SUBAGENT_TASK_ID: String(taskId),
    PI_SUBAGENT_DEPTH: String(config.depth + 1),
    PI_SUBAGENT_MAX_DEPTH: String(config.maxDepth),
    PI_SUBAGENT_MAX_ACTIVE: String(config.maxActive),
  };
}

export function collectDescendantTaskIds(rootTaskIds, relations) {
  const selected = new Set(rootTaskIds);
  const sessions = new Set();
  for (const taskId of selected) {
    const sessionId = relations.get(taskId)?.sessionId;
    if (sessionId) sessions.add(sessionId);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const [taskId, relation] of relations) {
      if (selected.has(taskId)) continue;
      const linkedByTask = relation?.parentTaskId && selected.has(relation.parentTaskId);
      const linkedBySession = relation?.parentSessionId && sessions.has(relation.parentSessionId);
      if (!linkedByTask && !linkedBySession) continue;
      selected.add(taskId);
      if (relation.sessionId) sessions.add(relation.sessionId);
      changed = true;
    }
  }
  return selected;
}
