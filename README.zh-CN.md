# pi-subagent-durable

[English](README.md) | **简体中文** | [更新日志 / Changelog](CHANGELOG.md)

[![CI](https://github.com/roshameow/pi-subagent-durable/actions/workflows/ci.yml/badge.svg)](https://github.com/roshameow/pi-subagent-durable/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

为 [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 提供持久化后台子代理：委派长任务、查看实时终端、停止任务，再从保存的会话恢复。

适用于研究、批处理，以及需要跨越单轮对话持续执行的工作。

## 功能概览

> **父 session 退出升级，长期 worker 不停机，再回到同一个 canonical session 自动恢复。** 前提是异步 RMUX 任务已成功交接，并满足下文 notify/状态目录要求；不是任意退出都能恢复的保证。

- **持久化任务委派：** 支持单任务、并行和 chain，显式 `async: true` 可后台运行，并保存 Pi 对话会话。
- **实时可见与管理：** 可附着到 RMUX pane；查看 task ID/上下文用量；定向停止、从保存会话恢复或 reload runtime；安全清理已死 pane。
- **按主 session 隔离列表：** `subagent_list` 默认只显示调用主会话的任务树，而非全机器 worker；只有主代理显式选择机器级 scope 才能跨会话查看。
- **主代理升级不重启 worker：** 准备交接后，只退出父 session，侧装精确 Pi 版本；符合条件的 RMUX worker 持续运行。已有旧 main 可通过外部 bootstrap 首次迁移。
- **同 session 自动恢复：** 重新打开精确的 canonical 主会话，即可恢复任务监控并收集离线完成结果；`/agent:recover` 可重试对账。
- **带 fencing 的 ownership 与路由：** Controller lease 拒绝竞争/其他主会话，receiver ownership 保留 worker 身份，完成投递始终绑定原主会话。
- **持久化结果投递：** Outbox 落盘和 transcript ACK 提供带稳定 `resultId` 的至少一次结果投递；外部动作仍需去重与幂等。旧 receiver 兼容使用有界 24 小时 keeper，不延期 watcher lease。

## 安装

需要 Pi **0.80 或更高版本**、Node.js **22 或更高版本**。[RMUX](https://github.com/helvesec/rmux) 是可选依赖；没有 RMUX 时，worker 使用普通子进程，无法附着到实时终端 pane。

```bash
pi install git:github.com/roshameow/pi-subagent-durable
```

使用本地 checkout 时，在仓库目录执行以下命令之一：

```bash
pi install .       # 用户级安装
pi install -l .    # 项目级安装（另一种选择）
pi -e .            # 不安装，仅在本次运行中试用（另一种选择）
```

Pi 会自动安装声明的 `@rmux/sdk` 依赖。macOS 可用 `brew install rmux` 安装 RMUX。升级脚本使用 POSIX 工具（`bash`、`ps`、`rmux`）；版本侧装 launcher 还需要 `python3` 和 `npm`。

## 启动 → 停止 → 恢复

1. 在 `.pi/agents/` 或 `~/.pi/agent/agents/` 中添加 [agent 定义](docs/reference.md#agent-definitions)。
2. 让主代理通过 `subagent` 委派一个小任务；后台执行需显式设置 `async: true`。
3. 用 `subagent_list` 获取 task ID 并查看状态。已安装 RMUX 时，可以附着到 worker 的 pane。
4. 向 `subagent_stop` 传入该 **taskId**，定向停止此任务及其后代。
5. 向 `subagent_reload` 传入同一 **taskId** 和后续指令，从保存的会话继续。

[可复现演练](docs/walkthrough.md) 使用本地文件示例，列出了每一步应验证的结果。

## 升级主代理，不重启 RMUX worker

这是**主代理冷重启**，不是 worker reload：准备交接 → 只退出主代理 → 侧装 Pi 版本 → 恢复到**同一个 canonical 主会话**（真实会话文件）。整个过程中 worker 进程和 pane 持续运行。

### 前提条件与共享状态目录

- 仅支持**异步 RMUX** 任务（`async: true`）。普通 spawn、同步及 chain 运行均拒绝交接，即使同步运行拥有 RMUX pane 也不例外。RMUX、主机和会话存储必须持续可用。
- 此流程需要另行安装并配置 `pi-agent-notify` 集成。每个 worker 必须发布新鲜且精确匹配的 `.receiver-identity.json`，包括它的控制 key。针对主代理的定向通知，还需要主代理在 `<notify-dir>/.main-sessions/<parentSessionId>.json` 中有精确、新鲜的主 notify 注册；**旧 main 首次 bootstrap 必须有此注册**，缺失、过期或身份不匹配都会被拒绝。worker receiver 不能代替 main receiver。恢复后的主 notify 集成必须支持持久化主身份恢复。
- 准备、bootstrap、启动和恢复必须使用同一套状态目录。已有覆盖配置时，保持以下环境变量不变：

  | 环境变量 | 默认值 | 用途 |
  | --- | --- | --- |
  | `PI_CODING_AGENT_DIR` | `~/.pi/agent` | canonical 会话、runtime 注册、任务日志、账本和升级 manifest |
  | `PI_AGENT_NOTIFY_DIR` | `/tmp/pi-agent-notify` | main/worker receiver 注册及 worker ownership 注册表 |
  | `PI_AGENT_NOTIFY_STATE_DIR` | `~/.pi/agent/agent-notify` | 持久化 notify 身份和其他 notify 状态 |

  设置 `PI_CODING_AGENT_DIR` **不会**自动迁移 notify 状态。notify inbox 和状态也要保留；主代理离线期间清空它们可能使交接失效。
- 无法验证 canonical 会话、ownership token、worker receiver 身份或存活状态时，准备流程会保守拒绝（fail closed）。准备失败不代表可以退出或升级。

### 准备 → 退出 → 版本侧装 → 自动恢复

1. 在**空闲主代理**中运行 `/agent:prepare-upgrade`，确保没有待处理的对话工作。它持久化任务关系，将注册表 ownership 交给已验证的 worker PID，同时保留 token/keys，发布 ready manifest，并打印精确的 `cd … && pi --session '/absolute/parent.jsonl'` 命令。核对预期任务数、canonical 主会话路径及 keeper PID/截止时间。此步骤**不会向 worker 发信号、终止或重启 worker**。准备成功后冻结新任务派发。
2. **只退出主代理**。不要关闭共享的 `pi-agents` RMUX session，不要使用 `/agent:stop-all`，也不要 reload/重启 worker。
3. 确保更新后的扩展 checkout 可用且已配置，先检查，再单独安装一个**精确** Pi 版本（将 `<exact-version>` 替换为要验证的版本号）：

   ```bash
   bash /path/to/pi-subagent-durable/scripts/pi-safe-upgrade.sh \
     --version <exact-version> --session '/absolute/canonical-parent.jsonl' --dry-run

   # 检查打印的命令后，去掉 --dry-run 来安装并恢复：
   bash /path/to/pi-subagent-durable/scripts/pi-safe-upgrade.sh \
     --version <exact-version> --session '/absolute/canonical-parent.jsonl'
   ```

   launcher 将版本安装到 `~/.local/share/pi-versions/<exact-version>/`（可用 `PI_SAFE_UPGRADE_ROOT` 覆盖），在记录的 cwd 中用该版本的二进制及 `--session` 启动。它不会覆盖全局 Pi，也不会重启 worker。缺失/失败的准备、原主代理仍存活、同会话已有其他活跃 main/receiver，或准备后遗漏的新活跃任务，都会导致拒绝。安装阶段还会拒绝已有不完整/版本不符的安装目录。Dry-run 只读：验证交接并打印命令，不验证已安装版本、不安装也不启动 Pi。
4. `session_start` 会自动对账**同一个精确主会话**，获取带 fencing 的 controller lease，重建实时监控，并投递离线期间产生的完成结果。用 `/agent:recover` 重试对账，查看 controller 冲突或待确认的投递。其他主会话不能接管这些任务；竞争中的活跃 controller 也会被拒绝。

如果已有安全的安装，也可使用打印出的 `cd … && pi --session …` 命令。**不要**使用 `--continue`（最新会话可能属于子代理）、镜像文件作为 `--session` 参数，或以 `/new` 代替恢复。若原地更新 Pi/扩展会替换活跃 worker 仍在使用的文件，就不要这样更新；Pi 版本侧装本身不会自动隔离共享扩展文件。

交接以**主会话**为单位，而非 RMUX session。不同主会话要逐一使用各自的 canonical 文件准备和恢复。如果原进程还持有另一个主会话的 legacy 工作，准备会拒绝；应回到那个原始会话单独准备，不能把所有 worker 合并交给当前主会话。

### 当前主代理运行旧代码时的首次迁移

旧进程没有新命令。**不要仅为了准备交接而对它执行 `/reload`。** 在另一终端中，使用更新后的 checkout；先通过 `/session` 获取 canonical 主会话路径，再执行：

```bash
node /path/to/pi-subagent-durable/scripts/prepare-upgrade.mjs \
  --session '/absolute/canonical-parent.jsonl'
```

执行 bootstrap **之前**，让原主代理保持空闲、没有待处理的对话工作，并停止派发新任务。脚本验证只有一个存活且对应 canonical 主会话的 runtime 注册，以及新鲜、精确匹配的 main-notify 注册；将旧 main 的原始 runId/nonce 导入 `<notify-state-dir>/main-identities/`，设置 24 小时的离线身份边界；随后迁移现有异步 RMUX worker，不加载 Pi，也不向 worker 发信号。必须看到成功的 `Prepared …` 和 `Preserved exact main notification identity …` 输出，核对预期任务数及 keeper PID/截止时间，然后立即只退出原主代理。旧代码不能自动冻结派发；版本 launcher 会检测交接遗漏、准备后新派发且仍存活的任务。出现拒绝时，**先不要退出**。如已配置 `PI_CODING_AGENT_DIR`、`PI_AGENT_NOTIFY_DIR`、`PI_AGENT_NOTIFY_STATE_DIR`，必须保持原值。

如果仍有意 reload 旧主代理以加载这些命令，现有内存中的 legacy 回调会保留：恢复仅续期它们的 controller 权限，**不会**增加第二套完成监控。只有缺失的外部任务或已由 recovery 管理的任务才会重建监控。Reload 不会降级 receiver ownership。Legacy 完成 steering 保守绑定到原主会话；执行 `/new` 后，结果延后保存在原日志/账本中，而不注入新会话。来源不明确的 legacy 投递会被拒绝。首次迁移仍建议 bootstrap，因为它无需 reload 旧回调代码。

### 持久化与投递边界

- `<agent-dir>/agent-upgrades/<parentSessionId>.json` 是版本 launcher 必须验证的 ready manifest；仅提供会话路径不等于完成交接。
- `~/.pi/agent/durable-tasks/task-*.json`（或配置的 agent 目录下对应位置）保存完整任务/主代理/canonical 会话关系、原 ownership token/keys，以及完成结果 outbox（私有权限文件）。`.controllers.json` 保存加锁的 controller lease 和单调递增的 fencing generation。
- Receiver ownership 依据存活且精确匹配 task/cwd/PID 的身份，心跳不得超过 90 秒（允许最多 5 秒的未来偏差）。主代理退出不会撤销新鲜的 receiver-owned 任务。taskId、runId、nonce 及既有 notification-wait lease **均不改变**。特别是准备流程**不会延期已有 watcher/wait lease**，原截止时间仍有效。
- 准备会为仍读取注册表心跳的旧 notify worker 启动一个有界、脱离父进程的 receiver-heartbeat keeper，默认及最大期限均为 **24 小时**。它只镜像新鲜身份的时间戳，不伪造新鲜度、不发送事件；没有匹配的待处理 receiver 时退出。私有 PID/nonce/截止时间 marker 为 `.receiver-keeper.json`；显式重新准备会发布新的进程/nonce 握手并重设 keeper 的期限。被取代的 keeper 在下一次检查时退出；权限状态缺失或损坏时也会停止，而不是无限运行。须在报告的期限内恢复主代理。若需更长时间无人值守，更新后的 notify 集成也必须理解 receiver ownership。
- RMUX 查询失败表示 `unknown`，不表示任务完成；恢复连接后重试 `/agent:recover`。
- 完成结果采用 **at-least-once（至少一次）** 投递，用稳定的 `resultId` 标识。Outbox 在发送前落盘；只有主会话 transcript 包含带标签的 user message（或其持久化投递 marker）后，才记为已投递。发布未获确认时，会在主代理空闲且经过 30 秒后重试；`/agent:recover` 会报告待确认状态。发布与确认之间崩溃或队列延迟可能导致结果重放。消费端应按 `resultId` 去重，使用稳定 job/item key 让外部动作幂等，并在重试提交或写入前检查外部状态。这**不是**外部动作 exactly-once 保证，也不恢复进程/工具内存。
- 不会把已完成但未跟踪的历史日志当作新结果重放。Legacy 任务必须在主代理退出**之前**成功准备。恢复不会强行重建缺失的 ownership，也不会覆盖仍活跃的其他 token。

## 工具

| 工具 | 用途 |
| --- | --- |
| `subagent` | 执行单任务、并行任务或 chain |
| `subagent_list` | 默认只查看本主会话的任务树；主代理显式设置 `scope: "machine"` 才进行机器级查看 |
| `subagent_stop` | 停止选中的 worker 及其后代 |
| `subagent_reload` | 重启 worker 并从其保存的会话恢复 |
| `subagent_gc` | 清理已完成/已死的 RMUX pane |

单任务可省略 `agent`，使用通用 worker；`tasks` 用于并行委派，`chain` 在顺序步骤间传递 `{previous}`。省略 `async` 等于 `false`；后台任务必须显式请求 `async: true`。Agent 定义是带 `name`、`description` frontmatter 的 Markdown；新派发时重新读取定义。没有固定 model 的 agent 会继承主代理当前 provider/model 和 thinking level。

普通指令变更应使用定向 notify steering。`subagent_reload` 会刻意重启 worker 以加载 runtime 变化，**不属于**不重启 worker 的主代理升级流程。Worker 只能管理自己的后代，不能管理自己、祖先或兄弟任务。

### 按主会话隔离列表

`subagent_list` 默认使用 `scope: "session"`，只显示调用它的主会话所属任务及已知后代。相同 cwd、agent 名称或同一个 Pi 进程都不能证明归属；来源不明和其他会话的任务默认隐藏。每次调用读取当前 session ID，因此 `/new`、`/resume` 和冷重启不会继承其他会话的列表。Worker 恢复时即使复用了旧 session ID，也优先按明确的 parent task 判断任务树，避免串会话。

主代理确实需要机器级检查时，向 `subagent_list` 显式传入：

```json
{ "scope": "machine" }
```

Worker 调用者仍只能查看自己可管理的后代，不能请求机器级 scope。此改动只影响列表，不改变机器级 stop/reload 语义：主代理不带 selector 的管理操作仍是机器级；日常操作请使用精确 task ID。

### 命令

| 命令 | 用途 |
| --- | --- |
| `/agents` | 列出可用 agent 定义 |
| `/agent:<name> <task>` | 请求命名 agent（为用户/全局定义注册） |
| `/agent-live` 或 `Alt+A` | Agent 实时 TUI |
| `/agent-results` | 最近的结果 |
| `/agent:resume <session-id> [instructions]` | 恢复保存的 worker 会话 |
| `/agent:prepare-upgrade` | 验证并持久化当前主代理的异步 RMUX 交接；不重启 worker |
| `/agent:recover` | 对账此精确主会话的任务及离线结果 |
| `/agent:stop-all` | 机器级紧急停止；**不是**升级步骤 |
| `/agent:gc` | 仅清理已死 RMUX pane |

## “恢复”意味着什么

恢复重新打开已经保存到磁盘的会话数据。它**不是**进程内存 checkpoint：未完成的模型输出可能缺失；运行中的工具或外部任务不会自动回滚、去重或恢复。中断后，在重复动作前先检查外部任务状态。已 compact 的历史仍保持 compact 状态。

RMUX 提供持久化终端 pane。普通 spawn 降级路径不能附着到 pane，也不具有同样的终端断连行为。会话文件存在，不代表文件与进程能在主机/存储故障后自动幸存。

默认允许一层受控 worker 嵌套，每台机器最多 15 个活跃受管 worker。不带 selector 的 stop 是机器级操作；日常管理请显式使用 task ID。详见[限制与管理规则](docs/reference.md#safety-limits)。

定向 steering/watcher 集成额外使用 `pi-agent-notify`，本仓库不分发该集成。核心委派、list、stop 和 resume 工具不依赖此可选集成。

## 开发与验证

```bash
npm ci
npm run check
```

CI 执行 dispatch、identity、ownership、safety、inheritance、resume 和升级恢复回归检查。恢复测试使用临时目录、隔离进程及 mock host/RMUX adapter，覆盖主代理退出/恢复、离线完成、排队后的确认、竞争/其他主会话 controller、receiver 迁移、旧 main bootstrap 和未知存活状态。这些测试不能证明兼容所有 Pi/provider 版本，也不复现真实 RMUX/model 会话。升级脚本的检查只验证其检查到的身份/状态，**不保证跨所有 Pi 版本兼容**。依赖新的 Pi/RMUX/notify 组合之前，应在可丢弃项目中演练准备/退出/恢复，检查任务数、canonical 路径、receiver 存活、controller 获取和 transcript 确认。不要为了测试恢复而重复真实外部写入。

- [操作参考](docs/reference.md)：agent 定义、持久化、通知和内部机制。
- [Pi Desktop](https://github.com/roshameow/pi-session-viewer)：可视化浏览主/子会话。
- [Issues](https://github.com/roshameow/pi-subagent-durable/issues)：请提供 Pi、Node、RMUX 版本及最小复现。

[MIT 许可证](LICENSE)
