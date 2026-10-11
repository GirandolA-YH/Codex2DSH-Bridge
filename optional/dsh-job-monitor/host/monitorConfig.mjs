/**
 * dsh-job-monitor（DSH 嵌入版）配置装载。
 *
 * 嵌入版没有命令行参数：配置来自插件目录内的 config/monitor.json。
 * 文件缺失 / JSON 非法 / 字段非法时，回落到不含路径的内置默认值，
 * 并把诊断写进 status，由前端横幅显示；绝不静默猜测目录。
 *
 * 复用基线（baseline/ 是脱敏后的 M01 采样核心快照，清单见 test/baseline-hashes.json）：
 *   - buildRealConfig 直接来自 baseline/server.mjs
 *   - createMonitor 与全部采样模块也来自基线，本文件不重复实现任何读取逻辑
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRealConfig } from '../baseline/server.mjs';

const HOST_DIR = path.dirname(fileURLToPath(import.meta.url));

export const PLUGIN_DIR = path.dirname(HOST_DIR);
export const DEFAULT_CONFIG_PATH = path.join(PLUGIN_DIR, 'config', 'monitor.json');
/** 允许用环境变量指向外部配置（便于测试与多环境部署）；未设置时用插件目录内的 config/monitor.json。 */
export const CONFIG_PATH = process.env.DSH_JOB_MONITOR_CONFIG ? path.resolve(process.env.DSH_JOB_MONITOR_CONFIG) : DEFAULT_CONFIG_PATH;
export const MAX_CONFIG_BYTES = 65536;

/**
 * 内置默认值：**不含任何私有路径**。发布版随仓提供 config/monitor.example.json（占位），
 * 安装者必须自己写 config/monitor.json 指定只读白名单路径。
 * 配置缺失时所有路径保持“未配置”，面板显示“未配置交付目录”，绝不猜测目录。
 * 交付扫描只读白名单目录的文件元数据；未列出的工作区永远显示“未配置交付目录”。
 */
export const DEFAULT_TRUSTED_CONFIG = {
  schema: 'dsh-job-monitor/config/v1',
  stateRoot: '',
  acceptanceLedger: '',
  refreshIntervalMs: 5000,
  staleHeartbeatMs: 30000,
  limits: {
    maxJobs: 50,
    maxScanEntries: 300,
    maxScanDepth: 4,
    maxJobJsonBytes: 262144,
    maxLedgerBytes: 524288,
    maxOwnerBytes: 65536,
    maxRecentFiles: 12,
    maxReportCandidates: 8,
    maxStaticBytes: 524288,
  },
  workspaceMap: {
    byWorkspaceId: {},
    byJobId: {},
    workspaceNames: {},
  },
  names: {},
};

/** 路径归一化：反斜杠→斜杠；相对路径以插件目录为基准；非法值返回 null 由调用方记诊断。 */
function normalizePath(value, base) {
  if (typeof value !== 'string') return null;
  const s = value.trim().replace(/\\/g, '/');
  if (!s) return null;
  if (/^[A-Za-z]:\//.test(s) || s.startsWith('/')) return s;
  return path.resolve(base, s).replace(/\\/g, '/');
}

/** 白名单映射逐键校验：非法键/非法路径逐条记中文诊断，绝不"顺手"补一个猜测目录。 */
function normalizeStringMap(raw, base, kind, warnings) {
  const out = {};
  if (raw === null || raw === undefined) return out;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push(`${kind} 不是对象，已忽略。`);
    return out;
  }
  for (const key of Object.keys(raw)) {
    const value = raw[key];
    if (kind === 'display-name') {
      if (typeof value === 'string' && value.trim()) out[key] = value.trim();
      else warnings.push(`展示名 ${key} 非法，已忽略。`);
      continue;
    }
    const p = normalizePath(value, base);
    if (p === null) warnings.push(`${kind} 的 ${key} 路径非法，已忽略。`);
    else out[key] = p;
  }
  return out;
}

/** limits 逐键校验（只接受正整数）；最终值由基线 buildRealConfig 夹到 HARD_CAPS，配置不能放大硬上限。 */
function normalizeLimits(raw, warnings) {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push('limits 不是对象，已忽略。');
    return {};
  }
  const out = {};
  for (const key of Object.keys(raw)) {
    const v = raw[key];
    if (Number.isInteger(v) && v > 0) out[key] = v;
    else warnings.push(`limits.${key} 非法（需要正整数），已忽略。`);
  }
  return out;
}

/**
 * 装载配置：文件覆盖内置默认（逐键合并，缺键保留默认）。
 * 返回 { ok, options, status }；options 可直接交给 createMonitor。
 */
export function loadPluginConfig(configPath = CONFIG_PATH) {
  const warnings = [];
  const merged = JSON.parse(JSON.stringify(DEFAULT_TRUSTED_CONFIG));
  let source = '内置默认（未配置任何路径）';

  let fileConfig = null;
  try {
    const st = fs.statSync(configPath);
    if (st.size > MAX_CONFIG_BYTES) {
      warnings.push(`配置文件 ${st.size} 字节超过上限 ${MAX_CONFIG_BYTES}，覆盖已忽略，使用内置默认。`);
    } else {
      fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      source = configPath;
    }
  } catch (error) {
    if (fs.existsSync(configPath)) warnings.push('配置文件 JSON 非法，覆盖已忽略，使用内置默认（未配置任何路径）。');
    else warnings.push('未找到配置文件：请在 config/monitor.json 里指定只读白名单路径（stateRoot / acceptanceLedger / workspaceMap）。');
  }

  if (fileConfig && typeof fileConfig === 'object' && !Array.isArray(fileConfig)) {
    const sr = normalizePath(fileConfig.stateRoot, PLUGIN_DIR);
    if (sr) merged.stateRoot = sr;
    else if (fileConfig.stateRoot !== undefined) warnings.push('stateRoot 非法，保留内置默认。');

    const al = normalizePath(fileConfig.acceptanceLedger, PLUGIN_DIR);
    if (al) merged.acceptanceLedger = al;
    else if (fileConfig.acceptanceLedger !== undefined) warnings.push('acceptanceLedger 非法，保留内置默认。');

    if (Number.isFinite(fileConfig.refreshIntervalMs) && fileConfig.refreshIntervalMs >= 250) {
      merged.refreshIntervalMs = fileConfig.refreshIntervalMs;
    } else if (fileConfig.refreshIntervalMs !== undefined) {
      warnings.push('refreshIntervalMs 非法（需 ≥250 毫秒），保留内置默认。');
    }

    if (Number.isFinite(fileConfig.staleHeartbeatMs) && fileConfig.staleHeartbeatMs >= 1000) {
      merged.staleHeartbeatMs = fileConfig.staleHeartbeatMs;
    } else if (fileConfig.staleHeartbeatMs !== undefined) {
      warnings.push('staleHeartbeatMs 非法（需 ≥1000 毫秒），保留内置默认。');
    }

    const limits = normalizeLimits(fileConfig.limits, warnings);
    merged.limits = { ...merged.limits, ...limits };

    const wm = fileConfig.workspaceMap;
    if (wm && typeof wm === 'object' && !Array.isArray(wm)) {
      merged.workspaceMap.byWorkspaceId = {
        ...merged.workspaceMap.byWorkspaceId,
        ...normalizeStringMap(wm.byWorkspaceId, PLUGIN_DIR, 'workspaceMap.byWorkspaceId', warnings),
      };
      merged.workspaceMap.byJobId = {
        ...merged.workspaceMap.byJobId,
        ...normalizeStringMap(wm.byJobId, PLUGIN_DIR, 'workspaceMap.byJobId', warnings),
      };
      merged.workspaceMap.workspaceNames = {
        ...merged.workspaceMap.workspaceNames,
        ...normalizeStringMap(wm.workspaceNames, PLUGIN_DIR, 'display-name', warnings),
      };
    }
    merged.names = { ...merged.names, ...normalizeStringMap(fileConfig.names, PLUGIN_DIR, 'display-name', warnings) };
  }

  const options = buildRealConfig(merged);
  const configured = Boolean(options.stateRoot);
  if (!configured) warnings.push("未配置状态根：数据接口暂停采样，请填写 stateRoot 后重启 DSH。");
  const status = {
    configured,
    app: 'dsh-job-monitor',
    readOnly: true,
    listens: false,
    configSource: source,
    configWarnings: warnings,
    stateRoot: options.stateRoot,
    acceptanceLedger: options.acceptanceLedger,
    workspaceMap: {
      byWorkspaceId: Object.keys(merged.workspaceMap.byWorkspaceId),
      byJobId: Object.keys(merged.workspaceMap.byJobId),
      workspaceNames: Object.keys(merged.workspaceMap.workspaceNames),
      names: Object.keys(merged.names),
    },
  };

  return { ok: configured, options, status, warnings };
}
