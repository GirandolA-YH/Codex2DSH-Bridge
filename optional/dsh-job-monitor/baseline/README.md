# dsh-monitor —— 本机只读 DSH 作业监控面板

M01 交付物。**只读**观察已验收的 `dsh-codex-bridge`（stdio MCP）留在状态目录里的元数据，
把「作业是否在运行 / 有没有新活动 / 用时与时限 / 有没有交付 / 执行结束后的独立验收状态」
做成一个中文本机页面，每 5 秒自动刷新。

它**不是**第二份 MCP 桥：不通过 SDK/CLI 拉起桥，不给桥加 HTTP 服务，不新增 owner，
不提交/取消/重试任何模型作业，也不写状态目录、requests、jobs 或账本。

```
node server.mjs                # 默认 http://127.0.0.1:4178/
node server.mjs --demo         # 演示夹具（页面显著标注“演示数据”）
node server.mjs --help         # 全部参数
```

> 演示模式使用系统临时目录中的夹具，退出时删除；生产只读模式是默认值，两者不会混合。

## 目录

| 路径 | 用途 |
| --- | --- |
| `server.mjs` | 唯一入口：解析参数、启动只读面板 |
| `src/config.mjs` | 命令行/配置文件解析，loopback 强制校验 |
| `src/paths.mjs` | jobId 校验、路径包含判断、重解析点拒绝 |
| `src/jsonRead.mjs` | 有上限、无泄漏的 JSON 读取 |
| `src/state.mjs` | 状态目录枚举、job.json 读取、日志文件 stat |
| `src/jobRecord.mjs` | job.json → 白名单字段（唯一出口） |
| `src/owner.mjs` | owner.lock + 心跳元数据 |
| `src/acceptance.mjs` | 独立验收账本读取 |
| `src/activity.mjs` | 日志文件活动（大小/mtime/增量） |
| `src/workspaceMap.mjs` | 交付目录白名单 + 本地名称映射 |
| `src/workspaceScan.mjs` | 白名单目录扫描（只读元数据） |
| `src/monitor.mjs` | 采样与响应组装 |
| `src/http.mjs` | 仅 GET 的 HTTP 层与安全响应头 |
| `public/` | 原生 HTML/CSS/JS（无框架、无 CDN、无字体外链） |
| `config/monitor.example.json` | 示例配置（状态根、账本、白名单、限额） |
| `fixtures/demo.mjs` | 演示/测试夹具生成器（含“禁止字段”诱饵） |
| `test/` | 离线自测（`node:test`，逐文件可运行） |
| `reports/` | 实施报告与源码哈希清单 |

## 启动与停止

```powershell
# 生产只读（带独立验收账本与交付白名单）
node server.mjs `
  --state-root REPLACE/with/bridge/state/root `
  --acceptance-ledger REPLACE/with/acceptance/ledger.json `
  --workspace-map config/monitor.example.json

# 或者一个汇总配置
node server.mjs --config config/monitor.example.json

# 随机空闲端口（测试用）
node server.mjs --port 0

# 不监听，直接打印 JSON（便于脚本化核对）
node server.mjs --dump
node server.mjs --dump-job job-076653ee6ba859ad
```

停止：前台 `Ctrl+C`（也响应 SIGTERM）。停止后进程退出，不遗留监听；演示模式的临时夹具会被删除。
端口被占用时给出明确错误并以退出码 1 结束：

```
端口 4178 已被占用（EADDRINUSE）。请停止占用该端口的进程，或用 --port 指定其它端口。
```

常用参数（完整列表见 `--help`）：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--port` | `4178` | `0` 表示内核分配随机端口 |
| `--host` | `127.0.0.1` | 仅允许 `127.0.0.1` / `::1` / `localhost`，其它值直接报错退出 |
| `--state-root` | `REPLACE/with/bridge/state/root` | 只读状态根（发布版内置默认是占位，必须显式指定） |
| `--acceptance-ledger` | 未配置 | 不配置时全部“未提供验收记录” |
| `--workspace-map` | 未配置 | 交付目录白名单与本地名称映射 |
| `--refresh-interval-ms` | `5000` | 页面刷新间隔（前端另有 1 秒本地计时用于运行中用时） |
| `--stale-heartbeat-ms` | `30000` | owner 心跳过期阈值 |
| `--max-jobs` / `--max-scan-entries` / `--max-job-json-bytes` / `--max-ledger-bytes` | 见 `--help` | 各项上限，只允许调低到硬上限以内 |

## 只读契约：读什么，不读什么

只读取三类东西：

1. `owner.lock` 与 `owner.heartbeat.<lockId>` 的**元数据**（lockId、startedAt、bridgeVersion、heartbeatAt、心跳年龄）。
2. `jobs/<合法 jobId>/job.json`，且只抽取白名单字段：
   `jobId / workspaceId / mode / status / createdAt / startedAt / endedAt / timeoutSeconds /
   exitCode / signal / errorCode / timedOut / cancelRequested / recovered / bytes / rawBytes /
   truncated / cleanup{reason,requestedAt,confirmed,confirmedAt}`。
3. `jobs/<合法 jobId>/stdout.log` 与 `stderr.log` 的**文件元数据**（`stat` 的大小与 mtime，不打开内容）。

明确不读取、不返回：

- `task.accepted.md`、`requests/` 索引、桥生产配置、环境变量、DSH home、凭据/模型会话文件；
- `stdout.log` / `stderr.log` 的**原始文本**（headless stderr 可能包含完整内部过程）；
- `record.errorMessage`、`command`、`workspaceDir`、`stdoutLog`、`stderrLog`、`pid`、`audit` 等字段。
  错误只显示稳定错误码（例如 `SPAWN_FAILED`）与通用可操作说明。

`job.json` 里的路径字段不是文件读取入口：日志路径由「状态根 + 已校验 jobId + 固定文件名」构造；
工作目录只来自操作者显式配置的白名单，浏览器无法传入路径或目录。
任何重解析点/符号链接/规范化后逃出授权根的目标都会被拒绝。

## 配置示例

`config/monitor.example.json`：

```json
{
  "stateRoot": "REPLACE/with/bridge/state/root",
  "acceptanceLedger": "REPLACE/with/acceptance/ledger.json",
  "workspaceMap": {
    "byWorkspaceId": { "ws-demo": "REPLACE/with/readonly/delivery/dir" },
    "byJobId": { "job-0000000000000000": "REPLACE/with/readonly/delivery/dir" },
    "names": { "job-0000000000000000": "示例展示名" },
    "workspaceNames": { "ws-demo": "示例展示名" }
  }
}
```

- 匹配顺序：`byJobId` 覆盖 → `byWorkspaceId` → 都没有则页面显示「未配置交付目录」。
- `names` / `workspaceNames` 只是**本地展示名映射**；没有映射时名称由
  「模式中文名 · 工作区 ID」推导，绝不展示 task 正文。
- 目录扫描忽略 `.git`、`node_modules`、`dist`、`state`、`.tmp`、`audits`、`audit-snapshot*`、
  `*-audit-reports` 等目录与 `*.log` 文件；只报告相对路径、大小、mtime，不打开文件内容；
  条目数/深度/展示条数都有上限，触顶会在页面上说明。

### 独立验收账本格式

```json
{
  "schema": "dsh-monitor/acceptance-ledger/v1",
  "updatedAt": "2026-10-10",
  "jobs": {
    "job-076653ee6ba859ad": { "status": "pass", "reviewedAt": "2026-10-09" },
    "job-6afa42a9d671a241": { "status": "fail", "reviewedAt": "2026-10-09" },
    "job-55a6180f5d8fb32b": { "status": "pending" }
  }
}
```

只读取合法 `jobId` 对应的 `pass` / `fail` / `pending` 与日期；任何备注、路径、评审人字段都会被丢弃。
账本缺失、不可读或没有该作业条目时，验收状态一律显示「未提供验收记录」——
**不会**从退出码 0、报告文件存在或日志里出现 PASS 字样推断“通过”。

## HTTP 接口（仅 GET）

| 方法与路径 | 说明 |
| --- | --- |
| `GET /`、`GET /index.html`、`GET /app.js`、`GET /styles.css` | 静态资源（固定白名单，无目录遍历） |
| `GET /api/meta` | 数据源、owner 心跳、账本、白名单摘要、限额、模式（是否演示） |
| `GET /api/jobs` | 最近作业列表 + 损坏记录列表 + 采样时间 + 计数 |
| `GET /api/jobs/<jobId>` | 单个作业详情（执行/验收两条状态、活动、交付、限制说明） |

- 非 GET/HEAD 一律 `405`，并带 `Allow: GET, HEAD`；没有 submit / cancel / delete / retry / config 接口。
- 非法 `jobId` → `400`；未知但合法的 jobId → `404`；路径遍历 → `400`。
- 不发送任何 CORS 头；响应带 `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、
  `X-Frame-Options: DENY`；HTML 带 `Content-Security-Policy: default-src 'self'; ...`（不含 `unsafe-inline`）。
- 仅监听 loopback。

## 界面

- 顶部：标题、数据源、最近刷新时间、刷新状态、`演示数据` 徽标（仅 `--demo` 时出现）。
- 左侧：最近任务列表（名称、作业 ID、模式、状态、开始时间、已用/时限），按创建时间倒序；
  点击或键盘 Enter/Space 选中，选中项写入 URL hash。
- 右侧：单个作业详情。
  - **执行状态**与**独立验收状态**是两条独立状态，颜色 + 文字双编码，绝不合并为“成功”；
    「正常结束」下方固定标注“只表示进程退出码为 0”。
  - **时限已用**进度条（标注为“时限已用”，不是完成百分比）；终态用时按 `endedAt` 冻结，不再增长。
  - **最近活动**：stdout/stderr 的大小、最后更新时间、相对上次采样的增量；
    没有变化时只显示「暂无新活动」，并说明“不代表卡死、失败或进程已退出”。
  - **交付与测试信息**：白名单目录内最近更新的文件与报告类文件名（相对路径 + 大小 + mtime），
    并注明“基于文件元数据、未打开文件内容、不能归属到某个模型动作”。
    测试结果固定显示「未提供」——本面板不读取报告/测试结果正文，也不匹配日志中的 PASS 字样，
    因此永远不会自行宣布测试通过。
- 明确展示的空/失败状态：空列表、状态根不存在、枚举失败、坏 JSON、未知状态、无验收记录、
  未配置交付目录、刷新失败（保留上次成功采样时间）。损坏记录单独列出，不会被当作“没有作业”。
- 无障碍：状态不只靠颜色、`role="progressbar"` + `aria-valuetext`、`aria-live` 刷新状态、
  `:focus-visible` 焦点环、360px 窄屏可读、`prefers-reduced-motion` 生效。

## 运行测试

`node --test` 在受限沙箱里可能 `spawn EPERM`，因此每个测试文件都可以直接在进程内运行：

```powershell
node test/paths.test.mjs
node test/job-record.test.mjs
node test/acceptance.test.mjs
node test/activity.test.mjs
node test/workspace-scan.test.mjs
node test/monitor.test.mjs
node test/http.test.mjs
node test/ui-assets.test.mjs

# 或者一次导入全部文件（同一进程，等价于 npm run test:files）
node test/run-all.mjs
```

HTTP 测试会在 `127.0.0.1` 上以 `--port 0` 起一个临时服务，用内置 `fetch` 调用后在
`after` 钩子里 `server.close()`，并删除临时夹具；不会遗留监听。

源码哈希清单：`node scripts/hash-sources.mjs` → `reports/source-hashes.json`。

## 已知限制（未验证范围）

- 只在本机 Node v24.19.0 上执行与自测；未在其它 Node/引擎版本上验证。
- 视觉部分没有浏览器自动化截图（项目不允许引入外部依赖）；已在报告中给出可复查的布局说明、
  静态自查与未验证范围。
- 文件型符号链接（`fs.symlink`）在无开发者模式的 Windows 上会 `EPERM`，该用例以“权限拒绝”如实记录；
  目录联接（junction）用例可执行，用于覆盖重解析拒绝。
- 页面显示的“已用时间”在两次刷新之间由前端按本机时钟外推；同一台机器上不会产生明显偏差。
- 面板不判断作业是否卡死、不估算剩余工作量、不显示完成百分比——这是设计约束，不是缺陷。
