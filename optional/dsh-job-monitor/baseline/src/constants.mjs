/**
 * Shared constants and Chinese display labels.
 *
 * Everything here is a *local* mapping. No label is inferred from the content of
 * a log file or a task file: the panel never opens either of those.
 */

/** Same shape the bridge itself enforces before a jobId touches the filesystem. */
export const JOB_ID_PATTERN = /^job-[0-9a-zA-Z]{6,32}$/;

export function isValidJobId(value) {
  return typeof value === 'string' && JOB_ID_PATTERN.test(value);
}

/** Lock ids are opaque hex strings written by the bridge owner-lock code. */
export const LOCK_ID_PATTERN = /^[0-9a-fA-F]{8,64}$/;

export const JOB_STATUSES = Object.freeze([
  'starting',
  'running',
  'stopping',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
  'interrupted',
]);

export const TERMINAL_STATUSES = Object.freeze([
  'completed',
  'failed',
  'cancelled',
  'timed_out',
  'interrupted',
]);

export const STATUS_LABELS = Object.freeze({
  starting: '启动中',
  running: '运行中',
  stopping: '停止中',
  completed: '正常结束',
  failed: '失败',
  cancelled: '已取消',
  timed_out: '超时',
  interrupted: '中断',
  unknown: '未知状态',
});

export const STATUS_TONES = Object.freeze({
  starting: 'run',
  running: 'run',
  stopping: 'warn',
  completed: 'ok',
  failed: 'bad',
  cancelled: 'warn',
  timed_out: 'bad',
  interrupted: 'warn',
  unknown: 'unknown',
});

/**
 * `completed` means exactly "the DSH process exited 0". It is deliberately never
 * rendered as "成功": the second axis below is the independent review verdict.
 */
export const EXECUTION_DISCLAIMER = '“正常结束”只表示进程退出码为 0，不代表工作被接受。';

export const MODE_LABELS = Object.freeze({
  implement: '实施',
  fix: '修复',
  audit: '审计',
  unknown: '未知模式',
});

export const ACCEPTANCE_LABELS = Object.freeze({
  pass: '验收通过',
  fail: '验收未通过',
  pending: '待独立验收',
  none: '未提供验收记录',
});

export const ACCEPTANCE_TONES = Object.freeze({
  pass: 'ok',
  fail: 'bad',
  pending: 'warn',
  none: 'unknown',
});

/** Stable bridge error codes -> generic, actionable wording. No raw message ever. */
export const ERROR_CODE_LABELS = Object.freeze({
  INVALID_ARGUMENT: '桥拒绝了请求参数',
  INVALID_MODE: '模式不被桥接受',
  INVALID_TIMEOUT: '超时值超出桥允许范围',
  UNKNOWN_WORKSPACE: '工作区 ID 未在桥配置中注册',
  WORKSPACE_DIR_MISSING: '工作区目录不存在',
  WORKSPACE_MODE_NOT_ALLOWED: '该工作区不允许此模式',
  EMPTY_TASK: '任务内容为空',
  TASK_FILE_NOT_FOUND: '任务文件不存在',
  TASK_FILE_UNREADABLE: '任务文件不可读',
  TASK_FILE_TOO_LARGE: '任务文件超过桥上限',
  PATH_NOT_ALLOWED: '路径不在桥允许的根目录内',
  JOB_NOT_FOUND: '桥中不存在该作业',
  JOB_RECORD_UNREADABLE: '作业记录不可读',
  JOB_NOT_TERMINAL: '作业尚未进入终态',
  REQUEST_CONFLICT: '同一 requestId 的内容与已接受任务不一致',
  BUSY: '桥已有活动作业（并发上限 1）',
  RUNNER_UNAVAILABLE: 'runner 不可用',
  SPAWN_FAILED: '未能启动 DSH 进程',
  STATE_WRITE_FAILED: '桥写状态失败',
  STATE_DIR_BUSY: '状态目录被其它桥实例占用',
  ORPHAN_UNRESOLVED: '存在未能解决的孤儿进程',
  ORPHAN_IDENTITY_UNVERIFIED: '无法证明孤儿进程归属，拒绝终止',
  OWNERSHIP_LOST: '桥失去了状态目录所有权',
  REQUEST_INDEX_UNREADABLE: '请求索引不可读',
  CLEANUP_UNCONFIRMED: '未能确认作业进程树已停止',
  SNAPSHOT_FAILED: '审计快照失败',
  AUDIT_REQUIRES_SNAPSHOT: '审计作业缺少快照',
  AUDIT_SOURCE_MODIFIED: '审计期间源目录被修改',
  AUDIT_SNAPSHOT_MODIFIED: '审计期间快照被修改',
  CONFIG_INVALID: '桥配置无效',
  INTERNAL_ERROR: '桥报告内部错误',
});

export function errorCodeLabel(code) {
  if (typeof code !== 'string' || code === '') return null;
  return ERROR_CODE_LABELS[code] ?? '未收录的桥错误码（仅显示稳定码）';
}

/** Read/parse outcome codes shared by every reader in this project. */
export const READ_CODES = Object.freeze({
  ENOENT: '文件或目录不存在',
  EACCES: '权限被拒绝',
  EPERM: '操作被系统拒绝',
  EBUSY: '文件被占用',
  EMFILE: '打开文件过多',
  EISDIR: '目标是目录而非文件',
  ENOTDIR: '路径中某一段不是目录',
  NOT_A_FILE: '目标不是普通文件',
  TOO_LARGE: '文件超过本面板的读取上限',
  INVALID_JSON: 'JSON 解析失败',
  ESCAPE: '路径指向授权根之外',
  REPARSE: '路径是重解析点/符号链接，已拒绝',
  UNKNOWN: '未知的系统错误',
});

export function readCodeLabel(code) {
  if (code === null || code === undefined) return null;
  return READ_CODES[code] ?? '未分类的读取失败';
}

/** Defaults; every one of them can be lowered by the operator, never raised past the hard cap. */
export const HARD_CAPS = Object.freeze({
  maxJobs: 500,
  maxJobJsonBytes: 4 * 1024 * 1024,
  maxLedgerBytes: 4 * 1024 * 1024,
  maxOwnerBytes: 256 * 1024,
  maxScanEntries: 5000,
  maxScanDepth: 8,
  maxRecentFiles: 50,
  maxReportCandidates: 20,
  maxJobIdLength: 40,
});

export const DEFAULT_LIMITS = Object.freeze({
  maxJobs: 50,
  maxJobJsonBytes: 256 * 1024,
  maxLedgerBytes: 512 * 1024,
  maxOwnerBytes: 64 * 1024,
  maxScanEntries: 300,
  maxScanDepth: 4,
  maxRecentFiles: 12,
  maxReportCandidates: 8,
  maxStaticBytes: 512 * 1024,
});

export const DEFAULT_REFRESH_INTERVAL_MS = 5000;
export const MIN_REFRESH_INTERVAL_MS = 1000;
export const MAX_REFRESH_INTERVAL_MS = 60000;

export const DEFAULT_STALE_HEARTBEAT_MS = 30000;

export const DEFAULT_PORT = 4178;
export const DEFAULT_HOST = '127.0.0.1';

/** Directory names never descended into during a delivery scan. */
export const SCAN_IGNORED_DIRS = Object.freeze([
  '.git',
  'node_modules',
  'dist',
  'state',
  '.tmp',
  'tmp',
  '.cache',
  'coverage',
  '.dsh',
  'sessions',
  'audits',
  'audit-snapshot',
  'audit-reports',
  'b04-audit-snapshot',
  'b04-audit-reports',
  'c-audit-snapshot',
  'c-audit-reports',
  'r1-audit-snapshot',
  'r1-audit-reports',
  'r2-audit-snapshot',
  'r2-audit-reports',
]);

/** File name suffixes never reported during a delivery scan. */
export const SCAN_IGNORED_FILE_SUFFIXES = Object.freeze(['.log']);

export const SCAN_IGNORED_FILE_NAMES = Object.freeze(['.DS_Store', 'Thumbs.db']);

export const MAX_DISPLAY_NAME_LENGTH = 80;
