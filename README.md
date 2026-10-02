# pi-subagent-durable

**English** | [简体中文](README.zh-CN.md) | [Changelog / 更新日志](CHANGELOG.md)

[![CI](https://github.com/roshameow/pi-subagent-durable/actions/workflows/ci.yml/badge.svg)](https://github.com/roshameow/pi-subagent-durable/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Persistent background subagents for [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent): delegate a long task, inspect its live terminal, stop it, then resume from its saved session.

Built for research runs, batch jobs and other work that outlives a single conversation turn.

## Features

> **Exit and upgrade the parent session, keep long-running workers online, then automatically recover in the same canonical session.** Requires a successful handoff of asynchronous RMUX tasks and the notify/state prerequisites below; this is not an arbitrary-exit guarantee.

- **Durable delegation:** single, parallel and chain tasks, with explicit `async: true` for background work and saved Pi conversation sessions.
- **Live visibility and control:** attach to RMUX panes; list task IDs/context usage; target stop, saved-session resume or runtime reload; safely remove dead panes.
- **Session-isolated task lists:** `subagent_list` defaults to the calling main's task tree, not every worker on the machine; machine-wide inspection is an explicit main-only scope.
- **No-worker-restart parent upgrades:** prepare the handoff, exit only the parent and side-install an exact Pi version while eligible RMUX workers continue running. An external bootstrap supports an existing old main.
- **Same-session automatic recovery:** reopening the exact canonical parent restores task monitoring and collects offline completions; `/agent:recover` retries reconciliation.
- **Fenced ownership and routing:** controller leases reject competing/foreign parents, receiver ownership preserves worker identity, and completion delivery stays bound to the original parent session.
- **Durable result delivery:** a persisted outbox and transcript ACK provide at-least-once results with stable `resultId`; external actions still need deduplication and idempotency. Legacy receiver compatibility uses a bounded 24-hour keeper, not extended watcher leases.

## Install

Requires Pi **0.80 or later** and Node.js **22 or later**. [RMUX](https://github.com/helvesec/rmux) is optional; without it, workers use plain subprocesses and live pane attachment is unavailable.

```bash
pi install git:github.com/roshameow/pi-subagent-durable
```

For a local checkout, run these from the repository:

```bash
pi install .       # user-wide
pi install -l .    # project-local (alternative)
pi -e .            # try for one run without installing (alternative)
```

Pi installs the declared `@rmux/sdk` dependency automatically. On macOS, RMUX can be installed with `brew install rmux`. The upgrade scripts use POSIX tools (`bash`, `ps`, `rmux`) and the side-by-side launcher also requires `python3` and `npm`.

## Start → stop → resume

1. Add an [agent definition](docs/reference.md#agent-definitions) under `.pi/agents/` or `~/.pi/agent/agents/`.
2. Ask the main agent to delegate a small task to it with `subagent`, using `async: true` for background work.
3. Use `subagent_list` to obtain the task ID and inspect its status. With RMUX installed, attach to the worker's pane.
4. Use `subagent_stop` with that **taskId** to interrupt this task and its descendants.
5. Use `subagent_reload` with the same **taskId** and a follow-up prompt to resume the saved session.

See the [reproducible walkthrough](docs/walkthrough.md) for a local-file exercise and what to verify at each step.

## Upgrade the parent without restarting RMUX workers

This is a **parent cold restart**, not a worker reload: prepare the handoff → exit only the parent → install Pi side-by-side → resume the **same canonical parent session**. Worker processes and panes keep running throughout.

### Prerequisites and shared state

- Only **asynchronous RMUX** tasks are eligible (`async: true`). Plain-spawn and synchronous/chain runs are refused, even if a synchronous run has an RMUX pane. RMUX, the host and session storage must remain available.
- Install/configure the separate `pi-agent-notify` integration for this workflow. Each worker must publish a fresh exact `.receiver-identity.json`, including its control key. For main-directed notifications, the parent needs an exact, fresh main registration at `<notify-dir>/.main-sessions/<parentSessionId>.json`; **legacy bootstrap requires this registration** and refuses missing, stale or mismatched identities. A worker receiver alone is not a main receiver. The resumed main-notify integration must support durable main identity restoration.
- Use the same state directories during preparation, bootstrap, launch and recovery. Keep any configured overrides unchanged:

  | Variable | Default | Used for |
  | --- | --- | --- |
  | `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Canonical sessions, runtime slots, task logs, ledgers and upgrade manifests |
  | `PI_AGENT_NOTIFY_DIR` | `/tmp/pi-agent-notify` | Main/worker receiver registrations and worker ownership registry |
  | `PI_AGENT_NOTIFY_STATE_DIR` | `~/.pi/agent/agent-notify` | Durable notify identities and other notify state |

  Setting `PI_CODING_AGENT_DIR` does **not** by itself move notify state. Preserve the notify inbox/state too; clearing them while the parent is offline can invalidate the handoff.
- Preparation fails closed if canonical sessions, ownership tokens, worker receiver identity or liveness cannot be verified. A failed preparation is not permission to exit or upgrade.

### Prepare → exit → side-by-side install → automatic recovery

1. Run `/agent:prepare-upgrade` in the **idle parent**, with no pending conversation work. It persists task relationships, delegates registry ownership to the verified worker PID while preserving token/keys, publishes a ready manifest, and prints the exact `cd … && pi --session '/absolute/parent.jsonl'` command. Check the expected task count, canonical parent path and keeper PID/deadline. It **does not signal, kill or restart workers**. Dispatch is frozen after successful preparation.
2. Exit **only the parent**. Do not stop the shared `pi-agents` RMUX session, use `/agent:stop-all`, or reload/restart workers.
3. With this updated extension checkout available/configured, validate and install an **exact** Pi version separately (replace `<exact-version>` with the version you intend to test):

   ```bash
   bash /path/to/pi-subagent-durable/scripts/pi-safe-upgrade.sh \
     --version <exact-version> --session '/absolute/canonical-parent.jsonl' --dry-run

   # After reviewing the printed commands, omit --dry-run to install and resume:
   bash /path/to/pi-subagent-durable/scripts/pi-safe-upgrade.sh \
     --version <exact-version> --session '/absolute/canonical-parent.jsonl'
   ```

   The launcher installs under `~/.local/share/pi-versions/<exact-version>/` (override with `PI_SAFE_UPGRADE_ROOT`) and runs that version's binary from the recorded cwd with `--session`. It does not overwrite global Pi or restart workers. It refuses missing/failed preparation, a still-live original parent, another live main/receiver for this session, or a still-live unprepared late task. The installation phase also refuses an existing incomplete/mismatched version installation. Dry-run is read-only; it validates the handoff and prints commands but does not validate an installed version, install or start Pi.
4. `session_start` automatically reconciles that **exact parent session**, acquires fenced controller leases, rebuilds live monitoring and delivers completions produced while offline. Run `/agent:recover` to retry reconciliation and inspect controller conflicts or pending acknowledgment. A different parent session cannot acquire these tasks; a competing live controller is rejected.

The printed `cd … && pi --session …` command is also usable with an already-safe installation. Do **not** use `--continue` (a child may be the newest session), `--session` with a mirror file, or `/new` as a substitute. Do not update Pi/extensions in place if that would replace files still used by live workers; side-by-side Pi installation does not isolate shared extension files automatically.

Handoffs are **per parent session**, not per RMUX session. Prepare and resume different main sessions one at a time using each one's canonical file. If the original process still owns legacy work from another main session, preparation refuses; return to that original session and prepare it separately rather than combining all workers into the current parent.

### First migration when the current parent runs older code

The old process does not have the new command. **Do not `/reload` it just to prepare.** From another terminal, with this updated checkout available, use `/session` to obtain the canonical parent path, then run:

```bash
node /path/to/pi-subagent-durable/scripts/prepare-upgrade.mjs \
  --session '/absolute/canonical-parent.jsonl'
```

Keep the original parent idle with no pending conversation work and stop dispatching new work **before** invoking the bootstrap. It verifies exactly one live parent runtime slot and a fresh exact main-notify registration, imports the old main's exact runId/nonce into `<notify-state-dir>/main-identities/` with a 24-hour offline identity bound, and migrates existing async RMUX workers without loading Pi or signaling them. Require successful `Prepared …` and `Preserved exact main notification identity …` output, check the expected task count and keeper PID/deadline, then exit only that parent immediately. The old code cannot automatically freeze dispatch; the versioned launcher detects still-live late tasks omitted from the handoff. A refusal means **do not exit yet**. Keep the same `PI_CODING_AGENT_DIR`, `PI_AGENT_NOTIFY_DIR` and `PI_AGENT_NOTIFY_STATE_DIR` overrides if configured.

If you deliberately reload an older parent to load these commands, existing in-memory legacy callbacks are retained: recovery renews their controller authority but does **not** install a second completion monitor. Only missing external tasks or already recovery-managed tasks get rebuilt monitors. Receiver ownership is not downgraded during reload. Legacy completion steering is bound conservatively to its original parent; after `/new`, it is deferred to the original saved log/ledger rather than injected into the new session. Ambiguous legacy origins are refused. The bootstrap remains preferable because it needs no reload of old callback code.

### Reload troubleshooting

Reload must preserve an existing worker's authenticated item keys/token; a resume or steering prompt can mention a different item and is not a new ownership declaration. This implementation refreshes the original reservation instead of parsing that prompt again. A failed refresh is reported per task and does not abort the parent's runtime registration; missing or mismatched authority is never silently recreated.

Pi clears extension factories on `/reload`, but Node can retain native `.mjs` namespaces. New runtime code uses versioned registry/handoff entry points to avoid old namespaces missing newly added exports. Compatibility shims cannot refresh a namespace already loaded in a process; future ABI changes need a new module version or a fresh process. Prefer the external bootstrap for planned upgrades.

If an earlier failed reload removed the parent's runtime slot before writing its replacement, the bootstrap normally refuses. An operator may supply `--parent-pid VERIFIED_LIVE_MAIN_PID` after independently checking that process. This fallback still requires the **exact, fresh main-notify registration**, matching PID/canonical session/cwd, and refuses conflicting or multiple runtime slots; it does not guess a PID from cwd or bypass worker ownership:

```bash
node /path/to/pi-subagent-durable/scripts/prepare-upgrade.mjs \
  --session '/absolute/canonical-parent.jsonl' --parent-pid VERIFIED_LIVE_MAIN_PID
```

Do not clear the registry, stop the existing item owner, or exit the parent to bypass a preparation refusal. Require a successful handoff first.

### Persistence and delivery boundaries

- `<agent-dir>/agent-upgrades/<parentSessionId>.json` is the ready manifest required by the versioned launcher; a session path alone is not a handoff.
- `~/.pi/agent/durable-tasks/task-*.json` (or under the configured agent directory) stores full task/parent/canonical-session relationships, original ownership token/keys and the completion outbox (private files). `.controllers.json` stores locked controller leases and monotonic fencing generations.
- Receiver ownership uses a live, exact task/cwd/PID identity with a heartbeat no older than 90 seconds (5-second future tolerance). Parent death does not revoke a fresh receiver-owned task. taskId, runId, nonce and existing notification-wait leases are **not changed**. In particular, preparation does **not extend an existing watcher/wait lease**; its original expiry still applies.
- Preparation starts one bounded detached receiver-heartbeat keeper (maximum/default **24 hours**) for old notify workers that still read the registry heartbeat. It only mirrors fresh identity timestamps, does not fabricate freshness or send events, and exits when no matching pending receivers remain. Its private PID/nonce/deadline marker is `.receiver-keeper.json`; explicit preparation publishes a fresh process/nonce handshake and renews the bound. A superseded keeper retires on its next check; missing/corrupt authority stops it rather than leaving an unbounded process. Restart the parent within the reported bound. Updated notify integrations must also understand receiver ownership for longer unattended periods.
- An RMUX query failure is `unknown`, not completion; retry `/agent:recover` after restoring connectivity.
- Results are **at-least-once**, identified by stable `resultId`. The outbox is persisted before send; completion is marked delivered only after the parent transcript contains the tagged user message (or its durable delivery marker). Unacknowledged publication is retried after 30 seconds while the parent is idle; `/agent:recover` reports pending acknowledgment. A crash or a delayed queue in the publication/acknowledgment window can replay a result. Consumers must deduplicate by `resultId` and make external actions idempotent using stable job/item keys; inspect external state before retrying a submission or write. This does **not** provide exactly-once external actions or restore process/tool memory.
- Already-finished, untracked historical logs are not replayed as new results. Legacy tasks need successful preparation **before** the parent exits. Recovery does not forcibly recreate missing ownership or overwrite a live different token.

## Tools

| Tool | Purpose |
| --- | --- |
| `subagent` | Run a single task, parallel tasks or a chain |
| `subagent_list` | Inspect this main session's task tree by default; explicit `scope: "machine"` enables main-only machine-wide inspection |
| `subagent_stop` | Stop a selected worker and its descendants |
| `subagent_reload` | Restart a worker from its saved session |
| `subagent_gc` | Remove completed/dead RMUX panes |

Single calls can omit `agent` to use a generic worker; `tasks` runs parallel delegation and `chain` passes `{previous}` between sequential steps. Omitted `async` means `false`; request `async: true` explicitly for background work. Agent definitions are Markdown with `name` and `description` frontmatter; definitions are reread for new dispatches. An unpinned model inherits the parent's active provider/model and thinking level.

Use directed notify steering for ordinary instruction changes. `subagent_reload` deliberately restarts a worker to load runtime changes; it is **not** part of the no-worker-restart parent upgrade workflow. Worker callers can manage descendants only, not themselves, ancestors or siblings.

### Session-scoped listing

`subagent_list` defaults to `scope: "session"`: only tasks belonging to the calling main session and their known descendants are shown. Sharing a cwd, agent name or Pi process does not imply ownership; unknown lineage and unrelated sessions are hidden. The caller's current session ID is read on each call, so `/new`, `/resume` and cold restart do not inherit another session's list. Explicit parent-task lineage takes precedence when a resumed worker reuses an old session ID.

For deliberate machine-wide inspection from a main session, call `subagent_list` with:

```json
{ "scope": "machine" }
```

Worker callers remain limited to manageable descendants and cannot request machine scope. This is a listing change, not a change to machine-wide stop/reload semantics: selector-free management is still machine-wide for a main caller; use exact task IDs for ordinary management.

### Commands

| Command | Purpose |
| --- | --- |
| `/agents` | List available agent definitions |
| `/agent:<name> <task>` | Request a named agent (registered for user/global definitions) |
| `/agent-live` or `Alt+A` | Live agent TUI |
| `/agent-results` | Recent results |
| `/agent:resume <session-id> [instructions]` | Resume a saved worker session |
| `/agent:prepare-upgrade` | Verify and persist this parent's async RMUX handoff; never restart workers |
| `/agent:recover` | Reconcile this exact parent's tasks and offline results |
| `/agent:stop-all` | Machine-wide emergency stop; **not** an upgrade step |
| `/agent:gc` | Remove dead RMUX panes only |

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

CI runs dispatch, identity, ownership, safety, inheritance, resume and upgrade-recovery regression checks. Recovery tests use temporary directories, isolated processes, and mock host/RMUX adapters: parent exit/recovery, offline completion, queued acknowledgment, competing/foreign controllers, receiver migration, legacy bootstrap and unknown liveness. They do not prove compatibility with every Pi/provider version or reproduce a live RMUX/model session. The upgrade scripts' checks validate the identities/state they inspect, **not compatibility across all Pi versions**. Before relying on a new Pi/RMUX/notify combination, exercise the prepare/exit/resume flow in a disposable project and check task count, canonical paths, receiver liveness, controller acquisition and transcript acknowledgment. Do not repeat real external writes merely to test recovery.

- [Operational reference](docs/reference.md): agent definitions, persistence, notifications and internals.
- [Pi Desktop](https://github.com/roshameow/pi-session-viewer): browse parent and child sessions visually.
- [Issues](https://github.com/roshameow/pi-subagent-durable/issues): include Pi, Node and RMUX versions plus a minimal reproduction.

[MIT License](LICENSE)
