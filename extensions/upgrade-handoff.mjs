import fs from "node:fs";
import path from "node:path";
import { readWorkerOwnershipRegistry, validateReceiverIdentity, migrateWorkerOwnershipToReceiver } from "./ownership-registry.mjs";
import { atomicRecoveryWrite, taskRecordPath, verifyCanonicalSession, resumeCommand, readTaskRecords } from "./recovery.mjs";
import { acquireControllerLease, readControllerLeaseRegistry, withControllerLease } from "./controller-lease.mjs";
import { findRealSessionPathInRoot } from "./session-resume.mjs";

function prefix(file) {
  const fd = fs.openSync(file, "r"); const buf = Buffer.alloc(65536);
  try { return buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)).toString("utf8"); }
  finally { fs.closeSync(fd); }
}
export function readDispatchRecord(logPath) {
  const events = prefix(logPath).split("\n").flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const task = events.find(e => e.type === "pi_subagent_task");
  const lineage = events.find(e => e.type === "pi_subagent_parent" && e.parentId);
  const session = events.find(e => e.type === "session");
  const launch = events.find(e => e.type === "pi_subagent_launch");
  if (!task || !lineage) return null;
  // Existing async logs start with task metadata. Sync logs were pre-seeded
  // with an unrelated synthetic session header: refuse them rather than guess.
  const mode = launch?.mode || (events[0]?.type === "pi_subagent_task" ? "legacy-async" : "unsupported-sync");
  return { taskId: task.taskId, agent: task.agent, task: task.task, cwd: task.cwd,
    parentSessionId: lineage.parentId, parentSessionPath: lineage.parentSessionPath,
    parentTaskId: lineage.parentTaskId, sessionId: session?.id, mode, logPath };
}

// Preflight all candidates before any migration. Failure is explicit; migration
// writes remain individually durable if I/O fails midway, making retry safe.
export async function prepareUpgrade(options) {
  const parentSessionPath = verifyCanonicalSession(options.parentSessionPath, options.parentSessionId);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.parentSessionId)) throw new Error("unsafe parent session id");
  if (!Number.isInteger(options.expectedOwnerPid) || options.expectedOwnerPid < 2) throw new Error("verified original parent PID is required");
  const manifestPath = path.join(path.dirname(options.ledgerDir), "agent-upgrades", `${options.parentSessionId}.json`);
  atomicRecoveryWrite(manifestPath, { version: 1, ready: false, parentSessionId: options.parentSessionId, parentSessionPath });
  const registry = readWorkerOwnershipRegistry(options.registryPath);
  const previous = new Map(readTaskRecords(options.ledgerDir, options.parentSessionId).map(r => [r.taskId, r]));
  const dispatches = [];
  const allDispatches = new Map();
  let files = []; try { files = fs.readdirSync(options.logDir); } catch (e) { if (e.code !== "ENOENT") throw e; }
  for (const name of files.filter(n => /^task-[a-z0-9]+-[a-z0-9]+\.jsonl$/i.test(n))) {
    const dispatch = readDispatchRecord(path.join(options.logDir, name));
    if (dispatch) allDispatches.set(dispatch.taskId, dispatch);
    if (dispatch?.parentSessionId === options.parentSessionId) dispatches.push(dispatch);
  }
  for (const [taskId, reservation] of Object.entries(registry.workers)) {
    if (Number(reservation.ownerPid ?? reservation.pid) !== options.expectedOwnerPid || reservation.ownershipMode === "receiver") continue;
    const dispatch = allDispatches.get(taskId);
    if (!dispatch) throw new Error(`${taskId}: original parent owns a task with missing/bounded lineage; handoff refused`);
    if (dispatch.parentSessionId !== options.parentSessionId) throw new Error(`${taskId}: original parent also owns legacy work from another session; prepare that session separately`);
  }
  for (const taskId of options.requiredTaskIds || []) {
    if (!dispatches.some(d => d.taskId === taskId)) throw new Error(`${taskId}: missing/bounded dispatch metadata; handoff refused`);
  }
  const selected = [];
  const controllersPath = options.controllerRegistryPath || path.join(options.ledgerDir, ".controllers.json");
  for (const dispatch of dispatches) {
    const old = previous.get(dispatch.taskId);
    if (old?.deliveredAt || old?.status === "stopped") continue;
    const liveness = await options.probe(dispatch);
    if (liveness.state === "unknown") throw new Error(`${dispatch.taskId}: liveness unknown; handoff refused`);
    if (liveness.state === "dead") {
      // Known in-flight candidates must not silently become history during
      // preparation. Existing ledgers retain an outbox for cold reconciliation.
      const known = (options.requiredTaskIds || []).includes(dispatch.taskId) ||
        Number(registry.workers[dispatch.taskId]?.ownerPid ?? registry.workers[dispatch.taskId]?.pid) === options.expectedOwnerPid;
      if (!old && known) throw new Error(`${dispatch.taskId}: known task completed during preparation; collect its result before exiting and retry`);
      continue;
    }
    if (!["async-rmux", "legacy-async"].includes(dispatch.mode)) throw new Error(`${dispatch.taskId}: unsafe sync/fallback execution; handoff refused`);
    if (!liveness.rmuxTarget) throw new Error(`${dispatch.taskId}: live fallback/sync task has no RMUX pane; handoff refused`);
    if (!dispatch.sessionId) throw new Error(`${dispatch.taskId}: child session header not yet available; retry`);
    const childSessionPath = findRealSessionPathInRoot(options.sessionsRoot, dispatch.sessionId);
    if (!childSessionPath) throw new Error(`${dispatch.taskId}: canonical child session is missing; handoff refused`);
    const registration = registry.workers[dispatch.taskId];
    if (!registration?.ownerToken) throw new Error(`${dispatch.taskId}: ownership reservation missing; cannot safely recreate it`);
    if (path.resolve(registration.cwd) !== path.resolve(dispatch.cwd)) throw new Error(`${dispatch.taskId}: registration cwd mismatch`);
    if (registration.parentSessionId && registration.parentSessionId !== options.parentSessionId) throw new Error(`${dispatch.taskId}: registration belongs to another parent`);
    if (registration.ownershipMode !== "receiver" && options.expectedOwnerPid && Number(registration.ownerPid ?? registration.pid) !== options.expectedOwnerPid) throw new Error(`${dispatch.taskId}: not owned by this parent process`);
    const receiverIdentityPath = path.join(options.notifyDir, dispatch.taskId, ".receiver-identity.json");
    const identity = validateReceiverIdentity({ ...registration, receiverIdentityPath });
    if (!identity.runId || !identity.nonce || !(identity.itemKeys || []).includes(`worker:${dispatch.taskId}`)) throw new Error(`${dispatch.taskId}: incomplete receiver control identity`);
    if ((registration.itemKeys || []).some(key => !identity.itemKeys.includes(key))) throw new Error(`${dispatch.taskId}: receiver does not advertise all owned keys`);
    let lease;
    if (options.authorizeTask) lease = options.authorizeTask(dispatch);
    if (!lease) {
      // Bootstrap is explicitly delegated by the one verified live parent. A
      // newer parent's existing controller credentials are preserved; legacy
      // parents receive a lease bound to their actual PID until they exit.
      if (!Number.isInteger(options.expectedOwnerPid) || options.expectedOwnerPid < 2) throw new Error("verified original parent PID is required");
      const existing = readControllerLeaseRegistry(controllersPath).leases[dispatch.taskId];
      if (existing && existing.ownerPid !== options.expectedOwnerPid && !existing.releasedAt) throw new Error(`${dispatch.taskId}: another controller owns this task`);
      lease = acquireControllerLease(controllersPath, { taskId: dispatch.taskId, parentSessionId: options.parentSessionId,
        ownerPid: options.expectedOwnerPid, ...(existing && !existing.releasedAt ? { controllerToken: existing.controllerToken } : {}) });
    }
    if (!lease || lease.parentSessionId !== options.parentSessionId || lease.ownerPid !== options.expectedOwnerPid) throw new Error(`${dispatch.taskId}: invalid prepare controller authority`);
    selected.push({ dispatch, registration, identity, receiverIdentityPath, childSessionPath, rmuxTarget: liveness.rmuxTarget, old, lease });
  }
  // In-memory sync/fallback runs might have incomplete log headers: caller must
  // also reject those before invoking this function.
  const migrated = [];
  for (const row of selected) {
    const { dispatch, registration, identity, receiverIdentityPath, childSessionPath, rmuxTarget, old, lease } = row;
    const record = { version: 1, ...old, ...dispatch, mode: "async-rmux", parentSessionPath,
      childSessionPath, rmuxTarget, startTime: old?.startTime || Date.now(), status: "running",
      ownershipMode: "receiver", workerPid: Number(identity.pid), receiverIdentityPath,
      ownershipToken: registration.ownerToken, itemKeys: registration.itemKeys,
      preparedAt: new Date().toISOString() };
    // Persist the relationship before changing ownership. If the migration
    // fails, the ledger is safe to retry; no success command is emitted.
    withControllerLease(controllersPath, lease, () => {
      const file = taskRecordPath(options.ledgerDir, dispatch.taskId);
      let latest; try { latest = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; }
      if (latest && (latest.parentSessionId !== options.parentSessionId || latest.parentSessionPath !== parentSessionPath)) throw new Error(`${dispatch.taskId}: ledger parent changed during prepare`);
      if (latest?.deliveredAt || latest?.status === "stopped" || latest?.result) throw new Error(`${dispatch.taskId}: task settled during prepare; retry after collecting its result`);
      atomicRecoveryWrite(file, record);
      migrateWorkerOwnershipToReceiver(options.registryPath, dispatch.taskId, registration.ownerToken, {
        workerPid: Number(identity.pid), parentSessionId: options.parentSessionId, receiverIdentityPath,
      });
    });
    migrated.push(record);
  }
  return { records: migrated, command: resumeCommand(parentSessionPath, options.cwd), parentSessionPath,
    parentSessionId: options.parentSessionId, parentPid: options.expectedOwnerPid, cwd: options.cwd,
    ledgerDir: options.ledgerDir, manifestPath, controllerRegistryPath: controllersPath, leases: selected.map(row => row.lease) };
}

export function publishUpgradeManifest(handoff, keeper) {
  const publish = () => {
    process.kill(handoff.parentPid, 0); // refuse if the parent disappeared during preparation
    const tasks = readTaskRecords(handoff.ledgerDir, handoff.parentSessionId)
      .filter(record => !record.deliveredAt && record.status !== "stopped").map(record => record.taskId);
    const manifest = { version: 1, ready: true, parentSessionId: handoff.parentSessionId,
      parentSessionPath: handoff.parentSessionPath, parentPid: handoff.parentPid, cwd: handoff.cwd,
      preparedAt: new Date().toISOString(), taskIds: tasks, keeper };
    atomicRecoveryWrite(handoff.manifestPath, manifest);
    return manifest;
  };
  // Every selected task must still have the same generation. The first guard
  // holds the shared controller registry lock across verification + publication.
  if (handoff.leases.length) return withControllerLease(handoff.controllerRegistryPath, handoff.leases[0], () => {
    const registry = readControllerLeaseRegistry(handoff.controllerRegistryPath);
    for (const lease of handoff.leases) {
      const current = registry.leases[lease.taskId];
      if (!current || current.generation !== lease.generation || current.controllerToken !== lease.controllerToken || current.ownerPid !== lease.ownerPid || current.releasedAt) throw new Error("controller authority changed before ready publication");
    }
    return publish();
  });
  return publish();
}
