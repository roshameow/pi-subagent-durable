# Stop and resume walkthrough

This is a manual exercise using disposable local files. It requires an installed/configured Pi and a model connection; it is not a recorded benchmark.

Create `.pi/agents/demo-worker.md` in an empty example project:

```markdown
---
name: demo-worker
description: Checkpoint a small local documentation task
tools: read, write, bash
---
Work only in this example project. Record completed steps in demo-progress.md.
Read that file before continuing after an interruption; do not repeat completed steps.
```

Ask the main agent to run `demo-worker` asynchronously to draft a small project guide, updating `demo-progress.md` after each section. Inspect `subagent_list` and record the exact task ID. Stop that task with `subagent_stop { taskId: "<the observed task ID>" }`, then inspect the saved progress file.

Resume through `subagent_reload` using the same task ID and ask the worker to finish the remaining sections. Check that the completed sections remain in the file and that continuation appears in the same canonical session. With RMUX installed, inspect the live pane while work is running.

If the task finishes before you interrupt it, resume the completed session with a follow-up section. Do not deliberately repeat database writes or remote job submissions to demonstrate recovery. A persisted conversation does not guarantee exactly-once external execution.

## Parent upgrade recovery checks

Run `npm run check` for isolated upgrade regression exercises. The new recovery
fixtures use mock RMUX/host adapters and disposable receiver/controller processes,
not business workers or a model connection. They verify:

- controller process exit followed by same-parent acquisition with a higher
  fencing generation; a live competing controller and a different parent fail;
- offline completion persists an outbox before publication and records delivery
  only after the tagged notification reaches the parent transcript;
- a failed RMUX query leaves the task pending (`unknown`), rather than announcing
  completion; canonical-path preparation refuses fallback/sync tasks;
- receiver migration keeps token, keys, runId, nonce and wait-lease bytes unchanged;
- legacy receiver heartbeats can be mirrored by the bounded keeper while the
  original controller is gone; stale identity cannot be made fresh by a parent.

Verified pitfalls: `globalThis` alone does not survive a process restart;
`sendUserMessage` can queue without immediately persisting a message, so acknowledging
on return loses notifications on parent exit; and old notify workers may still
check registry heartbeats even while their receiver identity is fresh. The outbox,
transcript acknowledgment and bounded keeper address these distinct boundaries.
These fixtures are not a live provider/RMUX upgrade certification. Before relying
on a new Pi/RMUX version, exercise the README preparation flow in a disposable
project and inspect the exact task count, canonical parent path, receiver PID and
controller acquisition report. Do not repeat external writes to demonstrate recovery.

Reload compatibility regression: `tests/recovery-extension.test.mjs` seeds a
pre-upgrade callback-owned Map entry before loading the new factory. Recovery
retains that entry and renews only its controller lease, without marking it
recovery-managed or adding a completion monitor. The test also removes the Map
entry as an old cleanup callback would, switches to another parent, and verifies
both body-only legacy delivery and explicit-origin delivery cannot steer there.
