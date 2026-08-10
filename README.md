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
| `subagent_stop` | Kill a running subagent without resuming (session file preserved for later). |

The main agent can do all of this from plain language, e.g.:

> Reconnect the subagent working on task X — I just updated the MCP server.

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

Changes to agent definitions are picked up on the next call (no reload needed).

### Commands

```
/agent:my-agent task...        # run one agent
/agents                        # list available agents
/agent-live                    # TUI view of running agents (or Alt+A)
/agent-results                 # recent results
/agent:resume <session-id> [continue instructions]
```

### What persists

```
~/.pi/agent/agent-logs/<taskId>.jsonl              # slim event stream (live text + message_end)
~/.pi/agent/sessions/--<encoded-cwd>--/            # session files (pi --export can render HTML)
```

- **Session mirror** is written in real pi session format, so `pi --export <mirror>.jsonl out.html` gives you a browsable conversation transcript.
- **Log slimming**: only `text_delta` streaming events, `message_end`, and skeleton events are kept; thinking/tool-call delta streams, full `agent_end` snapshots, and tool outputs are dropped/truncated (measured −82% vs the previous filter, with zero loss of what the UI needs).

### Context usage

Each subagent reports its context usage like the main agent footer: `21.6%/1m` (tokens from `message_end.usage`, window from `models-store.json`). Shown in the widget, `subagent_list`, `/agent-live`, and completion notifications.

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

- **Kill / resume**: `subagent_reload` kills the pane (or proc), finds the session id from the log's first `session` event, and re-launches with `pi --session <id>` — full context restored, fresh process picks up new tools/extensions/MCP.
- **Completion detection** polls pane state (`returnCode` / `(dead)`); no fixed timeout, long tasks are never killed prematurely.
- **Task ledger** lives on `globalThis` so `/reload` does not lose track of running tasks.

## Notes

- Subagents inherit the project's `.mcp.json` config when present (`--mcp-config`), so a shared MCP server works out of the box.
- This package replaces pi's built-in `subagent` tool with the durable version.
- Avoid `/reload` while subagents are mid-flight (old task closures keep running on the old module instance); prefer `subagent_reload` to hot-update a running agent.

## Recent fixes

- **Completion notification when a subagent ends with empty text** — previously the completion notification was only sent when the parsed `finalText` was non-empty, and `finalText` came from the *last* `message_end` only. A subagent that finished with a tool-call-only / empty assistant message (common after polling an async backtest) produced empty text, so the main agent never got notified. Fixed by extracting the last **non-empty** assistant text across all `message_end` events and always notifying on success (with a fallback message when there is no text).
- **Completion notify without `deliverAs` threw during streaming** — `pi.sendUserMessage()` during an active main turn required a `streamingBehavior`; results were dropped and an extension error surfaced. Now uses `{ deliverAs: "steer" }` so results are queued and delivered after the current turn's tool calls finish.

## Development

Internal/technical documentation (architecture, log format, filter details, known issues & fix history, publishing roadmap) is kept **out of the public repository** — see the `docs/` directory in a local checkout (gitignored, not published).
