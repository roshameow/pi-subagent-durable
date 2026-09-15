# pi-subagent-durable

[![CI](https://github.com/roshameow/pi-subagent-durable/actions/workflows/ci.yml/badge.svg)](https://github.com/roshameow/pi-subagent-durable/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Persistent background subagents for [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent): delegate a long task, inspect its live terminal, stop it, then resume from its saved session.

Built for research runs, batch jobs and other work that outlives a single conversation turn.

## Install

Requires Pi **0.80 or later** and Node.js **22 or later**. [RMUX](https://github.com/helvesec/rmux) is optional; without it, workers use plain subprocesses and live pane attachment is unavailable.

```bash
pi install git:github.com/roshameow/pi-subagent-durable
```

For a local checkout, use `pi install .` in this repository. Pi installs the declared `@rmux/sdk` dependency automatically.

## Start → stop → resume

1. Add an [agent definition](docs/reference.md#agent-definitions) under `.pi/agents/` or `~/.pi/agent/agents/`.
2. Ask the main agent to delegate a small task to it with `subagent`, using `async: true` for background work.
3. Use `subagent_list` to obtain the task ID and inspect its status. With RMUX installed, attach to the worker's pane.
4. Use `subagent_stop` with that **taskId** to interrupt only this task.
5. Use `subagent_reload` with the same **taskId** and a follow-up prompt to resume the saved session.

See the [reproducible walkthrough](docs/walkthrough.md) for a local-file exercise and what to verify at each step.

## Tools

| Tool | Purpose |
| --- | --- |
| `subagent` | Run a single task, parallel tasks or a chain |
| `subagent_list` | Inspect task IDs, status and context usage |
| `subagent_stop` | Stop a selected worker and its descendants |
| `subagent_reload` | Restart a worker from its saved session |
| `subagent_gc` | Remove completed/dead RMUX panes |

## What recovery means

Recovery reopens the session data already saved to disk. It is **not** a process-memory checkpoint: unfinished model output may be absent; a running tool or external job is not automatically rolled back, deduplicated or restored. After interruption, inspect external job state before repeating an action. Compacted history remains compacted.

RMUX provides a persistent terminal pane. The plain-spawn fallback does not provide pane attachment or the same terminal-disconnection behavior. Files and processes do not survive a host/storage failure simply because a session file exists.

Default limits allow one nested worker generation and at most 15 active managed workers per machine. Selector-free stop is a machine-wide operation; use an explicit task ID for ordinary work. See [limits and management rules](docs/reference.md#safety-limits).

Directed steering/watcher integration additionally uses `pi-agent-notify`, which is not distributed with this repository. The core delegation, list, stop and resume tools do not require that optional integration.

## Development

```bash
npm ci
npm run check
```

CI runs the existing dispatch, identity, ownership, safety, inheritance and resume regression checks. They do not prove compatibility with every Pi/provider version or reproduce a live RMUX/model session.

- [Operational reference](docs/reference.md): agent definitions, persistence, notifications and internals.
- [Pi Desktop](https://github.com/roshameow/pi-session-viewer): browse parent and child sessions visually.
- [Issues](https://github.com/roshameow/pi-subagent-durable/issues): include Pi, Node and RMUX versions plus a minimal reproduction.

[MIT License](LICENSE)
