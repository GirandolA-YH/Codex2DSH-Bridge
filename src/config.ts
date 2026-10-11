/**
 * 中文模块导读
 * 配置读取与检查：决定桥能使用哪些目录、运行器和限制。
 * 调用方只能选预先配置的 workspaceId；不能临时把任意目录或启动命令塞进工具参数。
 * 不合法或相互冲突的配置会在启动时被拒绝，避免程序悄悄按另一套规则运行。
 */
/**
 * Service configuration.
 *
 * The caller (Codex) can never choose a command, runner, environment, model or
 * working directory: everything executable is fixed here, in a file the caller
 * does not control. MCP arguments only select a configured `workspaceId`, a
 * `mode`, a task file under an allowed root, and a timeout.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BridgeError } from './errors.js';
import { Logger, type LogLevel } from './logging.js';
import { canonicalizeForCheck, isWithin } from './paths.js';
import { Redactor, findMultilineLiteral } from './redact.js';
import { MAX_CODE_POINT_BYTES } from './capture.js';
import { globToRegExp, compilePolicy } from './hashing.js';
import { MODES, type Mode } from './types.js';

/**
 * 运行时限、输出保存上限、分页上限等数量限制，单位在字段名中注明。
 */
export interface LimitsConfig {
  defaultTimeoutSeconds: number;
  minTimeoutSeconds: number;
  maxTimeoutSeconds: number;
  perStreamCaptureCapBytes: number;
  resultPageMaxBytes: number;
  inlineTaskMaxChars: number;
  maxTaskFileBytes: number;
}

/**
 * The one accepted per-job wall-clock window (R2-05), in seconds.
 *
 * This constant is the server-side twin of the `minimum: 1, maximum: 3600`
 * declared in the `dsh_submit` MCP schema: `loadConfig` refuses a `limits` block
 * whose min/default/max cannot be expressed inside it, and `JobManager` refuses
 * a `timeoutSeconds` outside it even if it is constructed with a hand-built
 * config that never went through `loadConfig`.
 */
export const TIMEOUT_RANGE_SECONDS = { min: 1, max: 3600 } as const;

/**
 * 审计文件筛选和容量限制。
 */
export interface AuditConfig {
  /** Allowlist globs. Empty means "everything not denied". */
  include: string[];
  /** Deny globs. Always win over include. */
  exclude: string[];
  maxSnapshotBytes: number;
  maxSnapshotFiles: number;
}

/**
 * 停止进程操作的等待和确认时限。
 */
export interface CleanupConfig {
  /** How long the bridge waits for a verified stop before reporting "not confirmed". */
  confirmTimeoutMs: number;
  /** Hard cap for one kill attempt. */
  killTimeoutMs: number;
}

/**
 * 状态目录心跳与过期判断的配置。
 */
export interface OwnershipConfig {
  /** A heartbeat older than this makes the lock takeable. */
  staleHeartbeatMs: number;
  /** Heartbeat refresh interval. */
  heartbeatMs: number;
}

/**
 * Test-only fault injection. These switches exist so the regression suite can
 * prove that a persistence failure rolls a submission back instead of leaving a
 * `starting` job. Never enable them in a real deployment.
 */
/**
 * 仅测试用的故障注入开关，用来验证写文件等失败路径。
 */
export interface FaultConfig {
  failJobWriteOnce: boolean;
  failRequestWriteOnce: boolean;
}

/**
 * 将审计快照绑定到源工作区和单独报告目录。
 */
export interface WorkspaceAuditBinding {
  sourceWorkspaceId: string;
  reportDir: string;
}

/**
 * 一个已允许工作区的目录、模式和可选审计绑定。
 */
export interface WorkspaceConfig {
  workspaceId: string;
  /** Raw configured value, kept for diagnostics. */
  configuredDir: string;
  /** Canonical absolute directory handed to the runner as cwd. */
  dir: string;
  allowedModes: Mode[];
  description: string | null;
  audit: WorkspaceAuditBinding | null;
}

/**
 * A launcher is an explicit, server-side argv prefix. The caller can never
 * influence it. Two shapes are supported and both are real on this machine:
 *  - npm CLI:      command = node.exe,  argsPrefix = [<...>/@deepseek-ai/dsh/lib/bin.js]
 *  - desktop 0.2.0-rc.2: command = "DeepSeek Harness.exe",
 *                  argsPrefix = ["--expose-internals", "<...>/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"],
 *                  env = { ELECTRON_RUN_AS_NODE: "1" }
 */
/**
 * 外部程序的固定启动信息，由配置决定。
 */
export interface LauncherConfig {
  command: string;
  argsPrefix: string[];
  extraArgs: string[];
  env: Record<string, string>;
}

/**
 * 真实 DSH 的启动器、profile、任务传递方式及环境设置。
 */
export interface ProductionRunnerConfig extends LauncherConfig {
  profile: string;
  dshHome: string | null;
  /**
   * How the task text reaches the headless app.
   *  - argv  : one positional argument (works on 0.1.0-rc.6 and 0.2.0-rc.2)
   *  - stdin : the `-` positional plus stdin (0.2.0-rc.2 only)
   */
  taskTransport: 'argv' | 'stdin';
  /** Add `--json` (newline-delimited run events). 0.2.0-rc.2 only. */
  jsonEvents: boolean;
  /** Optional declared version, used when the launcher lives inside app.asar. */
  declaredDshVersion: string | null;
}

/**
 * Test runner configuration.
 *
 * `killBehaviour` is deliberate fault injection used only by the regression
 * suite: it can make a stop attempt slow or a no-op so that "cleanup could not
 * be confirmed" is exercised with a *real* child process. It is server-side
 * configuration and cannot be selected through MCP arguments.
 */
/**
 * 本地模拟运行器的启动信息，供测试使用。
 */
export interface FakeRunnerConfig extends LauncherConfig {
  killBehaviour: {
    mode: 'normal' | 'noop';
    delayMs: number;
  };
}

/**
 * 选择真实或假运行器以及各自配置。
 */
export interface RunnerConfig {
  type: 'production' | 'fake';
  production: ProductionRunnerConfig;
  fake: FakeRunnerConfig;
}

/**
 * 已通过检查的配置，包含规范化路径以及建立好的日志、脱敏器等组件。
 */
export interface LoadedConfig {
  configPath: string;
  serverName: string;
  serverVersion: string;
  logLevel: LogLevel;
  stateDir: string;
  taskFileRoots: string[];
  workspaces: Map<string, WorkspaceConfig>;
  workspaceOrder: string[];
  runner: RunnerConfig;
  limits: LimitsConfig;
  concurrency: { maxActiveJobs: number };
  recovery: { killOrphanedChildrenOnStart: boolean };
  cleanup: CleanupConfig;
  ownership: OwnershipConfig;
  faults: FaultConfig;
  audit: AuditConfig;
  redactor: Redactor;
  logger: Logger;
}

const DEFAULT_LIMITS: LimitsConfig = {
  defaultTimeoutSeconds: 1800,
  minTimeoutSeconds: 1,
  maxTimeoutSeconds: 3600,
  perStreamCaptureCapBytes: 5 * 1024 * 1024,
  resultPageMaxBytes: 64 * 1024,
  inlineTaskMaxChars: 16384,
  maxTaskFileBytes: 1024 * 1024,
};

// R2-02 replaced the old `DEFAULT_AUDIT.exclude` list with AUDIT_HARD_DENY below.
// `audit.exclude` is now always built by `resolveAuditPolicy` from that set plus
// the operator's additions, so there is exactly one definition of the deny list.
// The default `audit.include` stays empty, meaning "everything not denied".

/**
 * Built-in audit deny set (R2-02).
 *
 * These rules are **additive-only**: an administrator may extend the deny set
 * but never remove an entry from it. Before this fix, `audit.exclude` replaced
 * the default list wholesale, so `audit.exclude: ["node_modules"]` silently
 * re-admitted `.env`, credential files and earlier reviewer conclusions
 * (`OLD-AUDIT.md`) into the snapshot the auditor can read.
 *
 * The list is exactly the pre-fix default set, so the default deployment policy
 * is byte-for-byte unchanged; only the *replacement* semantics were wrong.
 */
export const AUDIT_HARD_DENY: readonly string[] = [
  // build/runtime material
  'node_modules',
  '.git',
  'state',
  'dist',
  'coverage',
  'tmp',
  '.tmp',
  '.cache',
  'logs',
  // logs and environment files
  '*.log',
  '.env',
  '.env.*',
  '**/.env',
  '**/.env.*',
  // previous implementation sessions and earlier reviewer conclusions
  '**/.dsh/**',
  '**/sessions/**',
  '**/reports/**',
  '**/audit-reports/**',
  '**/audit/**',
  '**/CODEX-AUDIT-*.md',
  '**/*AUDIT*.md',
  // real configuration and credential material
  '**/bridge.config.json',
  '**/*.real.json',
  '**/auth.json',
  '**/.credentials*',
  '**/*credential*',
  '**/*secret*',
  '**/*.pem',
  '**/*.key',
  '**/*.pfx',
  '**/*.p12',
  '**/*id_rsa*',
];

/**
 * The single source of truth for the effective audit policy: the built-in deny
 * set plus whatever the operator appended. Both the snapshot copy and the
 * snapshot manifest are handed exactly this object, so they cannot disagree.
 */
/**
 * 合并配置筛选规则与内置强制排除规则；配置不能撤销保护凭据和历史会话的排除项。
 */
export function resolveAuditPolicy(audit: Pick<AuditConfig, 'include' | 'exclude'>): { include: string[]; exclude: string[] } {
  const exclude = [...AUDIT_HARD_DENY];
  for (const pattern of audit.exclude) {
    if (!exclude.includes(pattern)) exclude.push(pattern);
  }
  return { include: [...audit.include], exclude };
}

/**
 * A configured `audit.include` may not try to re-admit hard-denied material.
 * Silently letting the deny rule win would accept a policy the operator plainly
 * did not get, so the combination is refused at load time instead.
 */
/**
 * 拒绝明确要求读取被强制排除内容的包含规则，避免表面接受配置、实际悄悄改变范围。
 */
function assertIncludeRespectsHardDeny(include: readonly string[], hardDeny: readonly string[]): void {
  if (include.length === 0) return;
  const includeMatchers = include.filter((pattern) => pattern !== '').map((pattern) => {
    const normalised = pattern.replace(/^\.\//, '').replace(/\\/g, '/');
    const regex = globToRegExp(normalised);
    return normalised.includes('/')
      ? (relPath: string) => regex.test(relPath)
      : (_relPath: string, name: string) => regex.test(name);
  });
  // An allowlist entry that also matches a hard-denied *pattern* is a request to
  // read exactly that material (`.env`, `**/*AUDIT*.md`, ...). It is refused
  // instead of resolving quietly in either direction.
  const conflicts = hardDeny.filter((pattern) => includeMatchers.some((matcher) => matcher(pattern, pattern)));
  const denyPolicy = compilePolicy({ exclude: hardDeny });
  for (const pattern of include) {
    const normalized = pattern.replace(/^\.\//, '').replace(/\\/g, '/');
    const parts = normalized.split('/');
    if (denyPolicy.denies(normalized, parts.at(-1) ?? normalized) ||
        parts.slice(0, -1).some((name, i) => !denyPolicy.descends(parts.slice(0, i + 1).join('/'), name))) {
      conflicts.push(pattern);
    }
  }
  if (conflicts.length > 0) {
    fail('audit.include would re-admit material the built-in audit deny set always excludes; the deny set is additive and cannot be overridden', {
      include,
      unremovableDenyPatterns: conflicts,
    });
  }
}

const DEFAULT_AUDIT_LIMITS = {
  maxSnapshotBytes: 512 * 1024 * 1024,
  maxSnapshotFiles: 20000,
};

/**
 * 统一抛出配置无效错误，供后续错误包装与脱敏。
 */
function fail(message: string, details: Record<string, unknown> = {}): never {
  throw new BridgeError('CONFIG_INVALID', message, details);
}

/**
 * 要求配置项是普通对象形状，拒绝空值或数组。
 */
function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

/**
 * 要求配置项是非空字符串。
 */
function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail(`${label} must be a non-empty string`);
  return value;
}

/**
 * 读取可省略的文字项；缺省值用 null 表示。
 */
function optionalString(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') fail(`${label} must be a string`);
  return value;
}

/**
 * 读取可省略的正整数设置，未填写时使用指定默认值。
 */
function optionalPositiveInt(value: unknown, label: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    fail(`${label} must be a positive integer`);
  }
  return value;
}

/**
 * 读取可省略的非负整数设置，允许 0，未填写时使用指定默认值。
 */
function optionalNonNegativeInt(value: unknown, label: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    fail(`${label} must be a non-negative integer`);
  }
  return value;
}

/**
 * 核对配置列表中每一项都是可用的字符串。
 */
function stringArray(value: unknown, label: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    fail(`${label} must be an array of strings`);
  }
  return value as string[];
}

/**
 * 只接受 implement、fix、audit 这三种模式，拒绝拼写错误或不支持的模式。
 */
function parseModes(value: unknown, label: string): Mode[] {
  if (!Array.isArray(value) || value.length === 0) fail(`${label} must be a non-empty array`);
  const modes: Mode[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !(MODES as readonly string[]).includes(item)) {
      fail(`${label} contains an unsupported mode`, { mode: item, supported: MODES });
    }
    if (!modes.includes(item as Mode)) modes.push(item as Mode);
  }
  return modes;
}

/**
 * 读取运行器的环境变量映射，要求键值符合预期格式；这不是显示凭据的入口。
 */
function parseEnv(value: unknown, label: string): Record<string, string> {
  if (value === undefined || value === null) return {};
  const record = requireRecord(value, label);
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item !== 'string') fail(`${label}.${key} must be a string`);
    out[key] = item;
  }
  return out;
}

/**
 * 读取 JSON 配置，检查目录关系、启动器、超时、快照策略和秘密值声明，最后建立日志及脱敏器。
 */
export function loadConfig(configPath: string, env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  const absoluteConfig = path.resolve(configPath);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(absoluteConfig, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    fail(`cannot read config ${absoluteConfig}`, { cause: error instanceof Error ? error.message : String(error) });
  }
  const configDir = path.dirname(absoluteConfig);
  const resolveFrom = (value: string): string => (path.isAbsolute(value) ? value : path.resolve(configDir, value));

  const server = requireRecord(raw.server ?? {}, 'server');
  const serverName = optionalString(server.name, 'server.name') ?? 'dsh-codex-bridge';
  const serverVersion = optionalString(server.version, 'server.version') ?? '0.1.0';
  const logLevelRaw = optionalString(server.logLevel, 'server.logLevel') ?? env['DSH_BRIDGE_LOG_LEVEL'] ?? 'info';
  if (!['debug', 'info', 'warn', 'error'].includes(logLevelRaw)) {
    fail('server.logLevel must be debug|info|warn|error', { logLevel: logLevelRaw });
  }
  const logLevel = logLevelRaw as LogLevel;

  const stateDir = resolveFrom(requireString(raw.stateDir, 'stateDir'));

  const taskFileRootsRaw = stringArray(raw.taskFileRoots, 'taskFileRoots');
  if (taskFileRootsRaw.length === 0) fail('taskFileRoots must list at least one allowed directory');
  const taskFileRoots = taskFileRootsRaw.map((root) => resolveFrom(root));

  const workspacesRaw = requireRecord(raw.workspaces, 'workspaces');
  const workspaceOrder = Object.keys(workspacesRaw);
  if (workspaceOrder.length === 0) fail('workspaces must define at least one workspaceId');

  const workspaces = new Map<string, WorkspaceConfig>();
  for (const workspaceId of workspaceOrder) {
    if (!/^[A-Za-z0-9._:-]{1,64}$/.test(workspaceId)) {
      fail('workspaceId must be 1-64 chars of [A-Za-z0-9._:-]', { workspaceId });
    }
    const entry = requireRecord(workspacesRaw[workspaceId], `workspaces.${workspaceId}`);
    const configuredDir = resolveFrom(requireString(entry.dir, `workspaces.${workspaceId}.dir`));
    const allowedModes = parseModes(entry.allowedModes, `workspaces.${workspaceId}.allowedModes`);
    const auditRaw = entry.audit === undefined || entry.audit === null ? null : requireRecord(entry.audit, `workspaces.${workspaceId}.audit`);
    let audit: WorkspaceAuditBinding | null = null;
    if (auditRaw !== null) {
      const sourceWorkspaceId = requireString(auditRaw.sourceWorkspaceId, `workspaces.${workspaceId}.audit.sourceWorkspaceId`);
      const reportDirRaw = optionalString(auditRaw.reportDir, `workspaces.${workspaceId}.audit.reportDir`);
      audit = {
        sourceWorkspaceId,
        reportDir: reportDirRaw === null ? path.join(stateDir, 'audit-reports') : resolveFrom(reportDirRaw),
      };
      if (allowedModes.length !== 1 || allowedModes[0] !== 'audit') {
        fail(`workspaces.${workspaceId}: an audit workspace may only allow the audit mode`, { allowedModes });
      }
    } else if (allowedModes.includes('audit')) {
      fail(`workspaces.${workspaceId}: audit mode requires an audit binding (sourceWorkspaceId)`, { allowedModes });
    }
    workspaces.set(workspaceId, {
      workspaceId,
      configuredDir,
      dir: canonicalizeForCheck(configuredDir),
      allowedModes,
      description: optionalString(entry.description, `workspaces.${workspaceId}.description`),
      audit,
    });
  }

  // Cross-checks between audit workspaces and their sources.
  for (const workspace of workspaces.values()) {
    if (workspace.audit === null) continue;
    const source = workspaces.get(workspace.audit.sourceWorkspaceId);
    if (source === undefined) {
      fail(`workspaces.${workspace.workspaceId}.audit.sourceWorkspaceId does not name a configured workspace`, {
        sourceWorkspaceId: workspace.audit.sourceWorkspaceId,
      });
    }
    if (!source.allowedModes.includes('implement') && !source.allowedModes.includes('fix')) {
      fail(`workspaces.${workspace.workspaceId}.audit.sourceWorkspaceId must allow implement or fix`, {
        sourceWorkspaceId: source.workspaceId,
        allowedModes: source.allowedModes,
      });
    }
    if (isWithin(workspace.dir, source.dir) || isWithin(source.dir, workspace.dir)) {
      fail(
        `audit workspace ${workspace.workspaceId} must not overlap its source workspace ${source.workspaceId}; the audited implementation directory cannot be the audit cwd`,
        { auditDir: workspace.dir, sourceDir: source.dir },
      );
    }
  }

  const runnerRaw = requireRecord(raw.runner, 'runner');
  const runnerType = requireString(runnerRaw.type, 'runner.type');
  if (runnerType !== 'production' && runnerType !== 'fake') {
    fail('runner.type must be production or fake', { runnerType });
  }

  const parseLauncher = (value: unknown, label: string): LauncherConfig => {
    const record = requireRecord(value, label);
    return {
      command: resolveFrom(requireString(record.command, `${label}.command`)),
      argsPrefix: stringArray(record.argsPrefix, `${label}.argsPrefix`).map((item) =>
        item.startsWith('-') ? item : resolveFrom(item),
      ),
      extraArgs: stringArray(record.extraArgs, `${label}.extraArgs`),
      env: parseEnv(record.env, `${label}.env`),
    };
  };

  const productionRaw = requireRecord(runnerRaw.production ?? {}, 'runner.production');
  const fakeRaw = requireRecord(runnerRaw.fake ?? {}, 'runner.fake');
  const productionBase = parseLauncher(productionRaw, 'runner.production');
  const taskTransport = optionalString(productionRaw.taskTransport, 'runner.production.taskTransport') ?? 'argv';
  if (taskTransport !== 'argv' && taskTransport !== 'stdin') {
    fail('runner.production.taskTransport must be argv or stdin', { taskTransport });
  }
  if (typeof productionRaw.jsonEvents === 'boolean' && productionRaw.jsonEvents && taskTransport === 'argv') {
    // Both may be combined; this is only a guard against a typo, not a limit.
  }
  const parseFakeLauncher = (): FakeRunnerConfig => {
    const base = parseLauncher(fakeRaw, 'runner.fake');
    const behaviourRaw = requireRecord(fakeRaw.killBehaviour ?? {}, 'runner.fake.killBehaviour');
    const mode = optionalString(behaviourRaw.mode, 'runner.fake.killBehaviour.mode') ?? 'normal';
    if (mode !== 'normal' && mode !== 'noop') {
      fail('runner.fake.killBehaviour.mode must be normal or noop', { mode });
    }
    return { ...base, killBehaviour: { mode, delayMs: optionalNonNegativeInt(behaviourRaw.delayMs, 'runner.fake.killBehaviour.delayMs', 0) } };
  };

  const runner: RunnerConfig = {
    type: runnerType,
    production: {
      ...productionBase,
      profile: optionalString(productionRaw.profile, 'runner.production.profile') ?? 'headless',
      dshHome: (() => {
        const value = optionalString(productionRaw.dshHome, 'runner.production.dshHome');
        return value === null ? null : resolveFrom(value);
      })(),
      taskTransport,
      jsonEvents: productionRaw.jsonEvents === true,
      declaredDshVersion: optionalString(productionRaw.declaredDshVersion, 'runner.production.declaredDshVersion'),
    },
    fake: parseFakeLauncher(),
  };

  const limitsRaw = requireRecord(raw.limits ?? {}, 'limits');
  const limits: LimitsConfig = {
    defaultTimeoutSeconds: optionalPositiveInt(limitsRaw.defaultTimeoutSeconds, 'limits.defaultTimeoutSeconds', DEFAULT_LIMITS.defaultTimeoutSeconds),
    minTimeoutSeconds: optionalPositiveInt(limitsRaw.minTimeoutSeconds, 'limits.minTimeoutSeconds', DEFAULT_LIMITS.minTimeoutSeconds),
    maxTimeoutSeconds: optionalPositiveInt(limitsRaw.maxTimeoutSeconds, 'limits.maxTimeoutSeconds', DEFAULT_LIMITS.maxTimeoutSeconds),
    perStreamCaptureCapBytes: optionalPositiveInt(limitsRaw.perStreamCaptureCapBytes, 'limits.perStreamCaptureCapBytes', DEFAULT_LIMITS.perStreamCaptureCapBytes),
    resultPageMaxBytes: optionalPositiveInt(limitsRaw.resultPageMaxBytes, 'limits.resultPageMaxBytes', DEFAULT_LIMITS.resultPageMaxBytes),
    inlineTaskMaxChars: optionalPositiveInt(limitsRaw.inlineTaskMaxChars, 'limits.inlineTaskMaxChars', DEFAULT_LIMITS.inlineTaskMaxChars),
    maxTaskFileBytes: optionalPositiveInt(limitsRaw.maxTaskFileBytes, 'limits.maxTaskFileBytes', DEFAULT_LIMITS.maxTaskFileBytes),
  };
  if (limits.minTimeoutSeconds > limits.maxTimeoutSeconds) {
    fail('limits.minTimeoutSeconds must not exceed limits.maxTimeoutSeconds');
  }
  if (limits.defaultTimeoutSeconds < limits.minTimeoutSeconds || limits.defaultTimeoutSeconds > limits.maxTimeoutSeconds) {
    fail('limits.defaultTimeoutSeconds must lie within the min/max range');
  }
  // R2-05: the MCP schema has always advertised `minimum: 1, maximum: 3600`, but
  // the range was only declarative. The server now enforces the same window, so
  // a `maximum` the server would happily exceed cannot be shipped at all. An
  // unrepresentable limits block is refused here instead of being clamped
  // silently (a muted config is a config the operator did not get).
  if (limits.minTimeoutSeconds < TIMEOUT_RANGE_SECONDS.min) {
    fail(`limits.minTimeoutSeconds must be at least ${TIMEOUT_RANGE_SECONDS.min}`, {
      minTimeoutSeconds: limits.minTimeoutSeconds,
      allowed: TIMEOUT_RANGE_SECONDS,
    });
  }
  if (limits.maxTimeoutSeconds > TIMEOUT_RANGE_SECONDS.max) {
    fail(`limits.maxTimeoutSeconds must not exceed ${TIMEOUT_RANGE_SECONDS.max} (the MCP schema maximum)`, {
      maxTimeoutSeconds: limits.maxTimeoutSeconds,
      allowed: TIMEOUT_RANGE_SECONDS,
    });
  }
  if (limits.defaultTimeoutSeconds < TIMEOUT_RANGE_SECONDS.min || limits.defaultTimeoutSeconds > TIMEOUT_RANGE_SECONDS.max) {
    fail(`limits.defaultTimeoutSeconds must lie within ${TIMEOUT_RANGE_SECONDS.min}-${TIMEOUT_RANGE_SECONDS.max}`, {
      defaultTimeoutSeconds: limits.defaultTimeoutSeconds,
      allowed: TIMEOUT_RANGE_SECONDS,
    });
  }
  if (limits.resultPageMaxBytes < MAX_CODE_POINT_BYTES) {
    // A hard byte ceiling and guaranteed forward progress are not allowed to
    // exempt each other (FIX-002 F2-05): the smallest legal budget must fit the
    // largest UTF-8 code point.
    fail(`limits.resultPageMaxBytes must be at least ${MAX_CODE_POINT_BYTES}`, {
      resultPageMaxBytes: limits.resultPageMaxBytes,
      minimum: MAX_CODE_POINT_BYTES,
    });
  }

  const concurrencyRaw = requireRecord(raw.concurrency ?? {}, 'concurrency');
  const concurrency = {
    maxActiveJobs: optionalPositiveInt(concurrencyRaw.maxActiveJobs, 'concurrency.maxActiveJobs', 1),
  };
  if (concurrency.maxActiveJobs !== 1) {
    fail('this release supports concurrency.maxActiveJobs = 1 only', { maxActiveJobs: concurrency.maxActiveJobs });
  }

  const recoveryRaw = requireRecord(raw.recovery ?? {}, 'recovery');
  const recovery = {
    killOrphanedChildrenOnStart:
      typeof recoveryRaw.killOrphanedChildrenOnStart === 'boolean' ? recoveryRaw.killOrphanedChildrenOnStart : false,
  };

  const auditRawConfig = requireRecord(raw.audit ?? {}, 'audit');
  const configuredInclude = stringArray(auditRawConfig.include, 'audit.include');
  const configuredExclude = stringArray(auditRawConfig.exclude, 'audit.exclude');
  // R2-02: the built-in deny set cannot be replaced by configuration, only
  // extended. The include allowlist is checked against it before it is accepted,
  // so an unexpressible "include .env" policy fails loudly at load instead of
  // being silently narrowed by the deny rule.
  assertIncludeRespectsHardDeny(configuredInclude, AUDIT_HARD_DENY);
  const effectiveAuditPolicy = resolveAuditPolicy({ include: configuredInclude, exclude: configuredExclude });
  const audit: AuditConfig = {
    include: effectiveAuditPolicy.include,
    exclude: effectiveAuditPolicy.exclude,
    maxSnapshotBytes: optionalPositiveInt(auditRawConfig.maxSnapshotBytes, 'audit.maxSnapshotBytes', DEFAULT_AUDIT_LIMITS.maxSnapshotBytes),
    maxSnapshotFiles: optionalPositiveInt(auditRawConfig.maxSnapshotFiles, 'audit.maxSnapshotFiles', DEFAULT_AUDIT_LIMITS.maxSnapshotFiles),
  };
  if (audit.include.length === 0 && audit.exclude.length === 0) {
    fail('audit policy is empty: configure audit.include and/or audit.exclude so a snapshot can be verified');
  }

  const cleanupRaw = requireRecord(raw.cleanup ?? {}, 'cleanup');
  const cleanup: CleanupConfig = {
    confirmTimeoutMs: optionalPositiveInt(cleanupRaw.confirmTimeoutMs, 'cleanup.confirmTimeoutMs', 3000),
    killTimeoutMs: optionalPositiveInt(cleanupRaw.killTimeoutMs, 'cleanup.killTimeoutMs', 5000),
  };

  const ownershipRaw = requireRecord(raw.ownership ?? {}, 'ownership');
  const ownership: OwnershipConfig = {
    staleHeartbeatMs: optionalPositiveInt(ownershipRaw.staleHeartbeatMs, 'ownership.staleHeartbeatMs', 30000),
    heartbeatMs: optionalPositiveInt(ownershipRaw.heartbeatMs, 'ownership.heartbeatMs', 5000),
  };

  const faultsRaw = requireRecord(raw.faults ?? {}, 'faults');
  const faults: FaultConfig = {
    failJobWriteOnce: faultsRaw.failJobWriteOnce === true,
    failRequestWriteOnce: faultsRaw.failRequestWriteOnce === true,
  };
  if (runnerType === 'production' && (faults.failJobWriteOnce || faults.failRequestWriteOnce)) {
    // Fault injection must never be reachable from a production deployment
    // (FIX-002 test-switch ruling): the public JobManager is shared code.
    fail('runner.type=production refuses test-only fault injection; use runner.type=fake for fault tests', {
      faults: { failJobWriteOnce: faults.failJobWriteOnce, failRequestWriteOnce: faults.failRequestWriteOnce },
    });
  }

  const redactionRaw = requireRecord(raw.redaction ?? {}, 'redaction');
  const extraSecretEnv = stringArray(redactionRaw.extraSecretEnv, 'redaction.extraSecretEnv');
  const extraLiteralSecrets = stringArray(redactionRaw.extraLiteralSecrets, 'redaction.extraLiteralSecrets');

  // R2: a configured secret is never silently dropped.
  //  - An empty literal cannot be matched by substring search without rewriting
  //    every position of every line; it is refused at load instead of being
  //    accepted and ignored. The message never contains the value.
  //  - An empty environment-variable *name* is not a declaration.
  //  - A declared name that is unset (or set but empty) has no value to redact:
  //    it is a declared boundary reported later, not an error and not a leak.
  //  - A non-empty value of any length is accepted and redacted.
  extraLiteralSecrets.forEach((value, index) => {
    if (value === '') {
      fail('redaction.extraLiteralSecrets contains an empty value; an empty literal cannot be redacted', {
        index,
        length: 0,
      });
    }
  });
  extraSecretEnv.forEach((name, index) => {
    if (name === '') {
      fail('redaction.extraSecretEnv contains an empty environment-variable name', { index });
    }
  });

  const multiline = findMultilineLiteral([
    ...extraLiteralSecrets,
    ...extraSecretEnv.map((name) => env[name]).filter((value): value is string => typeof value === 'string'),
  ]);
  if (multiline !== null) {
    fail('a configured literal secret contains a line break; line-wise redaction cannot guarantee it (see README)', {
      literalLength: multiline.length,
    });
  }
  const redactor = new Redactor(env, { extraSecretEnv, extraLiteralSecrets });

  const logger = new Logger(logLevel, redactor);

  return {
    configPath: absoluteConfig,
    serverName,
    serverVersion,
    logLevel,
    stateDir,
    taskFileRoots,
    workspaces,
    workspaceOrder,
    runner,
    limits,
    concurrency,
    recovery,
    cleanup,
    ownership,
    faults,
    audit,
    redactor,
    logger,
  };
}

/**
 * 用预配置的工作区编号查目录，再检查这个工作区是否允许当前模式；调用者不能直接传任意执行目录。
 */
export function resolveWorkspace(config: LoadedConfig, workspaceId: unknown, mode: Mode): WorkspaceConfig {
  if (typeof workspaceId !== 'string' || workspaceId === '') {
    throw new BridgeError('INVALID_ARGUMENT', 'workspaceId must be a non-empty string');
  }
  const workspace = config.workspaces.get(workspaceId);
  if (workspace === undefined) {
    throw new BridgeError('UNKNOWN_WORKSPACE', `unknown workspaceId: ${workspaceId}`, {
      workspaceId,
      configuredWorkspaces: [...config.workspaces.keys()],
    });
  }
  if (!workspace.allowedModes.includes(mode)) {
    throw new BridgeError('WORKSPACE_MODE_NOT_ALLOWED', `workspace ${workspaceId} does not allow mode ${mode}`, {
      workspaceId,
      mode,
      allowedModes: workspace.allowedModes,
    });
  }
  if (mode === 'audit' && workspace.audit === null) {
    throw new BridgeError('AUDIT_REQUIRES_SNAPSHOT', 'audit mode requires an audit workspace bound to a snapshot', {
      workspaceId,
    });
  }
  if (mode !== 'audit' && !fs.existsSync(workspace.dir)) {
    throw new BridgeError('WORKSPACE_DIR_MISSING', `workspace directory does not exist: ${workspace.dir}`, {
      workspaceId,
      dir: workspace.dir,
    });
  }
  return workspace;
}
