/**
 * 中文模块导读
 * 任务档案柜：在磁盘上保存 job.json、已接受的任务副本和请求索引。
 * jobId 标识某次作业，requestId 是调用方给这次请求的防重复编号，两者用途不同。
 * 读不到已有记录时要报告证据问题；不能把“记录损坏”当成“从未执行”，否则可能重复启动模型。
 */
/**
 * Job and request-index persistence.
 *
 * Layout (all under `stateDir`):
 *   owner.lock                     exclusive state-directory ownership + heartbeat
 *   jobs/<jobId>/job.json          job metadata + status (atomic replace)
 *   jobs/<jobId>/task.accepted.md  frozen accepted task copy
 *   jobs/<jobId>/stdout.log        redacted stdout
 *   jobs/<jobId>/stderr.log        redacted stderr
 *   jobs/<jobId>/audit-report.json audit envelope (audit jobs only)
 *   requests/<sha256>.json         idempotency index (FIX-001 R06: hashed name)
 *
 * `jobId` is validated before it ever touches the filesystem, and the request
 * index file name is a deterministic hash of the requestId, so characters such
 * as `:` can never become an NTFS alternate data stream, a reserved device name
 * or a case-collision. The original requestId is stored inside the JSON and
 * verified on read.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, readJsonStrict, writeJsonAtomic, writeFileAtomic } from './atomic.js';
import { sha256Hex } from './hashing.js';
import { BridgeError } from './errors.js';
import type { JobRecord, RequestRecord } from './types.js';

export const JOB_ID_PATTERN = /^job-[0-9a-zA-Z]{6,32}$/;
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * 一项任务的档案、任务副本及日志路径集合。
 */
export interface JobPaths {
  dir: string;
  jobFile: string;
  taskAcceptedFile: string;
  stdoutLog: string;
  stderrLog: string;
  auditReportFile: string;
}

/**
 * 为一项作业安排档案、任务副本和两份输出日志的位置；它只组合路径，不启动程序。
 */
export function jobPaths(stateDir: string, jobId: string): JobPaths {
  const dir = path.join(stateDir, 'jobs', jobId);
  return {
    dir,
    jobFile: path.join(dir, 'job.json'),
    taskAcceptedFile: path.join(dir, 'task.accepted.md'),
    stdoutLog: path.join(dir, 'stdout.log'),
    stderrLog: path.join(dir, 'stderr.log'),
    auditReportFile: path.join(dir, 'audit-report.json'),
  };
}

/**
 * 检查作业编号格式，避免把任意路径文字当作文件名使用。
 */
export function assertValidJobId(jobId: unknown): string {
  if (typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) {
    throw new BridgeError('INVALID_ARGUMENT', 'jobId must match job-<alphanumeric>', {
      jobIdPattern: JOB_ID_PATTERN.source,
    });
  }
  return jobId;
}

/**
 * 检查请求防重复编号的长度和允许字符。
 */
export function assertValidRequestId(requestId: unknown): string {
  if (typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId)) {
    throw new BridgeError('INVALID_ARGUMENT', 'requestId must be 1-128 chars of [A-Za-z0-9._:-]', {
      requestIdPattern: REQUEST_ID_PATTERN.source,
    });
  }
  return requestId;
}

/** Deterministic, filesystem-safe request-index file name. */
/**
 * 先对 requestId 做哈希再用作文件名，避开 Windows 大小写碰撞、特殊设备名和冒号数据流问题。
 */
export function requestIndexFileName(requestId: string): string {
  return `${sha256Hex(`dsh-codex-bridge/request-index/v2\u0000${requestId}`)}.json`;
}

/**
 * 严格索引读取结果，保留损坏与不存在的区别。
 */
export type RequestIndexRead =
  | { status: 'ok'; record: RequestRecord }
  | { status: 'missing' }
  | { status: 'invalid'; reason: string };

const JOB_STATUSES = ['starting', 'running', 'stopping', 'completed', 'failed', 'cancelled', 'timed_out', 'interrupted'];

/**
 * Structural check used before any persisted record is trusted as evidence
 * (FIX-002 F2-04). A record that fails this check must be treated as
 * "unreadable", never as "no match".
 */
/**
 * 逐项检查磁盘任务档案的形状；不合格记录被视为不可读证据，不能据此重新启动同一请求。
 */
export function isValidJobRecord(record: unknown, expectedJobId?: string): record is JobRecord {
  if (record === null || typeof record !== 'object') return false;
  const candidate = record as Partial<JobRecord>;
  if (typeof candidate.jobId !== 'string' || !JOB_ID_PATTERN.test(candidate.jobId)) return false;
  if (expectedJobId !== undefined && candidate.jobId !== expectedJobId) return false;
  if (typeof candidate.requestId !== 'string' || !REQUEST_ID_PATTERN.test(candidate.requestId)) return false;
  if (typeof candidate.requestHash !== 'string' || candidate.requestHash === '') return false;
  if (typeof candidate.status !== 'string' || !JOB_STATUSES.includes(candidate.status)) return false;
  if (typeof candidate.createdAt !== 'string' || Number.isNaN(Date.parse(candidate.createdAt))) return false;
  const obj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
  const integer = (v: unknown): boolean => Number.isSafeInteger(v) && (v as number) >= 0;
  const nullableText = (v: unknown): boolean => v === null || typeof v === 'string';
  const texts = (v: unknown): boolean => Array.isArray(v) && v.every(x => typeof x === 'string');
  const pair = (v: unknown, predicate: (x: unknown) => boolean): boolean => obj(v) && predicate(v.stdout) && predicate(v.stderr);
  // Validate every field the read/diagnostic path dereferences. Unknown legacy
  // shapes are unreadable evidence, not permission to invent defaults/proof.
  for (const field of ['workspaceId', 'workspaceDir', 'taskFileOriginal', 'taskFileAccepted', 'taskFileSha256', 'taskArgSha256', 'stdoutLog', 'stderrLog', 'ownerLockId', 'ownerStartedAt'] as const) {
    if (typeof candidate[field] !== 'string' || candidate[field] === '') return false;
  }
  if (!['implement', 'fix', 'audit'].includes(candidate.mode ?? '')) return false;
  if (!['fake', 'production'].includes(candidate.runnerType ?? '')) return false;
  if (!['inline', 'pointer'].includes(candidate.promptKind ?? '')) return false;
  if (!texts(candidate.command) || !integer(candidate.taskFileBytes) || !integer(candidate.taskArgChars)) return false;
  if (!integer(candidate.timeoutSeconds) || candidate.timeoutSeconds === 0 || !integer(candidate.ownerPid)) return false;
  if (!nullableText(candidate.startedAt) || !nullableText(candidate.endedAt) || !nullableText(candidate.signal) || !nullableText(candidate.errorCode) || !nullableText(candidate.errorMessage)) return false;
  if (!(candidate.pid === null || (typeof candidate.pid === 'number' && integer(candidate.pid) && candidate.pid > 0 && candidate.pid <= 2147483647))) return false;
  if (!(candidate.exitCode === null || Number.isSafeInteger(candidate.exitCode))) return false;
  if (candidate.spawnPending !== undefined && typeof candidate.spawnPending !== 'boolean') return false;
  if (![candidate.timedOut, candidate.cancelRequested, candidate.recovered].every(v => typeof v === 'boolean')) return false;
  if (!pair(candidate.bytes, integer) || !pair(candidate.rawBytes, integer) || !pair(candidate.truncated, v => typeof v === 'boolean')) return false;
  if (candidate.cleanup !== null) {
    const c = candidate.cleanup;
    if (!obj(c) || typeof c.reason !== 'string' || !['cancel', 'timeout', 'shutdown', 'orphan-recovery', 'state-write-failure'].includes(c.reason) || typeof c.requestedAt !== 'string' || !integer(c.attempts)) return false;
    if (!['lastAttemptAt', 'method', 'detail', 'confirmedAt', 'error'].every(k => nullableText(c[k]))) return false;
    if (![c.killed, c.exited].every(v => v === null || typeof v === 'boolean') || typeof c.confirmed !== 'boolean') return false;
  }
  if (candidate.lateExit !== null && (!obj(candidate.lateExit) || !(candidate.lateExit.code === null || Number.isSafeInteger(candidate.lateExit.code)) || !nullableText(candidate.lateExit.signal) || typeof candidate.lateExit.at !== 'string')) return false;
  if (candidate.audit !== null) {
    const a = candidate.audit;
    if (!obj(a) || !['sourceWorkspaceId', 'sourceDir', 'snapshotDir', 'reportDir'].every(k => typeof a[k] === 'string')) return false;
    if (!obj(a.policy) || !texts(a.policy.include) || !texts(a.policy.exclude) || !integer(a.policy.maxFiles) || !integer(a.policy.maxBytes) || typeof a.policy.mode !== 'string' || !['deny-list', 'allowlist'].includes(a.policy.mode)) return false;
    if (![a.copiedFiles, a.copiedBytes, a.skippedReparsePoints].every(integer) || !texts(a.findings) || !nullableText(a.reportPath)) return false;
    if (typeof a.snapshotRefresh !== 'string' || !['refresh', 'reused', 'failed'].includes(a.snapshotRefresh) || ![a.sourceStable, a.snapshotStable].every(v => v === null || typeof v === 'boolean')) return false;
    for (const m of [a.sourceManifestBefore, a.sourceManifestAfter, a.snapshotManifestBefore, a.snapshotManifestAfter]) {
      if (m !== null && (!obj(m) || typeof m.digest !== 'string' || typeof m.capturedAt !== 'string' || !integer(m.fileCount) || !integer(m.totalBytes))) return false;
    }
    if (a.sourceDiff !== null && (!obj(a.sourceDiff) || ![a.sourceDiff.changed, a.sourceDiff.added, a.sourceDiff.removed].every(texts))) return false;
  }
  // childIdentity may be absent in a supported legacy record; recovery's strict
  // normalizer still treats an absent/malformed identity as unproven.
  return true;
}

/**
 * 作业编号枚举结果，附带目录读取错误。
 */
export interface JobEnumeration {
  ids: string[];
  /** Set when the jobs directory itself could not be listed. */
  enumerationError: string | null;
}

/**
 * 批量档案读取结果，保留成功记录和不可读列表。
 */
export interface JobLoadReport {
  records: JobRecord[];
  unreadable: Array<{ jobId: string; reason: string }>;
  enumerationError: string | null;
}

/**
 * 请求回溯结果，报告匹配档案以及搜索时的证据错误。
 */
export interface RequestSearchReport {
  matches: JobRecord[];
  unreadableCount: number;
  unreadable: Array<{ jobId: string; reason: string }>;
  enumerationError: string | null;
}

/**
 * 磁盘档案柜：负责读取和保存记录，不承担模型执行。
 */
export class JobStore {
  readonly stateDir: string;
  readonly #jobsDir: string;
  readonly #requestsDir: string;

  /**
   * 记住状态目录及档案/请求索引子目录的位置。
   */
  constructor(stateDir: string) {
    this.stateDir = stateDir;
    this.#jobsDir = path.join(stateDir, 'jobs');
    this.#requestsDir = path.join(stateDir, 'requests');
  }

  /**
   * 创建必要的档案目录；不启动或恢复模型任务。
   */
  init(): void {
    ensureDir(this.#jobsDir);
    ensureDir(this.#requestsDir);
  }

  /** List job ids without hiding a directory-level failure. */
  /**
   * 列出作业目录，同时返回目录级读取错误，避免错误被吞成空列表。
   */
  enumerateJobs(): JobEnumeration {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.#jobsDir, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { ids: [], enumerationError: null };
      return { ids: [], enumerationError: `cannot list jobs directory: ${code ?? String(error)}` };
    }
    return {
      ids: entries
        .filter((entry) => entry.isDirectory() && JOB_ID_PATTERN.test(entry.name))
        .map((entry) => entry.name)
        .sort(),
      enumerationError: null,
    };
  }

  /**
   * 取得当前可枚举的作业编号列表。
   */
  jobIds(): string[] {
    return this.enumerateJobs().ids;
  }

  /**
   * 取得指定作业档案路径。
   */
  jobFile(jobId: string): string {
    return jobPaths(this.stateDir, jobId).jobFile;
  }

  /**
   * 严格读取并核验单份档案，明确区分不存在与损坏。
   */
  loadJobStrict(jobId: string): { status: 'ok'; record: JobRecord } | { status: 'missing' } | { status: 'invalid'; reason: string } {
    const file = this.jobFile(jobId);
    const read = readJsonStrict<JobRecord>(file);
    if (read.status === 'missing') {
      try {
        if (fs.existsSync(path.dirname(file))) return { status: 'invalid', reason: 'known job directory exists but job.json is missing' };
      } catch { return { status: 'invalid', reason: 'job directory cannot be inspected' }; }
      return { status: 'missing' };
    }
    if (read.status === 'invalid') return { status: 'invalid', reason: read.reason };
    if (!isValidJobRecord(read.value, jobId)) {
      return { status: 'invalid', reason: 'job record is structurally invalid or an unsupported historical format' };
    }
    return { status: 'ok', record: read.value };
  }

  /**
   * 便捷读取单份档案；严格证据处理使用 loadJobStrict。
   */
  loadJob(jobId: string): JobRecord | null {
    const result = this.loadJobStrict(jobId);
    return result.status === 'ok' ? result.record : null;
  }

  /**
   * 读取可用的作业档案；需要完整错误信息时使用 loadAllJobsStrict。
   */
  loadAllJobs(): JobRecord[] {
    return this.loadAllJobsStrict().records;
  }

  /** Load every job while reporting what could not be read (FIX-002 F2-04). */
  /**
   * 读取所有档案，同时保留不可读项及枚举错误，用于阻止不安全的重复提交。
   */
  loadAllJobsStrict(): JobLoadReport {
    const enumeration = this.enumerateJobs();
    const records: JobRecord[] = [];
    const unreadable: Array<{ jobId: string; reason: string }> = [];
    for (const jobId of enumeration.ids) {
      const result = this.loadJobStrict(jobId);
      if (result.status === 'ok') records.push(result.record);
      else if (result.status === 'invalid') unreadable.push({ jobId, reason: result.reason });
    }
    return { records, unreadable, enumerationError: enumeration.enumerationError };
  }

  /**
   * 用原子替换保存完整作业记录。
   */
  saveJob(record: JobRecord): void {
    writeJsonAtomic(this.jobFile(record.jobId), record);
  }

  /**
   * 将 requestId 转成安全索引文件路径。
   */
  requestFile(requestId: string): string {
    return path.join(this.#requestsDir, requestIndexFileName(requestId));
  }

  /**
   * Read the idempotency index without collapsing failures into "missing".
   * The record's own fields are validated against the requested id.
   */
  /**
   * 读取防重复索引，并检查其原始 requestId 与当前请求完全一致。
   */
  loadRequestStrict(requestId: string): RequestIndexRead {
    const file = this.requestFile(requestId);
    const read = readJsonStrict<RequestRecord>(file);
    if (read.status === 'missing') return { status: 'missing' };
    if (read.status === 'invalid') return { status: 'invalid', reason: read.reason };
    const record = read.value;
    if (record === null || typeof record !== 'object') return { status: 'invalid', reason: 'index is not an object' };
    if (typeof record.requestId !== 'string' || record.requestId !== requestId) {
      return { status: 'invalid', reason: 'index requestId mismatch' };
    }
    if (typeof record.requestHash !== 'string' || record.requestHash === '') {
      return { status: 'invalid', reason: 'index requestHash missing' };
    }
    if (typeof record.jobId !== 'string' || !JOB_ID_PATTERN.test(record.jobId)) {
      return { status: 'invalid', reason: 'index jobId missing or malformed' };
    }
    return { status: 'ok', record };
  }

  /**
   * 按固定索引格式保存 requestId、内容摘要和 jobId 的对应关系。
   */
  saveRequest(record: Omit<RequestRecord, 'schema'> & { schema?: RequestRecord['schema'] }): void {
    const full: RequestRecord = { schema: 'dsh-codex-bridge/request-index/v2', ...record };
    writeFileAtomic(this.requestFile(record.requestId), JSON.stringify(full, null, 2) + '\n');
  }

  /**
   * 移除指定请求索引，供受理失败回滚等明确修改流程使用。
   */
  removeRequest(requestId: string): void {
    try {
      fs.rmSync(this.requestFile(requestId), { force: true });
    } catch {
      /* best effort */
    }
  }

  /** Job records that claim the given requestId (used to rebuild a lost index). */
  /**
   * 查找声明同一 requestId 的可读作业，用于索引修复。
   */
  findJobsByRequestId(requestId: string): JobRecord[] {
    return this.findJobsByRequestIdStrict(requestId).matches;
  }

  /**
   * Search job records for a requestId **and** report anything that could not be
   * read: an unreadable record means the search is inconclusive, not empty.
   */
  /**
   * 查找请求时同时保留损坏证据；不能凭“没找到可读记录”就认定可以重跑。
   */
  findJobsByRequestIdStrict(requestId: string): RequestSearchReport {
    const enumeration = this.enumerateJobs();
    const matches: JobRecord[] = [];
    const unreadable: Array<{ jobId: string; reason: string }> = [];
    for (const jobId of enumeration.ids) {
      const result = this.loadJobStrict(jobId);
      if (result.status === 'ok') {
        if (result.record.requestId === requestId) matches.push(result.record);
      } else if (result.status === 'invalid') {
        unreadable.push({ jobId, reason: result.reason });
      }
    }
    return { matches, unreadableCount: unreadable.length, unreadable, enumerationError: enumeration.enumerationError };
  }
}
