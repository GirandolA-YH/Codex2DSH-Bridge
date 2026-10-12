# Codex2DSH-Bridge

## 创作者说明

本插件制作者没有程序开发背景，使用 Codex 与 DSH 共同构建了该插件。

代码内容仅通过 Agent 审计，未经过专业开发者的人工代码审计。对于后续发现的 bug 及 GitHub Issues，建议使用者自行使用 Agent 进行修改和开发。

> **先读[中文阅读指南](中文阅读指南.md)**：21个核心源码文件含中文注释。本仓库发布R4源码、离线测试和可填写配置示例。当前交付为需构建的MCP服务源码；尚未制作可一键安装的Codex插件包。

本地 stdio **MCP 服务**：让 Codex 主动拉起 DSH（DeepSeek Harness）headless 作业、等待、读取结果、必要时取消。Codex 负责规划与验收，DSH 负责实施；本桥不替任何一方作判定。

- 五个工具：`dsh_health`、`dsh_submit`、`dsh_status`、`dsh_result`、`dsh_cancel`
- 长任务采用「提交后轮询」，不依赖 MCP Tasks 扩展，任意标准 MCP 客户端可用
- 单活动作业（第二个作业返回 `BUSY`，不隐式排队）；`requestId` 幂等，重试不会重复启动付费任务
- 任务文件在受理时**冻结并计算 SHA-256**，之后修改原文件不影响已受理作业
- `audit` 模式在一次性快照中运行，源目录与快照前后都做清单哈希比对
- 输出分页 + 每流 5 MiB 上限；凭据脱敏后才落盘与返回

## 可选：DSH 内的作业监控面板

| 组件 | 安装 / 接入位置 | 是否必需 | 额外依赖 |
| --- | --- | --- | --- |
| 主 MCP 桥 | **Codex 侧**：在本机构建服务并配置到 Codex 的 MCP 列表 | 桥接需要 | 无需监控面板或 sidebar |
| 作业监控面板 | **DSH 内**：DSH profile 的插件目录和右侧栏 | **单独选装** | 必须先安装并启用 `dsh-better-sidebar` |

[optional/dsh-job-monitor](optional/dsh-job-monitor/README.md) 提供 DSH 右侧栏的只读作业监控。**安装主 MCP 桥不会安装此面板，也不会安装 `dsh-better-sidebar`**：根包没有 monitor/sidebar 依赖、workspace 或安装钩子，根构建只包含桥源码，根安装包的 `files` 白名单排除 `optional/`。克隆仓库会取得可选源码，但不等于安装插件。

需要面板时，另行在 DSH 内安装并启用 `dsh-better-sidebar`（当前核对版本 `0.24.1`），再按组件说明手动安装面板。安装、私有路径配置、回退和审查范围见组件说明及 [审查记录](optional/dsh-job-monitor/AUDIT.md)。

## 快速开始

```powershell
npm ci                       # 新目录安装锁定依赖；已有同锁依赖可复用
npm run build                # tsc → dist/
npm test                     # 离线测试套件（假子进程，不调用真实模型）
npm run setup:selftest       # 生成固定 Node 路径及本目录内的自测工作区

# 手动启动（stdout 只允许 MCP 协议帧，日志全部走 stderr）
npm start                    # 读取刚生成的 config/bridge.config.json，运行 fake
```

`setup:selftest` 不覆盖已有配置，不启动 DSH，不调用模型；生成的 state/tasks/impl/audit/report 路径全部位于本目录的 `sandbox/selftest`。可提交 `sandbox/selftest/tasks/demo.md` 到 `impl/implement`。不要直接启动含占位路径的模板。生产使用前，另行填写生产样例的绝对 launcher、任务根与工作区，并创建目录；检查每个实际写路径，再手工接入 MCP。无凭据样例可以审查，真实配置/凭据必须从审计输入排除。

接入 Codex：检查 `config/codex-mcp.example.toml` 的路径后，把 `[mcp_servers.dsh_bridge]` 段落**手工**追加到项目的 `config.toml`。本包不会自动修改、启用或重启任何其他程序的配置。

生产配置应保存在部署目录之外，如 `C:/DshBridge/bridge.config.json`；MCP 示例指向此固定文件。先将填写后的生产模板复制到该位置，再接入 MCP。`setup:selftest` 生成的 fake 配置继续用于隔离自测。

## 历史兼容性记录（2026-10-09 实测）

| 安装 | 版本 | headless 参数面 |
|---|---|---|
| 桌面版运行时 `~/.dsh/dsh-runtimes/dsh-primary-runtime/runtime.json` | **0.2.0-rc.2** | 支持 `--json`、`--session-id <id>`、`-`（任务走 stdin） |
| 桌面版 asar 内 `@deepseek-ai/dsh`、`dsh-headless` | **0.2.0-rc.2** | 同上 |
| PATH 上的全局 npm `dsh` | 0.1.0-rc.6（旧） | 只接受 `[task...]` 位置参数与 `-h` |

这些是当时的测试版本，不代表当前最新版本。安装其他DSH版本前请核对启动入口和参数。

因此 `runner.production` 用显式 launcher 描述（`command` + `argsPrefix` + `env`），两种安装都能驱动：

- **npm CLI**：`command = node.exe`，`argsPrefix = [".../@deepseek-ai/dsh/lib/bin.js"]`，`taskTransport = "argv"`
- **桌面 0.2.0-rc.2**：`command = "DeepSeek Harness.exe"`，`argsPrefix = ["--expose-internals", ".../resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"]`，`env = { "ELECTRON_RUN_AS_NODE": "1" }`，可选用 `taskTransport = "stdin"`、`jsonEvents = true`

环境变量与凭据由 DSH 自己管理：本桥不读取、不复制、不转述任何密钥；`dsh_health` 只报告凭据文件的**存在性布尔值**。

## 配置

完整样例见 `config/`：

| 文件 | 用途 |
|---|---|
| `bridge.config.example.json` | 生产样例（npm CLI 0.1.0-rc.6 launcher） |
| `bridge.config.desktop.json` | 生产样例（桌面 0.2.0-rc.2 launcher） |
| `bridge.config.selftest.json` | 离线自测模板；由 setup:selftest 生成可运行的本地配置 |
| `codex-mcp.example.toml` | Codex MCP 配置片段（只供人工检查） |
| `dsh.offline.example.yml` | 桌面版 headless 本地模型覆盖模板；须填写实际模型 ID、端点与容量 |

关键字段：

- `stateDir`：作业状态、任务副本、脱敏日志、审计报告落地处
- `taskFileRoots`：允许的任务文件根目录，**按路径分段判定**（`..`、名称前缀混淆、junction/symlink 指向范围外都会被拒绝）
- `workspaces`：`workspaceId → { dir, allowedModes }`；`audit` 工作区额外绑定 `sourceWorkspaceId` 与 `reportDir`
- `runner`：`type = production|fake`；launcher 只能是服务端配置，调用者无法覆盖命令、运行器路径、环境变量、模型或工作目录
- `limits`：超时范围、每流捕获上限、结果分页上限、内联任务阈值
- `recovery.killOrphanedChildrenOnStart`：默认 `false`（见下）

### 固定状态根与升级

生产状态放在部署目录之外的固定数据目录。两个生产模板使用 `C:/DshBridge/state` 占位值；替换为本机长期绝对路径，并让面板 stateRoot 指向同一目录。独立验收账本也保持固定位置（如 `C:/DshBridge/acceptance-ledger.json`），由审计方维护，面板只读。升级只更换代码目录，保留生产配置、stateDir、账本与面板配置；新增 workspaceId 时显式更新交付白名单。

迁移前先排空作业并确认旧 owner 已停止。保留 jobs/、requests/，排除 owner.lock / owner.heartbeat.*，由新实例重新取得所有权；同步重定位记录中的 taskFileAccepted、stdoutLog、stderrLog 等状态根内绝对路径。保留原树作为回退证据，拒绝覆盖冲突的 jobId 或请求索引。修改面板配置后重启 DSH，核对 config-status、心跳以及作业列表与磁盘双向一致。

bridge.config.selftest.json、setup:selftest 和其他 fake/offline 配置使用隔离状态根，不受生产面板监控。

### 作业时限

两个生产模板的默认值和上限均为 **1800 秒（30 分钟）**。提交时使用 `timeoutSeconds: 1800`，或省略参数采用默认值；显式提交较短时限仍按该值执行。修改生产配置后重新连接桥，先用 dsh_health 核对实际加载值。已受理作业保留原时限；面板从各自 job.json 读取并显示。代码协议支持的最大范围仍为 3600 秒，生产模板将其收窄为 1800 秒。

### 本地离线模型

使用已核对的桌面版 launcher。先从本机服务的 `/v1/models` 确认模型 ID，将 `config/dsh.offline.example.yml` 填好后复制到固定私有位置。模板仅注册一个 loopback 模型路由，禁用云端模型/搜索/遥测与子代理，自动模型重试为 0；模型 ID、容量及协议兼容字段必须符合实际服务。

在桥配置的 `runner.production` 中合并以下字段，保留原 launcher、profile 和其他设置：

```json
{
  "extraArgs": ["--patch", "C:/DshBridge/dsh.offline.yml"],
  "env": {
    "ELECTRON_RUN_AS_NODE": "1",
    "LOCAL_OFFLINE_API_KEY": "local-offline-placeholder"
  }
}
```

占位值仅供不需要真实认证的本机服务。需要认证时使用本机私有配置，真实凭据不提交仓库；覆盖层的 apiKeyEnv 必须与启动环境中的变量名一致。DSH 禁止从项目 .env 加载 DSH_ 前缀变量，此类变量只能由启动环境注入。该用法无需临时替换全局 headless 配置。填写后的配置先用 DSH --dump-config 核对默认模型、路由与云端插件状态，再重新连接桥并通过五工具真实验收；旧 npm CLI 的额外参数能力须另行验证。

受限 Windows 工具环境中，node --test 曾因测试子进程 spawn EPERM 失败。对于本次验证的 node:test 文件，直接运行 `node <test-file.mjs>` 可执行全部已注册测试。任务必须要求测试数大于 0、失败/跳过数明确；同类失败命令最多尝试两次后停止并报告。需要子进程的集成测试应另行核查权限，不能据替代命令通过声称其已修复。

该离线层禁用 credentials 服务后，相关 authorization 插件可能显示等待依赖的启动提示。本机小任务已完成并通过独立验收；其他插件或版本是否依赖该服务仍须单独核查。

### 本机实机核对（2026-10-12）

固定根迁移后，本机通过 Codex 五工具向真实 DSH 派发离线模型小任务，最终修复作业完成：15 项自测与 18 项独立行为检查通过，输出完整且无截断。DSH 实机 API 的配置/心跳正常，列表和详情显示 completed / pass，12 条记录与磁盘零差异。过程中一次启动配置错误和一次零项测试循环均保留为失败/取消记录；结果不依赖退出码单独判定。真实配置、作业 ID、任务、日志和交付文件未发布。

这些是本机部署的有限验收结果；其他机器、DSH/sidebar 版本及完整 UI/辅助技术范围仍须独立验证。

## 状态机

`starting → running → stopping → completed | failed | cancelled | timed_out | interrupted`

- `completed` 仅表示**子进程退出码 0**，不代表任务被验收或正确
- `stopping` 是**非终态**清理状态（FIX-001 R03）：取消、超时、关闭都先进入 `stopping`，只有在确认本桥拥有的进程**真的停止**之后才写终态
- 执行名额在 `stopping` 期间**继续占用**：此时任何新提交返回 `BUSY`，不会出现两个任务同时存活
- `cleanup` 字段记录每次尝试的真实结果（`method`/`killed`/`exited`/`detail`/`attempts`/`confirmed`）。清理未确认时状态保持 `stopping`，`dsh_cancel` 可重复调用以重试清理；**从不把未核实的停止标成已成功清理**
- 正常关闭时若清理无法确认，终态记为 `interrupted` + `CLEANUP_UNCONFIRMED`，而不是 `cancelled`
- 审计作业的最终哈希在**停止确认之后**才计算，因此清理期间落进快照的晚写会被最终比对覆盖
- 终态只写一次，晚到的 exit 事件只记录在 `lateExit`，不覆盖终态

### FIX-002 边界（第二轮复核后的行为）

- **截断单位是"未结束的整行"**（F2-01）：一旦因为容量上限丢弃过任何流数据，保留的未结束行就再也无法证明不含已知凭据（凭据可能延续在被丢弃的字节里），因此**整行丢弃**、只写一条独立的截断说明；丢弃字节数计入 `droppedBytes`。单次调用最多解码当前 pending 预算，超大 chunk 不会被整体解码或缓冲；无换行巨量输出不会留下任何内容；EOF 未截断时最后一行仍按行脱敏写出
- **孤儿清理必须先证明进程身份**（F2-02）：只有当作业在启动时记录了子进程身份（创建时间 + 可执行文件路径 + 命令行摘要，仅在开启自动清理时记录），且重启后重新探测能**全部匹配**时，才会终止该 pid。凭 PID 存活、文件里写的 PID、可复用的 owner PID、模糊进程名都不算证明；证明不了就**不杀**、返回 `ORPHAN_UNRESOLVED`、阻止新执行并给出人工诊断——**不要把"打开清理开关"当作归属不明时的默认建议**
- **`cleanup.confirmed` 的证明范围**（F2-02）：`true` 仅表示"本桥观察到自己拥有的根进程已停止，**并且**这次停止可归因于本桥自己的进程树终止（`killed=true` + `exited=true`）"。它**不**证明脱离进程树的进程已消失；无法归因时 `confirmed=false`，`cleanup.error` 说明原因（延迟到达的终止证据会在稍后补记）
- **所有权是动态的**（F2-03）：完整锁记录通过原子重命名写入，没有 `{}` 占位阶段；陈旧/废弃锁的接管靠"原子改名让位"仲裁，同一时刻只有一个赢家；**新鲜但不可读**的锁视为写入中，一律不覆盖。`owned` 每次实时复核：失锁、`release`、心跳写失败都会**立即撤销执行与持久化权限**，停掉本实例仍在运行的作业（`OWNERSHIP_LOST`），且不再改写记录
- **读不到的证据不是"没有证据"**（F2-04）：作业记录结构非法/不可解析、或 jobs 目录无法枚举 → 记为完整性错误并**拒绝新执行**（`REQUEST_INDEX_UNREADABLE`），不会因为"没读到"就推断"没执行过"；索引还必须与目标作业的 `jobId`/`requestId`/`requestHash` 三者一致，否则按不可用索引走恢复流程（绝不复用别人的 job）
- **页字节上限是硬上限**（F2-05）：`limits.resultPageMaxBytes` 在加载阶段必须 ≥ 4（最大 UTF-8 码点），更小的配置直接 `CONFIG_INVALID`；`paginate` 对 <4 的预算抛 `INVALID_ARGUMENT`。因此码点前进不再需要"首码点越界"的豁免，任何成功页都不超预算
- **超时范围在服务端强制**（R2-05）：MCP schema 声明 `timeoutSeconds` 为 `minimum: 1, maximum: 3600`，服务端也按同一窗口受理。`loadConfig` 要求 `limits` 的 min/default/max 三者互相一致且都落在 1–3600 内（`maxTimeoutSeconds: 9000`、`defaultTimeoutSeconds: 1.5`、min > default、min > max 都直接 `CONFIG_INVALID`，不是被静默夹取）；`JobManager` 对 0、负数、小数、3601+ 明确返回 `INVALID_TIMEOUT`，即使调用方用的是绕过 `loadConfig` 的手工配置也把窗口钳在 3600
- **故障注入与生产隔离**：`faults.*` 在 `runner.type = production` 时于配置加载阶段被拒绝（`CONFIG_INVALID`）；`runner.fake.killBehaviour` 仅存在于 fake runner

### 状态目录独占与异常恢复（FIX-001 R04）

- 一个 `stateDir` 同时只有一个活 owner（`owner.lock` + 心跳）。第二个进程启动时**明确失败**（退出码 2，stderr 报 `STATE_DIR_BUSY`），不会接管、不会改写活 owner 的作业；进程内第二个 `JobManager` 则进入只读：能查状态、不能提交
- 心跳过期（`ownership.staleHeartbeatMs`）或 owner pid 已死 → 陈旧锁被接管；**只有可复用 PID 不能证明归属**，所以新鲜心跳优先于 PID 存活判断
- 异常重启：原先活动的作业标记 `interrupted`（`errorCode: INTERRUPTED`），**绝不自动重跑**
- 若某作业记录的 pid 仍存活且本桥从未确认其停止，则该 pid 被视为**可能的孤儿**：默认**不杀**（无法排除 PID 复用），而是拒绝新作业并给出处理指引（`ORPHAN_UNRESOLVED`）；开启 `recovery.killOrphanedChildrenOnStart` 也必须先证明进程身份；身份未知时仍然拒绝清理与新执行。孤儿状态会持久化，跨重启持续生效，直到被确认清理或人工处理

错误码是契约的一部分：`INVALID_ARGUMENT`、`INVALID_MODE`、`INVALID_TIMEOUT`、`UNKNOWN_WORKSPACE`、`WORKSPACE_DIR_MISSING`、`WORKSPACE_MODE_NOT_ALLOWED`、`EMPTY_TASK`、`TASK_FILE_NOT_FOUND`、`TASK_FILE_UNREADABLE`、`TASK_FILE_TOO_LARGE`、`TASK_FILE_NOT_UTF8`、`PATH_NOT_ALLOWED`、`JOB_NOT_FOUND`、`JOB_RECORD_UNREADABLE`、`REQUEST_CONFLICT`、`REQUEST_INDEX_UNREADABLE`、`BUSY`、`STATE_DIR_BUSY`、`ORPHAN_UNRESOLVED`、`ORPHAN_IDENTITY_UNVERIFIED`、`OWNERSHIP_LOST`、`RUNNER_UNAVAILABLE`、`SPAWN_FAILED`、`STATE_WRITE_FAILED`、`SNAPSHOT_FAILED`、`AUDIT_REQUIRES_SNAPSHOT`、`AUDIT_SOURCE_MODIFIED`、`AUDIT_SNAPSHOT_MODIFIED`、`AUDIT_UNDETECTED_INPUT`、`CLEANUP_UNCONFIRMED`、`CONFIG_INVALID`、`INTERNAL_ERROR`。

### 幂等索引（FIX-001 R05/R06）

- 索引文件名是 `sha256(requestId)`，不是 requestId 本身：`round:one`、`CON`、`NUL`、`COM1`、大小写不同的 id、128 长度 id 在 Windows 上都能正常落盘（原始 id 保存在 JSON 内并在读取时校验）
- 索引缺失、损坏、指向不存在的作业 → 从作业记录**恢复**索引并复用原作业；无法证明请求是新的（索引不可读且无作业证据）→ `REQUEST_INDEX_UNREADABLE`，**拒绝**而不是冒险再跑一次
- 受理是事务性的：任务副本/job.json/索引任一步落盘失败 → 回滚并返回 `STATE_WRITE_FAILED`，不会留下 `starting` 作业，也不会留下索引残片

## 测试专用开关（生产环境不要开启）

以下配置只服务于回归测试，均**不能**由 MCP 调用方选择：

| 配置 | 作用 |
|---|---|
| `runner.fake.killBehaviour.mode = "noop"` | 报告一次"没有真正发生"的停止，用于验证"未确认清理"路径（真实子进程仍然存活） |
| `runner.fake.killBehaviour.delayMs` | 让停止变慢，用于验证 `stopping` 期间名额不被释放 |
| `faults.failJobWriteOnce` / `faults.failRequestWriteOnce` | 在受理持久化的指定步骤各注入一次失败，用于验证回滚后不会留下 `starting` 作业 |

这些开关的存在本身是被测契约的一部分（FIX-001 允许"注入故障，但须注明模拟范围"）；`reports/test-results.json` 会逐条标注哪些用例是逻辑模拟。

## 审计模式

`mode = "audit"` **不能**直接在实现目录里跑：

1. 受理时校验审计工作区与所有 implementation 工作区目录不重叠（重叠在配置阶段即失败）
2. 运行时把源目录复制成一次性快照，子进程 `cwd = 快照`
3. **复制与清单使用同一份编译后的策略**（FIX-001 R02）：被拒绝的文件绝不会被复制，被复制的文件一定进入清单；两者不一致时直接拒绝审计
4. 记录源目录与快照的清单摘要（文件数、总字节、聚合 digest）
5. 结束时重新计算两侧清单并比对；源被动过 → `AUDIT_SOURCE_MODIFIED`；快照被动过 → `AUDIT_SNAPSHOT_MODIFIED`；快照里出现策略未覆盖的文件或新 junction/symlink → `AUDIT_UNDETECTED_INPUT`；三种情况状态都是 `failed`
6. 报告写到独立 `reportDir`：`<jobId>.audit.json`（策略、文件数、两侧摘要、差异、findings、隔离边界声明）与 `<jobId>.audit-final.md`

### 快照输入策略

- `audit.include`：允许集合（glob，空表示"除拒绝项外全部"）。**include 不能重新放行内置硬拒绝项**：若某个 include 规则会匹配到硬拒绝集合中的模式（例如 `.env`、`**/*AUDIT*.md`、`**/*.pem`、`**/*`），配置在加载阶段直接 `CONFIG_INVALID` 并列出冲突的内置模式，而不是接受后再被拒绝项悄悄压回去
- `audit.exclude`：拒绝集合（**始终优先**）。规则语义：含 `/` 的按根相对路径匹配；不含 `/` 的按**文件名**匹配（所以 `*.log`、`.env` 不是字面文件名）
- **配置只做追加，不能整体替换内置拒绝集**（R2-02）：生效策略 = 内置硬拒绝集 ∪ 配置的 `audit.exclude`。因此 `audit.exclude: ["node_modules"]` 不会让 `.env`、`credential*`、`*AUDIT*.md` 重新进入快照；不配置 `audit.exclude` 时行为与修复前完全一致。生效策略会原样写进作业记录与审计报告，拷贝与清单**共用同一个匹配器与同一份结果**
- 内置拒绝集合覆盖：日志、`.env*`、`.dsh/**`、`sessions/**`、`reports/**`、`audit/**`、`*AUDIT*.md`、真实配置（`bridge.config.json`/`*.real.json`/`auth.json`/`.credentials*`）、各类凭据与私钥文件、`node_modules`/`.git`/`state`/`dist`/`tmp`/`cache`
- 策略把**所有**文件都排除时，审计被拒绝（`SNAPSHOT_FAILED`），不会拿一个空快照冒充审计
- Windows 上 include/exclude/目录下溯/冲突校验均忽略大小写；其他平台保持大小写敏感。复制时跳过并计数 junction/symlink，结束检查发现快照中的链接则报告非 clean，绝不跟随目标；报告区分 copyTimeSkippedReparsePoints 与 postRunReparsePoints。

## 状态写失败与恢复证据

Windows 原子替换对 EPERM/EACCES/EBUSY 做至多 5 次有限尝试，总退避 150ms；不先删除旧文件。受理事务失败不启动任务。启动前先落盘 spawnPending 意图，成功得到句柄/PID 后清除此标志；重启看见未完成意图却没有 PID 时，记录 interrupted 并以 ORPHAN_UNRESOLVED 阻止新工作，不能猜测无进程、自动清理或重跑。

已启动后落盘失败会保留句柄并尝试停止拥有的任务；停不下来则继续 stopping/占槽，仍可 cancel。普通停止或终态落盘失败不会抛出事件回调：job.persistence.durable=false、health.integrity.pendingStateWrites 明示内存/磁盘差异，新提交被 STATE_WRITE_FAILED 阻止。submit/cancel/shutdown 会有限尝试重写待落盘记录；这只是文件写重试，绝不重新运行任务。持久化恢复后才放行。永久故障后若进程退出/主机断电，内存中的终态可能丢失，不能声称可靠持久化；重启依据最后可靠记录保守恢复。缺 job.json 的存留 job 目录或不支持的记录结构是 integrity 错误，绝不当作没有历史；只有 childIdentity 缺失的已知旧格式仍按身份未知处理。

## 已知边界（务必按实际能力理解）

- **目录校验不是 OS 沙箱**：`taskFileRoots`、`workspaces` 的包含性检查只决定本桥**把哪些路径交给运行器**。子进程仍以本桥的 OS 用户运行，原则上可以访问其他路径；也没有从 OS 层阻止任意 shell 访问。首版用「一次性快照 + 改动检测」代替只读隔离，正式目录接入前需要另行验证 DSH 侧的权限策略
- **脱敏有边界**：采用模式匹配（OpenAI 风格 key、GitHub token、**与方案名无关的 `Authorization` 头**、裸 `Bearer`/`Basic`、常见赋值、URL 内嵌凭据）加配置的已知值列表。**无法识别所有未知秘密**。落盘策略是"整行脱敏后才写"（见下），已知秘密与受支持格式不会以完整值或可恢复片段出现在日志里；含换行的 literal 在配置阶段被拒绝，因为按行匹配无法保证。**显式配置的值不会被静默丢弃**：`redaction.extraLiteralSecrets` / `redaction.extraSecretEnv` 解析出的任何非空值都参与脱敏，长度不限（1 个码点也照脱）；空 literal 无法做子串匹配，在配置加载阶段直接 `CONFIG_INVALID`（报错只含下标/长度，不含值）。声明了但**没有值**的环境变量（未设置或为空串）不是泄漏：它只作为"声明边界"按名字出现在 `dsh_health.capabilities.redaction.unresolvedSecretEnvNames` / `emptySecretEnvNames` 里，诊断中永远不出现真实值。**错误与诊断同样脱敏**：`job.json`、`dsh_status`/`dsh_result` 返回体、`audit.findings`、审计报告与 stderr 日志在落盘前和返回前都走同一套规则，通用嵌套诊断递归脱敏；完整记录只处理明确的诊断字段，机器身份、状态、错误码、路径与哈希原值保留（R2-07）
- **写入竞争**：单活动作业只能保证本桥不并发；Codex 自身在审计期间不得同时修改被审代码，否则会如实报 `AUDIT_SOURCE_MODIFIED`
- **不负责**：Web UI、远程网络访问、自动升级、并行多代理、无限修复循环、持久调度与自动唤醒；也不会读改用户的全局 Codex/DSH 配置

## 输出、脱敏与 Unicode（FIX-001 R01/R07）

- 每条流：原始字节 → **增量 UTF-8 解码**（`StringDecoder`，非法字节变成 U+FFFD）→ **按整行脱敏** → 才写内存与磁盘。未结束的行留在内存里，直到换行或 `end()` 才脱敏写出，因此已知 secret 不会被切成两段后在同一条日志里被重新拼出来
- 每流存储上限仍为 5 MiB：无换行的超长流会在达到上限后停止存储并打截断标记，多余数据继续排空丢弃
- **截断说明永远写在所有保留正文之后**（R1-05）。磁盘格式因此固定为「保留正文 + 一条独立说明」，说明里的丢弃字节数是最终值。脱敏会让文本变长（`***REDACTED***` 比被替换的字面量长），所以最后一段保留正文可能在"已经判定截断"之后才写出——说明必须在 `end()` 里最后写，不能一判定就写
- `dsh_result` 按 **Unicode 码点**分页：`offset`/`nextOffset` 计量码点，单页不会拆开代理对；单页字节上限依旧生效，但**至少返回一个码点**以保证游标永远能前进（`offsetUnit: "code-point"`）
- **任务文件必须是合法 UTF-8**（R2-03）：受理时用严格（fatal）解码器校验，GBK 等非 UTF-8 字节、截断的多字节序列、孤立续字节、overlong 编码一律在**受理前**以 `TASK_FILE_NOT_UTF8` 拒绝——不启动 runner、不占用执行槽、不消耗 jobId、不写索引。这样"冻结副本 SHA-256 = 记录里的哈希"这条交接证据链对每个被受理的任务都逐字节成立（`Buffer#toString('utf8')` 会把非法字节静默替换成 U+FFFD，副本长度和哈希都会对不上原文件）。UTF-8 BOM 属于合法 UTF-8，原样保留，因此副本仍与记录哈希一致；扫描/指针交接与内联交接共用同一条校验路径

### R1–R4 契约修复（本轮）

- **R1 启动前取消**：`dsh_submit` 返回后作业才在下一个 `setImmediate` 里真正 spawn。若在此之前收到 cancel/shutdown（或作业仍停留在 `stopping`），`#startJob` **不会启动任何进程**，作业直接进入终态；`cleanup.method = "not-started"`、`killed=false`、`exited=false`、`confirmed=true` 表示"不存在属于本桥的进程，无需树杀"，绝不虚构一次成功的 kill。运行态的正常取消/超时、树杀归因（`killed && exited`）、`BUSY` 与 late-exit 规则不变；cleanup 等待期间若进程确实已经启动，则照常调用该 handle 的 kill 并保留归因
- **R2 配置秘密**：见"已知边界"与"输出、脱敏与 Unicode"两条
- **R3 终态日志读取**：终态作业的 `dsh_result` 不再把读取失败当成空输出。日志缺失/不可读 → `OUTPUT_LOG_UNREADABLE`；可读但字节数少于记录值（被清空/截断/缩短）→ `OUTPUT_LOG_INCOMPLETE`。正常零输出（记录字节数为 0 且从未写过日志）仍然是成功；正常截断标记、多字节文本、重启后读取都保持正确。只读被请求的那条流，因此另一条流损坏不会让健康的单流读取失败（`stream=combined` 才同时要求两条都完好）。作业记录的历史语义（`completed` / exit code）不会因为日志损坏而被改写
- **R4 活动输出字段**：运行中的作业，`job.output.stdoutStoredBytes/stderrStoredBytes/stdoutRawBytes/stderrRawBytes/truncated` 来自**实时内存 capture**，不再是全 0 或假 `false`；`job.output.live=true` 标示这一点。`page.truncated` 与 `job.output.truncated` 始终一致；终态与重启后 `live=false`，字段值来自持久化记录
- **R1-05 截断日志的写出与校验规则一致**：写入端保证「保留正文 + 一条独立说明（后缀）」（见上）；读取端不再要求"说明恰好从记录字节数处开始"，而是用**有边界的完整性核验**——磁盘上多出的字节必须恰好构成**一条**格式合法、丢弃字节数为整数的说明，且删掉它之后剩下的字节数**正好等于**记录的保留字节数。因此：合法的大日志（含因脱敏扩容而越界的输出）可完整分页；从保留正文里删字节、把说明改坏、追加垃圾字节、或出现**两条逐字节相同的说明**（旧格式无法判定哪条是说明）一律 → `OUTPUT_LOG_INCOMPLETE`，绝不猜、绝不静默成功。非法/不可枚举的说明位置不做全库正则替换，正文里"长得像说明"的行**原样保留**（未截断日志尤其如此）
- **旧格式兼容策略**：修复前写入的日志可能把说明写在最后一段保留正文**之前**（`正文 + 说明 + 正文`）。这种历史日志仍可读，但只在证据唯一时才接受；一旦出现歧义（例如正文里含一条逐字节相同的说明），判定为 `OUTPUT_LOG_INCOMPLETE`，而不是挑一条删掉。**歧义拒绝对新旧两种格式一视同仁**：规范后缀格式在"正文里含一条逐字节相同的说明"时同样判为 `OUTPUT_LOG_INCOMPLETE`——判据是磁盘上的字节布局是否唯一可解释，不是日志的写入年代。无论新格式还是旧格式，**都不静默删除正文**

### R2 契约修复（本轮）

- **R2-01 / R2-06 `Authorization` 按结构脱敏**：规则匹配「头名 + `:` + 方案名 + 空白 + 凭据」，方案名大小写不敏感、不限于 `Bearer`/`Basic`。单引号、双引号、序列化引用与 `Digest` / AWS 逗号分隔参数均覆盖；引用未闭合时保守遮蔽至行尾。只替换凭据，保留头名、方案名和值之外的排障上下文；整行缓冲覆盖跨 chunk 切分。头格式明确给出的非空凭据没有最小长度，`Authorization: Token abc` 也要遮蔽。只提到头名的散文、无凭据的头、普通 token 单词保持原样；无头名的未知短秘密仍属于模式匹配边界
- **R2-02 审计拒绝集只增不减**：见"快照输入策略"
- **R2-03 非 UTF-8 任务被明确拒绝**：见"输出、脱敏与 Unicode"
- **R2-04 / R2-07 只对诊断字段脱敏**：`errorMessage`、`audit.findings`、`cleanup.detail/error`、展示命令及 FATAL/日志诊断使用同一规则，在落盘和返回前遮蔽。JobRecord 与审计报告中的 jobId/requestId、状态、错误码、工作区映射、机器路径、哈希、日期、审计策略与清单保留精确值；即使配置的短 literal 恰好与这些机器字段同名，也不能递归替换整份记录。通用嵌套诊断载荷可以递归处理，完整状态/MCP/审计结构不可以。脱敏标记是保留标记，多次诊断门控不再将它反复展开
- **R2-05 超时范围服务端强制**：见 FIX-002 边界一节

## Token 与成本（Codex 循环的省钱用法）

每轮作业都是**全新的 DSH 会话**，没有隐式上下文继承；重复投喂的内容会被重复计费。本桥提供以下杠杆（`dsh_health.tokenEconomy` 里机器可读）：

1. **文件交接，不要粘贴**：把计划写成任务文件，让桥交给子进程冻结副本；超过 `inlineTaskMaxChars`（默认 16384 字符）自动降级为「短指针 + 绝对路径 + SHA-256」，正文不重复进 prompt
2. **分页读结果**：先看 `page.totalChars`，再按需取窗口；结果尾部通常就是结论。单次最多 64 KiB，避免把 5 MiB 日志灌进模型上下文
3. **修复轮只传证据**：传「审计结论 + 失败证据 + 变更文件清单」，不要重传整个仓库；每轮都是新会话，重传的上下文要再付一次钱
4. **审计走快照**：审计在快照里跑，不需要 Codex 与 DSH 在同一轮各自全量重读实现目录
5. **别默认开 `--json`**：NDJSON 事件流比默认"只打印最终答复"大得多，只在确实需要结构化事件时打开
6. **审计与实施分离**：同一产物只做一次全量独立审计即可；发现问题优先小范围修复，避免整轮重跑

> **`--session-id` 续聊**：DSH 0.2.0-rc.2 支持 `dsh --profile headless --session-id <id> "继续"`，理论上可让修复轮复用上一轮会话、显著省 token。v1 **故意不暴露**它：桥的会话契约要求"每次实施、修复和审计默认创建新的 DSH 会话"，而把调用方提供的 session id 透传进命令行会破坏"调用者不能传任意参数"这条边界。若 Codex 认可，正确做法是新增服务端配置项（例如按 workspace 固定 resume 目标）再开口，而不是放开参数。

## 测试与证据

```powershell
npm test          # 全量：node --test --test-concurrency=1 test/
node test/00-units.test.mjs   # 纯函数层（无子进程），可在受限沙箱内直接执行
node test/18-fix-r1-r2-r3-r4.test.mjs   # 本轮 R1–R4 回归，进程内假 Runner，无子进程
```

> 在 headless 沙箱里 `node --test <files>` 会为每个测试文件 `spawn` 子进程并以管道收集输出，可能直接 `EPERM`；此时可逐文件 `node test/<file>.test.mjs`（同一进程内运行，不 spawn 测试文件），但这**只对本身不需要子进程的用例有效**：走真实 MCP stdio 的 A0x 用例仍需要能 spawn 子进程的环境。

- 测试用**假子进程**模拟成功/失败/超时/取消/大输出/子孙进程/秘密，`reports/test-results.json` 逐条标注 `mocked` 与模拟范围
- 真实 MCP 协议由官方 `@modelcontextprotocol/sdk` 客户端经 **stdio** 完成 initialize / tools/list / 五个 tools/call / 正常断开，并断言 stdout 只有 JSON-RPC 帧
- `npm test` **不包含**真实模型调用。作者本地冻结R4曾通过一次受控的Codex工具层真实DSH验收；本仓库不公开任务、日志或生产配置，也不把历史验收当作其他机器的通过证明。发布范围见 `reports/IMPLEMENTATION-REPORT.md`。

> 在受限（沙箱/CI 受限）环境里，`node --test` 自身需要 spawn 子进程并建立管道，可能因命名管道策略失败（Windows 上表现为 `spawn EPERM`）。此时改用非受限终端，或直接执行单文件与 `node test/00-units.test.mjs`。

## 故障排查

| 现象 | 处理 |
|---|---|
| `dsh_health.runner.available = false` | 看 `runner.diagnostic`：launcher 可执行文件或入口脚本路径不对；asar 路径只校验到 `.asar` 归档本身 |
| `RUNNER_UNAVAILABLE` | 同上；受理前即拒绝，不会留下卡在 `starting` 的作业 |
| `BUSY` | 已有活动作业；先 `dsh_status` 收敛，或 `dsh_cancel`，或复用同 `requestId` 重试 |
| `REQUEST_CONFLICT` | 同 `requestId` 换了内容；换新 id，不要复用 |
| `PATH_NOT_ALLOWED` | 任务文件不在 `taskFileRoots` 内（含 `..`、前缀同名目录、junction 逃逸） |
| 作业一直 `running` | 检查 `pid`；`timeoutSeconds` 到点会终止进程树并置 `timed_out` |
| 桥崩溃后作业 `interrupted` | 预期行为；`pid` 保留。残留子进程默认不清理，见上文策略 |

## 卸载

卸载代码时删除实现目录即可。若已手工把 MCP 段落写进 Codex 的 `config.toml`，请自行删除该段落；本包不会自动回滚别人的配置。固定数据目录中的作业记录、任务副本、脱敏日志和验收账本独立保留；确认不再需要历史证据后再另行清理。

## 目录结构

```
src/            实现（config/paths/redact/capture/store/hashing/audit/proctree/runners/jobs/mcp-server）
fixtures/       假子进程（测试专用，绝不用于真实任务）
test/           A01–A18及R4回归用例 + 测试脚手架
config/         配置样例与 Codex MCP 片段（不含凭据）
tools/          inspect-asar.mjs（只读解析桌面 app.asar）、报告与清单生成
reports/        IMPLEMENTATION-REPORT.md、test-results.json、source-manifest.json
```

## 发布与许可

生产示例中的 `YOUR_USER` 和 `C:\Projects\Codex2DSH-Bridge` 都是占位值，须按本机目录填写。不要直接运行生产模板。自动孤儿清理保持关闭，DSH模型与凭据沿用DSH自身配置。先用离线自测确认安装，再在Codex中确认五个工具可见并调用 `dsh_health`。真实作业需要单独明确任务范围、预算及验收标准，失败不会自动付费重试。

本项目采用 [MIT License](LICENSE) 开源。使用、修改和分发时，请保留许可证中的版权及许可声明。第三方依赖仍遵循各自的许可证。
