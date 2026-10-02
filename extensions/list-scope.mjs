// Listing is a visibility boundary, not a change to the explicit machine-wide
// stop/reload tools. Cwd, agent name and process membership never prove lineage.
export function selectListedTasks(tasks, persistedRelations, { sessionId, workerTaskId = "", scope = "session" } = {}) {
  if (scope !== "session" && scope !== "machine") throw new Error("subagent_list scope must be session or machine");
  if (workerTaskId && scope === "machine") throw new Error("REFUSED: worker callers cannot list machine-wide tasks");
  const relations = new Map(persistedRelations);
  for (const { taskId, entry } of tasks) {
    const recorded = relations.get(taskId) || {};
    relations.set(taskId, {
      ...recorded,
      sessionId: recorded.sessionId || entry.sessionId,
      parentSessionId: recorded.parentSessionId || entry.parentSessionId,
      parentTaskId: recorded.parentTaskId || entry.parentTaskId,
    });
  }
  if (scope === "machine") return tasks;
  if (!sessionId && !workerTaskId) return []; // No identity means no guessed ownership.
  const visible = new Set(workerTaskId ? [workerTaskId] : []);
  const sessionParents = new Map();
  for (const [taskId, relation] of relations) {
    if (relation.sessionId) {
      if (!sessionParents.has(relation.sessionId)) sessionParents.set(relation.sessionId, new Set());
      sessionParents.get(relation.sessionId).add(taskId);
    }
    if (!workerTaskId && !relation.parentTaskId && relation.parentSessionId === sessionId) visible.add(taskId);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [taskId, relation] of relations) {
      if (visible.has(taskId)) continue;
      if (relation.parentTaskId) {
        // A resumed worker can reuse a session ID under a DIFFERENT parent.
        // Explicit parent task lineage must win over that shared session ID.
        if (!visible.has(relation.parentTaskId)) continue;
        const parent = relations.get(relation.parentTaskId);
        if (parent?.sessionId && relation.parentSessionId && parent.sessionId !== relation.parentSessionId) continue;
      } else {
        const parents = sessionParents.get(relation.parentSessionId);
        if (!parents?.size || ![...parents].every(parentId => visible.has(parentId))) continue;
      }
      visible.add(taskId); changed = true;
    }
  }
  if (workerTaskId) visible.delete(workerTaskId);
  return tasks.filter(({ taskId }) => visible.has(taskId));
}
