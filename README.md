# pi-subagent-durable

Durable background subagents for [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent). Each subagent runs as a full `pi` subprocess in a persistent [RMUX](https://github.com/helvesec/rmux) pane with a **real session file** — so it can be killed and resumed at any time with 100% context, attach to its live terminal, and be managed by the main agent itself.

## Why this exists

| | pi built-in subagent | pi-agents-team | **this package** |
|---|---|---|---|
| Session persistence | none (ephemeral process) | RPC, no session file, lost on restart | **full pi session file, `--session` resume** |
| Interrupt / resume | ✗ | ✗ | **✅ kill + resume, context preserved** |
| Live terminal view | ✗ | summaries only | **✅ RMUX attach** |
| Main-agent management | ✗ | stop/steer | **✅ list / reload / stop tools (LLM-callable)** |

Fits long-running background work (backtests, batch jobs, training) where the agent may run for hours and you want to update tools/extensions and hot-reload the running subagent without losing its state.

## Requirements

- pi `>= 0.80`
- Node `>= 20`
- [rmux](https://github.com/helvesec/rmux) (`brew install rmux`) — **optional but recommended**. Without it the extension falls back to plain `spawn` (no persistent pane, no attach).

## Install

```bash
# from a local checkout (this package)
pi install ./pi-subagent-durable          # global
pi install -l ./pi-subagent-durable       # project-local

# or from git once published
pi install git:github.com/yourname/pi-subagent-durable

# try without installing (single run)
pi -e ./pi-subagent-durable
```

`pi install` runs `npm install`, which pulls in `@rmux/sdk` automatically.

## What you get

### Tools (callable by the main agent LLM)

| Tool | What it does |
|------|--------------|
| `subagent` | Delegate tasks (single / parallel / chain). Runs async in the background with a persistent pane. |
| `subagent_list` | List running subagents: taskId / agent / sessionId / context usage / task summary. |
| `subagent_reload` | **Kill + reconnect** a running subagent without losing context (resumed from its saved session, picks up freshly loaded tools/extensions/MCP). Also resumes paused/finished sessions directly. Match by `taskId` / `agent` / `sessionId`; none given = all. |
| `subagent_stop` | Kill a task and its descendants without resuming; no selector triggers the fast machine-wide emergency stop. |
| `subagent_gc` | Remove completed/dead rmux panes only; live workers are never touched. |

### External worker registry and item gate

Active workers are mirrored to `/tmp/pi-agent-notify/.active-workers.json`. Registry mutations use an inter-process lock, fsync + atomic replace, heartbeat pruning, and an unguessable owner token. A stale/wrong token cannot overwrite or unregister a live task. Normal sync/async completion unregisters the task, and the same transaction enforces a machine-wide active-worker cap (default: 15).

Every live worker automatically owns a unique control key `worker:<taskId>` so the main agent can send ordinary steering messages through `pi-agent-notify` even when the original task omitted a domain key. If a task prompt also states `itemKey=<safe-key>` or legacy `itemId=<six digits>`, that domain key is registered in addition to the control key; starting a second active worker for the same domain key and cwd is rejected. Generic domain examples include `mission:hkg_super_v13`, `alpha:KPO237EN`, and `ci:run-42`. Put the exact domain key near the beginning of long/watcher tasks; the automatic worker key is for control messaging and does not replace domain ownership for durable watcher leases.

An unfinished worker waiting for an external state change must remain active rather than producing `agent_settled`. With `pi-agent-notify`, it starts one bounded detached watcher, calls `arm_notification_wait`, and finishes its model turn. The notify extension holds the child's `agent_end`, so the process and registry ownership stay live without a foreground sleep/poll script; a directed `notify_agent.py send --item <ownedKey> --to <taskId> "message"` event queues the next run in the same session. Delivered/terminal workers do not arm a lease and exit normally.

The main agent can do all of this from plain language, e.g.:

> Send the live subagent working on task X a follow-up instruction.

> Reconnect the subagent working on task X — I updated its tools/extensions/MCP runtime.

Use directed notification for ordinary instruction changes. Use `subagent_reload` only when the worker has finished/paused or must restart to load runtime changes.

### Agent definitions

Agents are plain markdown files with frontmatter, in either:

- `~/.pi/agent/agents/*.md` (user/global)
- `<project>/.pi/agents/*.md` (project-local, nearest ancestor of cwd)

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls, bash
model: claude-haiku-4-5    # optional, defaults to the main provider
---
System prompt for the agent goes here.
```

Changes to agent definitions are picked up on the next call (no reload needed). When an agent omits `model`, the child now inherits the dispatching main session's active `provider/model` and thinking level; an explicit agent `model` remains pinned.

### Commands

```
/agent:my-agent task...        # run one agent
/agents                        # list available agents
/agent-live                    # TUI view of running agents (or Alt+A)
/agent-results                 # recent results
/agent:resume <session-id> [continue instructions]
/agent:stop-all                # immediate machine-wide emergency stop
/agent:gc                      # remove dead rmux panes only
```

## Safety limits

Safe defaults prevent a worker-decomposition loop from becoming a process storm:

- **One managed nested generation is allowed by default.** Main sessions run at depth 0, workers at depth 1 may create child workers at depth 2, and depth-2 workers cannot spawn again.
- **At most 15 active durable workers machine-wide.** Admission is serialized through the worker-registry lock, so concurrent Pi sessions cannot race past the limit.
- **Parallel requests are capped at 15 entries and chains at 8 before either sync or async dispatch.** Omitted `async` means `false`.
- **Recursive stop is the default.** `subagent_stop { taskId: ... }` includes descendants. Calling `subagent_stop` with no selector, or typing `/agent:stop-all`, terminates the shared `pi-agents` rmux session in one operation and signals fallback children.
- Only rmux panes with `pane_dead=0` count as running. Completed panes are removed automatically; `/agent:gc` cleans historical dead panes without touching live workers.
- Every task immediately records parent task/session/path/depth, and new child session headers receive standard `parentSession` lineage for `/resume` and session viewers.
- Discovery reads only bounded log prefixes, so emergency management does not load multi-gigabyte task logs into memory.

Advanced opt-in overrides (set before starting Pi):

```bash
PI_SUBAGENT_MAX_DEPTH=3    # allow two nested generations; default 2
PI_SUBAGENT_MAX_ACTIVE=20  # machine-wide cap; default 15, hard-clamped to 64
```

Raising these limits weakens the safety boundary. Prefer explicit main-session orchestration.

### What persists

```
~/.pi/agent/agent-logs/<taskId>.jsonl              # slim event stream (live text + message_end)
~/.pi/agent/sessions/--<encoded-cwd>--/            # session files (pi --export can render HTML)
```

- **Session mirror** is written in real pi session format, so `pi --export <mirror>.jsonl out.html` gives you a browsable conversation transcript.
- **Log slimming**: only `text_delta` streaming events, `message_end`, and skeleton events are kept; thinking/tool-call delta streams, full `agent_end` snapshots, and tool outputs are dropped/truncated (measured −82% vs the previous filter, with zero loss of what the UI needs).

### Context usage

Each subagent reports its context usage like the main agent footer: `21.6%/1m` (tokens from `message_end.usage`, window from `models-store.json`). Shown in the widget, `subagent_list`, `/agent-live`, and completion notifications.

The footer widget only shows tasks belonging to the CURRENT session (parent session id is recorded in each task's agent-log via a `pi_subagent_parent` marker at spawn, and re-registered on `/reload`); every pi also registers its session file into its rmux window's `@pi_session` option so the desktop app can attribute panes exactly.

### Completion notifications

When a subagent finishes, the main session is notified via `pi.sendUserMessage(..., { deliverAs: "steer" })` with the agent's final text output (and usage). Notifications are **always** sent on success:

- If the agent produced a final text summary, that summary is delivered (capped at 4000 chars).
- If the agent ended with a tool-call-only or empty final message (e.g. after polling an async job), the notification falls back to `已完成任务，但无文本输出` so the main agent still knows the task finished — plus a pointer to `/agent-results` or `subagent_reload` to inspect/continue.

Both the RMUX and spawn-fallback completion paths behave the same way. Errors in result persistence / notification are logged to the extension console rather than silently dropped.

## How it works

```
pi (main session)
  └─ subagent tool → runAsyncSingleAgent()
       ├─ rmux available? → new window in `pi-agents` session
       │    pi --mode json -p "Task: ..." 2>&1 | jsonl-filter.cjs >> agent-logs/<taskId>.jsonl
       │    (filter also mirrors message_end → pi session file)
       │    poll every 2s → pane dead = done → notify main session
       └─ no rmux → plain spawn (same filtering/mirroring, no persistent pane)
```

- **Kill / resume**: `subagent_reload` kills the pane (or proc), finds the session id from the log's first `session` event, and re-launches with `pi --session <id>` — full context restored, fresh process picks up new tools/extensions/MCP. Spawned processes receive `PI_SUBAGENT_DEPTH` and the configured hard limits.
- **Completion detection** polls pane state (`returnCode` / `(dead)`); no fixed timeout, long tasks are never killed prematurely.
- **Task ledger** lives on `globalThis` so `/reload` does not lose track of running tasks.

## Notes

- Subagents inherit the project's `.mcp.json` config when present (`--mcp-config`), so a shared MCP server works out of the box.
- This package replaces pi's built-in `subagent` tool with the durable version.
- Avoid `/reload` while subagents are mid-flight (old task closures keep running on the old module instance); prefer `subagent_reload` to hot-update a running agent.

## Recent fixes

- **Resume a settled session by canonical file path** — completed-session resume resolves and passes the verified non-mirror session file instead of an ambiguous bare session id, preventing continuation data from being split into a mirror.
- **Recursive subagent process-storm guard** — nesting is limited to one managed generation by default, active workers have an atomic machine-wide cap, sync/async batch limits share the same preflight validation, omitted `async` no longer accidentally means `true`, targeted stop walks descendants, and `/agent:stop-all` provides a constant-time rmux emergency brake.
- **Orphan/dead-pane management** — external discovery now checks `pane_dead` instead of treating every retained rmux window as running; completion removes its window, `/agent:gc` safely removes historical dead panes, and task/session lineage is persisted at dispatch time.
- **Inherited model instead of exhausted global default** — an unpinned agent previously launched without `--model`, so the child silently used `settings.json`'s default model even when the parent was running a different healthy model. This could make every subagent immediately end with `stopReason=error` (for example a 429 weekly usage limit). Unpinned single/parallel/chain/resumed agents now inherit the parent model and thinking level.
- **Exact provider diagnostics + named-agent resume** — provider `errorMessage` is included in completion notifications instead of a generic “last turn interrupted” message. New task logs persist agent identity, so `subagent_reload` resumes the same named agent rather than degrading it to `_worker`.
- **Completion notification when a subagent ends with empty text** — previously the completion notification was only sent when the parsed `finalText` was non-empty, and `finalText` came from the *last* `message_end` only. A subagent that finished with a tool-call-only / empty assistant message (common after polling an async backtest) produced empty text, so the main agent never got notified. Fixed by extracting the last **non-empty** assistant text across all `message_end` events and always notifying on success (with a fallback message when there is no text).
- **Completion notify without `deliverAs` threw during streaming** — `pi.sendUserMessage()` during an active main turn required a `streamingBehavior`; results were dropped and an extension error surfaced. Now uses `{ deliverAs: "steer" }` so results are queued and delivered after the current turn's tool calls finish.

## Development

Internal/technical documentation (architecture, log format, filter details, known issues & fix history, publishing roadmap) is kept **out of the public repository** — see the `docs/` directory in a local checkout (gitignored, not published).
