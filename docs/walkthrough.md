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
