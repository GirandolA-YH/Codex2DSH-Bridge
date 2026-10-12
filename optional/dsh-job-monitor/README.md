# 可选组件：DSH 作业监控面板

本插件制作者没有程序开发背景，使用 Codex 与 DSH 共同构建了该插件。代码内容仅通过 Agent 审计，未经过专业开发者的人工代码审计。对于后续发现的 bug 及 GitHub Issues，建议使用者自行使用 Agent 进行修改和开发。

这是安装在 **DSH 桌面版右侧栏**的「作业监控」插件。**MCP 桥安装 / 接入 Codex 侧，本面板安装在 DSH 内**。本面板是单独选装组件，不能随主 MCP 桥一起安装：主包不含本面板、没有它的依赖或安装钩子。克隆仓库只取得源码，仍需手动安装到 DSH。面板不提供 Codex 内嵌界面。

面板显示桥作业列表、执行状态、独立验收状态、用时与时限、日志文件的大小和修改时间，以及白名单交付目录的文件元数据。复用 DSH 自带 Web 服务的 `/dsh-job-monitor/api/*` 路由，不新增监听端口，不使用 iframe，不提交模型作业。

## 必需依赖：dsh-better-sidebar

必须先在同一 DSH desktop profile 中安装并启用 **`dsh-better-sidebar`**，再安装本面板。该插件提供本面板依赖的 `betterSidebar.registerTab` 右侧栏服务；DSH 的 `webServer` 和客户端 React 加载器也必须可用。只有主 MCP 桥不能提供这些服务。

本机核对到 `dsh-better-sidebar 0.24.1`；本面板 `package.json` 的 `peerDependencies` 明确声明该版本，客户端已有 `inject = ['betterSidebar']` 依赖注入。其他版本未验证。仅将 npm 包复制到目录不能保证插件已经启用，应按 [dsh-better-sidebar 项目说明](https://github.com/omdsh-dev/DSH-better-sidebar) 在 DSH 中完成安装和启用，再确认右侧栏服务可用。

本仓库不捆绑 sidebar 的源码或安装器，不自动修改它的配置。安装桥不安装 sidebar；卸载面板时也不自动卸载 sidebar，因为其他插件可能依赖它。

## 安装与回退

1. 先确认同一 profile 中的 `dsh-better-sidebar` 已安装且启用，然后完全退出 DSH，备份目标 profile 的 `cordis.patch.yml`。如果已有面板，也备份原来的 `node_modules/dsh-job-monitor` 目录及真实配置。
2. 将本目录完整复制到 `<profile>/node_modules/dsh-job-monitor`。常见桌面 profile 是 `~/.dsh/profiles/desktop`，以自己的安装为准。不要把它复制到 Codex 配置目录；不用在 DSH profile 内运行 `pnpm install`。
3. 在 `<profile>/cordis.patch.yml` 追加以下插件条目；若已存在同名条目，不要重复添加：

   ```yaml
   - insert:
       - id: dsh-job-monitor
         name: 'dsh-job-monitor'
   ```

4. 复制 `config/monitor.example.json` 为 `config/monitor.json`，替换所有 `REPLACE` 路径和 ID。没有账本时可删除 `acceptanceLedger`；不需要交付扫描时将对应映射设为 `{}`。
5. 重启 DSH，重新加载页面（F5），打开右侧栏的「作业监控」。修改宿主代码或配置后需要重启 DSH；仅刷新页面不能保证宿主重新加载。

回退时退出 DSH，恢复已备份的插件目录和 `cordis.patch.yml`，再重启。配置含自己的路径，不要提交到公开仓库。

## 配置

配置仅由宿主进程读取，浏览器不能指定文件路径。默认位置为插件下的 `config/monitor.json`；也可在启动 DSH **之前**设置 `DSH_JOB_MONITOR_CONFIG`，指向外部配置的绝对路径。相对数据路径按插件目录解析，不按外部配置所在目录解析。

| 字段 | 填写内容 |
| --- | --- |
| `stateRoot` | MCP 桥配置中 `stateDir` 对应的状态目录，必须明确填写 |
| `acceptanceLedger` | 独立维护的验收账本 JSON，可省略 |
| `workspaceMap.byWorkspaceId` | 桥的 workspaceId 到只读交付目录的映射 |
| `workspaceMap.byJobId` | 特定 jobId 的交付目录映射，优先于工作区映射 |
| `workspaceMap.workspaceNames` / `names` | 工作区 / 作业的展示名，不是任务正文 |
| `refreshIntervalMs` | 默认 5000；当前客户端轮询采用至少 1000 毫秒的有效间隔 |
| `staleHeartbeatMs` | 心跳过期提示阈值，默认 30000，不代表作业失败 |
| `limits` | 读取、枚举与扫描上限，受采样核心 HARD_CAPS 限制 |

配置缺失、JSON 非法或没有有效 `stateRoot` 时，不建立采样器，不读取当前工作目录。诊断接口仍可用，数据接口返回 `503 CONFIG_NOT_CONFIGURED`。填写了不存在的路径时会显示不可达；不会回落到另一个目录。

桥和面板应共用一个长期固定、位于部署目录之外的生产状态根。两份模板使用相同的 `C:/DshBridge/state` 占位路径，填写时一起替换；验收账本也保持固定位置。桥升级只更换代码目录，保留生产配置和状态根，面板无需改配置。新增 workspaceId 时显式补充交付目录与展示名，未配置项仍明确提示。selftest/offline/fake 状态目录不受生产面板监控。迁移状态树前先停止并核查旧桥，排除 owner 文件；修改面板配置后重启 DSH。

生产模板默认/最大作业时限均为 30 分钟，时限由桥控制；面板读取各作业 job.json 的 timeoutSeconds，无需新增面板参数。已受理作业保留旧时限。配置修改后先重连桥，再通过 dsh_health 核对实际加载值。

升级后按顺序检查 `/dsh-job-monitor/api/config-status`（configured=true、configWarnings=[]、两个固定路径正确）、`/api/meta`（心跳新鲜），再核对 `/api/jobs` 和 `/api/jobs/<id>` 的 jobId/status/acceptance 一致，列表与磁盘双向零差异。completed 表示执行结束，pass 仍只能来自独立账本。

验收账本示例（由独立审计方填写，面板只读）：

```json
{
  "updatedAt": "2026-10-11",
  "jobs": {
    "job-0000000000000000": { "status": "pending", "reviewedAt": "2026-10-11" }
  }
}
```

状态只接受 `pass`、`fail`、`pending`。缺少账本或作业条目时显示「未提供验收记录」；退出码 0 不会被当作通过。

## 只读边界与宿主要求

- 读取 `owner.lock` 心跳、`job.json` 的白名单字段、日志大小和修改时间、显式白名单目录中的文件元数据。
- 不读取日志正文、任务正文、请求正文或模型凭据；不写状态目录、账本或交付目录，不提供提交、取消、删除、重试和配置编辑。
- HTTP 只提供 GET/HEAD；其他方法返回 405。HEAD 的正常和错误响应都不发送正文。静态页面不在宿主路由中开放。
- 本插件没有独立的身份认证，不应把 DSH Web 服务暴露到局域网、公网或未受控的代理。安全头和不发 CORS 头不能替代身份认证；显示的 ID、路径和文件名仍是本机数据。
- 需要已启用的 `dsh-better-sidebar` 提供 `betterSidebar.registerTab`，宿主提供 `webServer.register` 和客户端 React 模块加载器。2026-10-12 核对本机已安装的宿主/客户端入口与采样核心共 18 个运行文件，与发布源码哈希一致；真实宿主 API 已验证固定根、心跳、列表/详情及独立账本显示。完整 UI、窄屏、辅助技术和其他版本/操作系统仍未验证。

## 面板行为

默认 5 秒轮询，标签不可见时暂停，可手动暂停、继续和立即刷新。关闭面板时清理计时器并中止未完成请求，异步刷新不能重新启动轮询。更换作业选择时旧详情不能覆盖新选择；中途断连保留上一轮完整采样。执行状态、验收状态和文件变化分别展示，「时限已用」不是完成百分比，日志静默也不代表卡死。

样式使用 DSH 主题令牌，支持自动、浅色和深色模式。窄屏、辅助技术和真实宿主中的视觉效果仍需使用者验证。

## 离线验证

在本目录运行，使用 Node.js 20.11 或更高版本；本次检查实际使用 Node.js 24.19.0。无需安装依赖，也不会调用模型：

```powershell
npm test                    # 34 项：模拟状态根、外部配置、宿主路由和客户端回归
npm run test:baseline       # 63 项：脱敏采样核心的原有测试
npm run test:readonly       # 独立模拟目录的哈希和修改时间对比
npm run test:without-config # 无本地配置时，29 项执行、5 项明确标为 skipped
```

`test:without-config` 会读取你显式设置的外部配置；如需验证无配置模式，应清除环境变量并确保默认配置不存在。`test:readonly:configured` 对自己提供的配置做只读核验；未配置时以非零退出码报告未执行，不表示通过。上述接口测试和组件模拟不替代真实 DSH 的重装与视觉验收。

`baseline/` 是经过脱敏的 M01 快照，不是原始 M01 的逐字节副本。采样运行源码保持原有字节；历史 README 和测试中的实际作业 ID 已替换为虚构示例，当前 35 项快照校验见 `test/baseline-hashes.json`。旧说明中的 standalone 服务仅是历史参考；嵌入安装不运行 `baseline/server.mjs`。

目录用途：`lib/` 为宿主与客户端入口，`host/` 为配置和路由适配，`config/` 只有公开模板，`test/` 为离线检查，`baseline/` 为采样核心及历史测试。审查结果见 [AUDIT.md](AUDIT.md)。

## 许可

MIT，见 [LICENSE](LICENSE)。本组件随 [Codex2DSH-Bridge](https://github.com/GirandolA-YH/Codex2DSH-Bridge) 发布。
