# Changelog / 更新日志

[English README](README.md) | [中文 README](README.zh-CN.md)

## Unreleased / 未发布

### Added / 新增

- **Parent cold-restart recovery:** `/agent:prepare-upgrade` persists exact parent/child canonical-session relationships and a ready handoff manifest; `session_start` and `/agent:recover` reacquire prepared asynchronous RMUX tasks, restore monitoring and collect offline completions without restarting workers. Plain-spawn, synchronous and chain runs are not eligible.
  **主代理冷重启恢复：** `/agent:prepare-upgrade` 持久化精确的主/子 canonical 会话关系和 ready 交接 manifest；`session_start` 与 `/agent:recover` 接管已准备的异步 RMUX 任务、恢复监控并收集离线完成结果，不重启 worker。普通 spawn、同步和 chain 运行不支持交接。

- **Controller fencing:** a locked, durable controller-lease registry binds each task to its original parent session, authenticates controller PID/token, and increments fencing generations on takeover. Stale controllers cannot mutate managed state; foreign sessions and competing live controllers are refused.
  **Controller fencing：** 加锁、持久化的 controller-lease 注册表将任务绑定到原主会话，验证 controller PID/token，并在接管时递增 fencing generation。过期 controller 无权修改受管状态；其他会话及竞争中的活跃 controller 会被拒绝。

- **Receiver-owned handoff and heartbeat keeper:** verified worker receivers retain the original ownership token/keys after parent exit. A bounded detached keeper mirrors fresh receiver heartbeats for legacy notify readers (default/maximum 24 hours), with a fresh PID/nonce handshake per preparation and retirement when superseded or authority is lost. Worker taskId/runId/nonce and existing watcher/wait leases remain unchanged; original lease deadlines are not extended.
  **Receiver ownership 交接与心跳 keeper：** 已验证的 worker receiver 在主代理退出后保留原 ownership token/keys。有界、脱离父进程的 keeper 为旧 notify 读取方镜像新鲜 receiver 心跳（默认/最大 24 小时）；每次准备重新握手 PID/nonce，被取代或权限状态丢失时退出。Worker taskId/runId/nonce 和既有 watcher/wait lease 不变，原 lease 截止时间不延期。

- **Legacy bootstrap and main-notify identity import:** `scripts/prepare-upgrade.mjs --session …` prepares an idle old main externally without loading/reloading Pi or signaling workers. It requires exactly one live canonical parent runtime and a fresh exact main-notify registration, preserves the main's runId/nonce in durable identity state with a 24-hour offline bound, and refuses conflicting identities.
  **旧 main bootstrap 与主 notify 身份导入：** `scripts/prepare-upgrade.mjs --session …` 从外部为处于空闲状态的旧 main 准备交接，不加载/reload Pi，也不向 worker 发信号。必须只有一个存活的 canonical 主 runtime 且具备新鲜、精确的主 notify 注册；脚本将主 runId/nonce 原样保存到持久化身份状态，设置 24 小时离线边界，并拒绝冲突身份。

- **Side-by-side launcher:** `scripts/pi-safe-upgrade.sh` validates the ready manifest, installs an exact Pi version under a separate version directory and resumes the recorded canonical parent/cwd. Read-only `--dry-run` prints commands. It rejects live original/duplicate mains or receivers, still-live late tasks omitted from preparation, and incomplete/mismatched existing installs, without replacing global Pi or restarting workers.
  **版本侧装 launcher：** `scripts/pi-safe-upgrade.sh` 验证 ready manifest，将精确 Pi 版本安装到独立版本目录，并按记录的 canonical 主会话/cwd 恢复。只读 `--dry-run` 打印命令。它拒绝仍存活的原/重复 main 或 receiver、准备后遗漏的活跃任务及不完整/版本不符的已有安装，不替换全局 Pi，也不重启 worker。

- **Bilingual documentation:** complete English and Simplified Chinese READMEs document installation, tools/commands, upgrade/bootstrap steps, shared state directories, identity requirements, lease boundaries and verification limits.
  **双语文档：** 完整英文和简体中文 README 说明安装、工具/命令、升级/bootstrap 步骤、共享状态目录、身份要求、lease 边界及验证限制。

### Fixed / 修复

- **Authenticated reload refresh:** preserve an existing worker's original domain keys, token, PID and cwd instead of re-deriving item ownership from a resume/steering prompt. An incidental number in batch context can no longer rebind a worker to a different occupied item. Restore refuses wrong credentials or missing reservations; one refusal does not abort parent runtime registration.
  **经验证的 reload 刷新：** 保留已有 worker 原 domain keys、token、PID 和 cwd，不从恢复/追加指令重新派生事项所有权。批次上下文中的其他数字不再把 worker 重绑到另一已占用事项。错误凭据或缺失 reservation 仍拒绝恢复；单个拒绝不再中断主 runtime 登记。

- **Native ESM cache compatibility:** versioned registry/handoff implementations are imported directly by new runtime code and the external bootstrap. Canonical entry points remain compatibility re-exports for fresh consumers. This avoids old `.mjs` namespaces lacking new functions after Pi factory reload; rewriting a loaded canonical file alone cannot update its Node namespace.
  **原生 ESM 缓存兼容：** 新 runtime 和外部 bootstrap 直接导入带版本的 registry/handoff 实现；原入口为新消费者保留兼容 re-export。避免 Pi factory reload 后旧 `.mjs` namespace 缺少新增函数；只改写已加载原文件无法更新 Node namespace。

- **Failed-reload bootstrap:** explicit `--parent-pid` permits recovery when a failed startup removed the runtime slot, but only with independently verified PID and a fresh exact main-notify identity matching PID/session/cwd. Conflicting or multiple runtime slots remain refused; no cwd guessing or ownership override.
  **失败 reload 的 bootstrap 补救：** runtime 槽因启动失败而缺失时，可显式使用 `--parent-pid`，但必须独立核验 PID，且新鲜精确的 main-notify 身份须匹配 PID/session/cwd。冲突或多个 runtime 仍拒绝；不按 cwd 猜测，不覆盖 ownership。

- **Session-isolated `subagent_list`:** default listing is limited to the calling main session's exact task tree, including known descendants and cold-recovered tasks. Same-cwd/process workers, foreign sessions and unknown lineage no longer leak into the default list. Read the current caller session on every invocation; explicit parent-task links prevent a reused worker session ID from bridging unrelated task trees. `scope: "machine"` is an explicit main-only opt-in; worker self/ancestor/sibling restrictions remain unchanged.
  **`subagent_list` 主会话隔离：** 默认仅显示调用它的主会话所属任务树，包括已知后代及冷恢复任务；相同 cwd/进程、其他会话和来源不明的 worker 不再混入默认列表。每次调用读取当前主 session；优先使用明确 parent task，防止复用 worker session ID 时串入其他任务树。主代理可显式设置 `scope: "machine"` 查看机器级任务，worker 的自身/祖先/兄弟管理限制不变。

- **Completion ACK and replay safety:** persist the outbox before publication and acknowledge only the tagged user message in the parent transcript (or its durable delivery marker), not a successful queueing call. Retry unacknowledged publication after 30 seconds while idle; use stable `resultId` for at-least-once delivery. Consumers still need deduplication and idempotent external actions.
  **完成 ACK 与重放安全：** 发布前持久化 outbox，仅以主会话 transcript 中带标签的 user message（或其持久化投递 marker）确认，不把成功入队当作确认。空闲时，未确认发布经过 30 秒后重试；用稳定 `resultId` 实现至少一次投递。消费端仍需去重并保证外部动作幂等。

- **Cross-session completion isolation and reload compatibility:** recovered delivery remains bound to the exact original parent; `/new` cannot receive another session's result. Existing legacy callback-owned tasks retain their callbacks and controller renewal rather than gaining a second monitor; ambiguous legacy origins are refused and receiver ownership is not downgraded by reload.
  **防跨会话串投与 reload 兼容：** 恢复投递始终绑定精确的原主会话，`/new` 不会接收其他会话的结果。已有 legacy 回调管理的任务保留回调，仅续期 controller，不增加第二套监控；来源不明确的 legacy 投递会被拒绝，reload 不会降级 receiver ownership。

- **Conservative recovery failures:** RMUX query errors remain `unknown`, not completed. Missing ownership is not forcibly recreated, live different tokens are not overwritten, failed preparation does not publish a ready authorization, and already-finished untracked history is not replayed as new work. Different parent sessions must be handed off separately.
  **保守处理恢复失败：** RMUX 查询错误保持 `unknown`，不误报完成；不强行重建缺失 ownership、不覆盖活跃的其他 token；准备失败不会发布 ready 授权，已完成但未跟踪的历史不会作为新任务重放。不同主会话须逐一交接。

### Tests / 测试

- Added a real JITI/native ESM warm-cache reproduction and versioned dependency recovery, reservation-refresh credential/key preservation checks, a real extension-host reload collision fixture, and explicit-PID bootstrap validation/refusal tests using disposable state.
  新增真实 JITI/原生 ESM 热缓存复现及版本化依赖恢复、reservation 刷新凭据/key 保留检查、真实扩展 host 的 reload 事项碰撞 fixture，以及使用临时状态的显式 PID bootstrap 验证/拒绝测试。

- Added pure lineage tests and real extension-host list calls for same-cwd foreign workers, `/new`/caller-session switches, unknown ownership, descendants of settled parents, reused worker session IDs, explicit machine scope and worker scope refusal.
  新增纯任务关系测试和真实扩展 host 列表调用测试，覆盖同 cwd 的其他会话 worker、`/new`/调用 session 切换、未知归属、已结束父任务的后代、复用 worker session ID、显式机器级查看及 worker scope 拒绝。

- Added controller-lease, receiver-registry, recovery, extension-host, launcher and main-notify identity regression suites to `npm run check`: cold takeover and fencing, foreign/live controller refusal, offline outbox/ACK/retry, unchanged receiver identity/wait leases, bounded keeper handshakes, legacy bootstrap/reload, cross-session isolation, unknown liveness and read-only launcher validation.
  将 controller-lease、receiver-registry、recovery、extension-host、launcher、main-notify identity 回归测试加入 `npm run check`：覆盖冷接管与 fencing、其他/活跃 controller 拒绝、离线 outbox/ACK/重试、receiver 身份及 wait lease 不变、有界 keeper 握手、旧 main bootstrap/reload、跨会话隔离、未知存活状态及只读 launcher 验证。
- Tests use disposable state, isolated processes and mock host/RMUX adapters. Neither these tests nor the scripts certify every Pi/provider/RMUX/notify version combination or a live model-backed upgrade. See the README for a disposable-project validation workflow.
  测试使用可丢弃状态、隔离进程和 mock host/RMUX adapter。这些测试及脚本均不保证所有 Pi/provider/RMUX/notify 版本组合兼容，也不是带真实模型的升级认证。可丢弃项目验证流程见 README。

## Earlier changes / 既有变更

Selected references from the current Git history, not an inferred release schedule. No release versions or dates are assigned here.

以下依据当前 Git 历史选取，不推测发布计划，也不为它们编造版本号或发布日期。

- `2aab3ce` — Keep worker task text out of argv to prevent accidental `pkill`/`pgrep` self-kill. / 将 worker 任务文本移出 argv，避免 `pkill`/`pgrep` 意外匹配并终止自身。
- `1b623d0` — Keep the RMUX pane result in completion scope. / 保持 RMUX pane 查询结果在完成处理的作用域中可用。
- `758ffc5` — Document installation/recovery boundaries; add MIT license and regression CI. / 补充安装与恢复边界，添加 MIT 许可证和回归 CI。
- `552bf5d`, `c866055` — Fence worker self-management and bound/manage durable task trees. / 阻止 worker 自我停止，并限制和管理持久化任务树。
- `107f43a`, `4958e79` — Default worker control channels and hardened ownership registry. / 添加默认 worker 控制通道并加固 ownership 注册表。
- `562d5f7`, `23dcf02` — Resume from the real canonical session instead of an ambiguous ID or mirror. / 从真实 canonical 会话恢复，而不是使用有歧义的 ID 或镜像。
- `917a10f`, `af2afba`, `f7fa23a` — Inherit effective context/model settings and preserve worker identity across reloads. / 继承有效上下文/model 设置，并在 reload 后保留 worker 身份。
