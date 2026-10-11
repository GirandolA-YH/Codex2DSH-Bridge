/**
 * CLI + config-file resolution.
 *
 * Precedence: CLI flag > config file > built-in default.
 * The listener host is forced to loopback: any other value is a hard error.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_PORT,
  DEFAULT_HOST,
  DEFAULT_LIMITS,
  DEFAULT_REFRESH_INTERVAL_MS,
  DEFAULT_STALE_HEARTBEAT_MS,
  HARD_CAPS,
} from './constants.mjs';

export const DEFAULT_STATE_ROOT = 'REPLACE/with/bridge/state/root';

const LOOPBACK_HOSTS = new Map([
  ['127.0.0.1', '127.0.0.1'],
  ['localhost', '127.0.0.1'],
  ['::1', '::1'],
]);

const NUMBER_FLAGS = new Map([
  ['--port', 'port'],
  ['--refresh-interval-ms', 'refreshIntervalMs'],
  ['--stale-heartbeat-ms', 'staleHeartbeatMs'],
]);

const STRING_FLAGS = new Map([
  ['--host', 'host'],
  ['--state-root', 'stateRoot'],
  ['--acceptance-ledger', 'acceptanceLedger'],
  ['--workspace-map', 'workspaceMapFile'],
  ['--config', 'configFile'],
  ['--dump-job', 'dumpJob'],
]);

const BOOLEAN_FLAGS = new Set(['--demo', '--dump', '--help']);

const LIMIT_FLAGS = new Map([
  ['--max-jobs', 'maxJobs'],
  ['--max-scan-entries', 'maxScanEntries'],
  ['--max-scan-depth', 'maxScanDepth'],
  ['--max-job-json-bytes', 'maxJobJsonBytes'],
  ['--max-ledger-bytes', 'maxLedgerBytes'],
  ['--max-recent-files', 'maxRecentFiles'],
]);

export const USAGE = `用法：node server.mjs [选项]

只读 DSH 作业监控面板。仅监听 loopback，仅提供 GET 数据接口与静态资源。

  --port <n>                 监听端口（默认 ${DEFAULT_PORT}，0 表示随机空闲端口）
  --host <h>                 监听地址，仅允许 127.0.0.1 / ::1 / localhost（默认 ${DEFAULT_HOST}）
  --state-root <dir>         只读状态根目录（默认 ${DEFAULT_STATE_ROOT}）
  --acceptance-ledger <file> 独立验收账本 JSON；不提供则一律“未提供验收记录”
  --workspace-map <file>     交付目录白名单 JSON（可含 names 本地名称映射）
  --config <file>            汇总配置文件 JSON（命令行参数优先）
  --demo                     使用内置演示夹具，页面显著标注“演示数据”
  --dump                     不监听，直接打印作业列表 JSON 后退出
  --dump-job <jobId>         不监听，打印单个作业详情 JSON 后退出
  --refresh-interval-ms <n>  页面刷新间隔（默认 ${DEFAULT_REFRESH_INTERVAL_MS}）
  --stale-heartbeat-ms <n>   owner 心跳过期阈值（默认 ${DEFAULT_STALE_HEARTBEAT_MS}）
  --max-jobs <n>             列表最多读取/展示的作业数
  --max-scan-entries <n>     交付目录扫描条目上限
  --max-scan-depth <n>       交付目录扫描深度上限
  --max-job-json-bytes <n>   单个 job.json 读取上限
  --max-ledger-bytes <n>     验收账本读取上限
  --max-recent-files <n>     详情中展示的最近文件数
  --help                     显示本帮助
`;

function parseNumber(raw, flag, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
    return { ok: false, message: `${flag} 需要一个 ${min}~${max} 之间的整数，收到无效值` };
  }
  return { ok: true, value };
}

/** @returns {{ok:true, config:object}|{ok:false,message:string}|{ok:true,help:true}} */
export function parseArgs(argv) {
  const cli = {};
  const limits = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (BOOLEAN_FLAGS.has(arg)) {
      if (arg === '--help') return { ok: true, help: true };
      cli[arg === '--demo' ? 'demo' : 'dump'] = true;
      continue;
    }
    const [flag, inlineValue] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, null];

    if (NUMBER_FLAGS.has(flag) || STRING_FLAGS.has(flag)) {
      const raw = inlineValue ?? argv[i + 1];
      if (raw === undefined || (inlineValue === null && raw.startsWith('--'))) {
        return { ok: false, message: `${flag} 缺少取值` };
      }
      if (inlineValue === null) i += 1;
      if (NUMBER_FLAGS.has(flag)) {
        const key = NUMBER_FLAGS.get(flag);
        const parsed = parseNumber(raw, flag, key === 'port' ? { min: 0, max: 65535 } : { min: 1 });
        if (!parsed.ok) return parsed;
        cli[key] = parsed.value;
      } else {
        cli[STRING_FLAGS.get(flag)] = raw;
      }
      continue;
    }

    if (LIMIT_FLAGS.has(flag)) {
      const raw = inlineValue ?? argv[i + 1];
      if (raw === undefined) return { ok: false, message: `${flag} 缺少取值` };
      if (inlineValue === null) i += 1;
      const key = LIMIT_FLAGS.get(flag);
      const cap = HARD_CAPS[key];
      const parsed = parseNumber(raw, flag, { min: 1, max: cap ?? Number.MAX_SAFE_INTEGER });
      if (!parsed.ok) {
        return { ok: false, message: `${flag} 超出本面板硬上限（${cap}）或不是正整数` };
      }
      limits[key] = parsed.value;
      continue;
    }

    return { ok: false, message: `未知参数：${arg}` };
  }

  if (Object.keys(limits).length > 0) cli.limits = limits;
  return { ok: true, config: cli };
}

function readConfigFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const value = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { ok: false, message: `配置文件不是 JSON 对象：${file}` };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, message: `配置文件无法读取或不是合法 JSON：${file}` };
  }
}

function readJsonFile(file) {
  const result = readConfigFile(file);
  if (!result.ok) return result;
  return result;
}

export function buildConfig(argv, cwd = process.cwd()) {
  const parsed = parseArgs(argv);
  if (parsed.help) return { ok: true, help: true };
  if (!parsed.ok) return parsed;
  const cli = parsed.config;

  const config = {
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    stateRoot: DEFAULT_STATE_ROOT,
    acceptanceLedger: null,
    workspaceMap: {},
    names: {},
    limits: { ...DEFAULT_LIMITS },
    refreshIntervalMs: DEFAULT_REFRESH_INTERVAL_MS,
    staleHeartbeatMs: DEFAULT_STALE_HEARTBEAT_MS,
    demo: false,
    dump: false,
    dumpJob: null,
  };

  const sources = [];

  if (typeof cli.configFile === 'string') {
    const fileConfig = readConfigFile(path.resolve(cwd, cli.configFile));
    if (!fileConfig.ok) return fileConfig;
    const value = fileConfig.value;
    sources.push(`配置文件 ${path.resolve(cwd, cli.configFile)}`);

    if (typeof value.stateRoot === 'string') config.stateRoot = value.stateRoot;
    if (typeof value.acceptanceLedger === 'string') config.acceptanceLedger = value.acceptanceLedger;
    if (Number.isInteger(value.port)) config.port = value.port;
    if (typeof value.host === 'string') config.host = value.host;
    if (Number.isInteger(value.refreshIntervalMs)) config.refreshIntervalMs = value.refreshIntervalMs;
    if (Number.isInteger(value.staleHeartbeatMs)) config.staleHeartbeatMs = value.staleHeartbeatMs;
    if (value.limits && typeof value.limits === 'object' && !Array.isArray(value.limits)) {
      for (const [key, raw] of Object.entries(value.limits)) {
        const cap = HARD_CAPS[key];
        if (!(key in DEFAULT_LIMITS)) continue;
        if (!Number.isInteger(raw) || raw < 1 || (cap !== undefined && raw > cap)) continue;
        config.limits[key] = raw;
      }
    }
    if (value.workspaceMap && typeof value.workspaceMap === 'object' && !Array.isArray(value.workspaceMap)) {
      config.workspaceMap = { ...value.workspaceMap };
    }
    if (value.names && typeof value.names === 'object' && !Array.isArray(value.names)) {
      config.names = { ...value.names };
    }
  }

  if (typeof cli.workspaceMapFile === 'string') {
    const result = readJsonFile(path.resolve(cwd, cli.workspaceMapFile));
    if (!result.ok) return result;
    const value = result.value;
    sources.push(`白名单映射 ${path.resolve(cwd, cli.workspaceMapFile)}`);
    // 既接受「纯映射文件」，也接受本项目的完整配置（映射在 workspaceMap 键下）。
    const map =
      value.workspaceMap && typeof value.workspaceMap === 'object' && !Array.isArray(value.workspaceMap)
        ? value.workspaceMap
        : value;
    config.workspaceMap = { ...config.workspaceMap, ...map };
    if (map.names && typeof map.names === 'object' && !Array.isArray(map.names)) {
      config.names = { ...config.names, ...map.names };
    }
  }

  if (typeof cli.stateRoot === 'string') config.stateRoot = cli.stateRoot;
  if (typeof cli.acceptanceLedger === 'string') config.acceptanceLedger = cli.acceptanceLedger;
  if (typeof cli.host === 'string') config.host = cli.host;
  if (Number.isInteger(cli.port)) config.port = cli.port;
  if (Number.isInteger(cli.refreshIntervalMs)) config.refreshIntervalMs = cli.refreshIntervalMs;
  if (Number.isInteger(cli.staleHeartbeatMs)) config.staleHeartbeatMs = cli.staleHeartbeatMs;
  if (cli.demo === true) config.demo = true;
  if (cli.dump === true) config.dump = true;
  if (typeof cli.dumpJob === 'string') config.dumpJob = cli.dumpJob;
  if (cli.limits) Object.assign(config.limits, cli.limits);

  const host = LOOPBACK_HOSTS.get(String(config.host).toLowerCase());
  if (host === undefined) {
    return {
      ok: false,
      message: `拒绝监听 ${config.host}：本面板只允许 loopback（127.0.0.1 / ::1 / localhost）。`,
    };
  }
  config.host = host;

  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
    return { ok: false, message: `端口非法：${config.port}` };
  }
  if (!Number.isInteger(config.refreshIntervalMs) || config.refreshIntervalMs < 250) {
    return { ok: false, message: 'refreshIntervalMs 需为不小于 250 的整数' };
  }
  if (!Number.isInteger(config.staleHeartbeatMs) || config.staleHeartbeatMs < 1000) {
    return { ok: false, message: 'staleHeartbeatMs 需为不小于 1000 的整数' };
  }

  for (const key of ['stateRoot', 'acceptanceLedger']) {
    if (config[key] !== null && typeof config[key] === 'string') {
      config[key] = path.resolve(cwd, config[key]);
    }
  }

  config.sources = sources;
  return { ok: true, config };
}
