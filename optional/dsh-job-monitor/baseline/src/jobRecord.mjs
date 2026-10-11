/**
 * job.json -> strictly whitelisted, freshly built object.
 *
 * The raw parsed JSON is *never* returned to a caller. Only the fields listed in
 * the M01 contract are copied out; everything else (task paths, command line,
 * hashes, errorMessage, workspaceDir, stdoutLog, audit metadata, prompt text)
 * has no representation in the output object at all, so no later layer can leak
 * it by accident.
 */
import { JOB_ID_PATTERN, JOB_STATUSES } from './constants.mjs';
import { isPlainObject } from './jsonRead.mjs';

const ISO_PREFIX = /^\d{4}-\d{2}-\d{2}T/;
const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;
const ERROR_CODE = /^[A-Z0-9_]{2,40}$/;
const SIGNAL = /^[A-Za-z0-9_+.-]{1,24}$/;
const MODES = new Set(['implement', 'fix', 'audit']);
const CLEANUP_REASONS = new Set(['cancel', 'timeout', 'shutdown', 'orphan-recovery']);

function isoOrNull(value) {
  if (typeof value !== 'string' || !ISO_PREFIX.test(value)) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

function safeIdOrNull(value) {
  return typeof value === 'string' && SAFE_ID.test(value) ? value : null;
}

function nonNegativeInt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function finiteInt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function boolOrNull(value) {
  return typeof value === 'boolean' ? value : null;
}

const FAIL_REASONS = Object.freeze({
  NOT_OBJECT: '作业记录不是 JSON 对象',
  JOB_ID_INVALID: '作业记录缺少合法 jobId',
  JOB_ID_MISMATCH: '作业记录的 jobId 与所在目录不一致',
  CREATED_AT_INVALID: '作业记录缺少可解析的 createdAt',
});

const FIELD_MESSAGES = Object.freeze({
  workspaceId: '工作区 ID 非法或缺失，已忽略',
  mode: '模式字段非法或缺失，记为未知模式',
  status: '状态字段非法或缺失，记为未知状态',
  startedAt: 'startedAt 非法，已忽略',
  endedAt: 'endedAt 非法，已忽略',
  timeoutSeconds: 'timeoutSeconds 非法，已忽略',
  exitCode: 'exitCode 非法，已忽略',
  signal: 'signal 非法，已忽略',
  errorCode: 'errorCode 非法，已忽略（不回显原始文本）',
  timedOut: 'timedOut 非法，已忽略',
  cancelRequested: 'cancelRequested 非法，已忽略',
  recovered: 'recovered 非法，已忽略',
  bytes: 'bytes 计数非法，已忽略',
  rawBytes: 'rawBytes 计数非法，已忽略',
  truncated: 'truncated 标志非法，已忽略',
  cleanup: 'cleanup 字段非法，已忽略',
});

/**
 * @param {unknown} raw parsed job.json
 * @param {string} expectedJobId directory name
 * @returns {{ok:true, job:object, warnings:string[]}
 *        |  {ok:false, code:string, reason:string}}
 */
export function extractJobRecord(raw, expectedJobId) {
  if (!isPlainObject(raw)) return { ok: false, code: 'NOT_OBJECT', reason: FAIL_REASONS.NOT_OBJECT };

  const rawJobId = raw.jobId;
  if (typeof rawJobId !== 'string' || !JOB_ID_PATTERN.test(rawJobId)) {
    return { ok: false, code: 'JOB_ID_INVALID', reason: FAIL_REASONS.JOB_ID_INVALID };
  }
  if (rawJobId !== expectedJobId) {
    return { ok: false, code: 'JOB_ID_MISMATCH', reason: FAIL_REASONS.JOB_ID_MISMATCH };
  }
  const createdAt = isoOrNull(raw.createdAt);
  if (createdAt === null) {
    return { ok: false, code: 'CREATED_AT_INVALID', reason: FAIL_REASONS.CREATED_AT_INVALID };
  }

  const warnings = new Set();
  const warn = (field) => warnings.add(FIELD_MESSAGES[field] ?? '字段非法，已忽略');

  const workspaceId = safeIdOrNull(raw.workspaceId);
  if (workspaceId === null) warn('workspaceId');

  const mode = typeof raw.mode === 'string' && MODES.has(raw.mode) ? raw.mode : 'unknown';
  if (mode === 'unknown') warn('mode');

  const status =
    typeof raw.status === 'string' && JOB_STATUSES.includes(raw.status) ? raw.status : 'unknown';
  if (status === 'unknown') warn('status');

  const startedAt = isoOrNull(raw.startedAt);
  if (raw.startedAt !== null && raw.startedAt !== undefined && startedAt === null) warn('startedAt');

  const endedAt = isoOrNull(raw.endedAt);
  if (raw.endedAt !== null && raw.endedAt !== undefined && endedAt === null) warn('endedAt');

  const timeoutSeconds = nonNegativeInt(raw.timeoutSeconds);
  if (timeoutSeconds === null && raw.timeoutSeconds !== undefined) warn('timeoutSeconds');

  const exitCode =
    raw.exitCode === null || raw.exitCode === undefined ? null : finiteInt(raw.exitCode);
  if (exitCode === null && raw.exitCode !== null && raw.exitCode !== undefined) warn('exitCode');

  const signal =
    raw.signal === null || raw.signal === undefined
      ? null
      : typeof raw.signal === 'string' && SIGNAL.test(raw.signal)
        ? raw.signal
        : null;
  if (signal === null && typeof raw.signal === 'string' && !SIGNAL.test(raw.signal)) warn('signal');

  const errorCode =
    typeof raw.errorCode === 'string' && ERROR_CODE.test(raw.errorCode) ? raw.errorCode : null;
  if (errorCode === null && raw.errorCode !== null && raw.errorCode !== undefined) warn('errorCode');

  const timedOut = boolOrNull(raw.timedOut);
  if (timedOut === null && raw.timedOut !== undefined) warn('timedOut');
  const cancelRequested = boolOrNull(raw.cancelRequested);
  if (cancelRequested === null && raw.cancelRequested !== undefined) warn('cancelRequested');
  const recovered = boolOrNull(raw.recovered);
  if (recovered === null && raw.recovered !== undefined) warn('recovered');

  const bytesSource = isPlainObject(raw.bytes) ? raw.bytes : null;
  const bytes = {
    stdout: bytesSource === null ? null : nonNegativeInt(bytesSource.stdout),
    stderr: bytesSource === null ? null : nonNegativeInt(bytesSource.stderr),
  };
  if (bytesSource === null && raw.bytes !== undefined) warn('bytes');

  const rawBytesSource = isPlainObject(raw.rawBytes) ? raw.rawBytes : null;
  const rawBytes = {
    stdout: rawBytesSource === null ? null : nonNegativeInt(rawBytesSource.stdout),
    stderr: rawBytesSource === null ? null : nonNegativeInt(rawBytesSource.stderr),
  };
  if (rawBytesSource === null && raw.rawBytes !== undefined) warn('rawBytes');

  const truncatedSource = isPlainObject(raw.truncated) ? raw.truncated : null;
  const truncated = {
    stdout: truncatedSource === null ? null : boolOrNull(truncatedSource.stdout),
    stderr: truncatedSource === null ? null : boolOrNull(truncatedSource.stderr),
  };
  if (truncatedSource === null && raw.truncated !== undefined) warn('truncated');

  let cleanup = null;
  if (isPlainObject(raw.cleanup)) {
    const reason =
      typeof raw.cleanup.reason === 'string' && CLEANUP_REASONS.has(raw.cleanup.reason)
        ? raw.cleanup.reason
        : null;
    cleanup = {
      reason,
      requestedAt: isoOrNull(raw.cleanup.requestedAt),
      confirmed: boolOrNull(raw.cleanup.confirmed),
      confirmedAt: isoOrNull(raw.cleanup.confirmedAt),
    };
  } else if (raw.cleanup !== null && raw.cleanup !== undefined) {
    warn('cleanup');
  }

  const job = {
    jobId: rawJobId,
    workspaceId,
    mode,
    status,
    createdAt,
    startedAt,
    endedAt,
    timeoutSeconds,
    exitCode,
    signal,
    errorCode,
    timedOut,
    cancelRequested,
    recovered,
    bytes,
    rawBytes,
    truncated,
    cleanup,
  };

  return { ok: true, job, warnings: [...warnings] };
}
