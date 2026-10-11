/**
 * 中文模块导读
 * 任务调度中心：管理一次作业从受理、启动、读取输出到结束的整个过程。
 * 阅读顺序：submit → #startJob → #onProcessExit / #requestStop → #finalize；status/result/health 提供查询。
 * 同时只有一个活动作业。持久化失败、历史记录损坏或遗留进程身份不明时会阻止新任务，避免重复执行。
 * completed 只表示子进程退出码为 0，业务结果是否正确仍须由 Codex 独立验收。
 */
/**
 * Job manager: validation, idempotency, single-active-job scheduling, process
 * supervision, ownership, persistence, recovery and cancellation.
 *
 * Guarantees implemented here:
 *  - A state directory has exactly one live owner (FIX-001 R04). A read-only
 *    manager never rewrites the owner's records and never accepts a job.
 *  - At most one job occupies the execution slot, and the slot is released only
 *    after the job's own process tree is *confirmed* stopped (FIX-001 R03). A
 *    cancel/timeout request moves the job to `stopping`; an unconfirmed stop is
 *    reported as unconfirmed, never as a successful cleanup.
 *  - The same `requestId` with the same normalized content returns the original
 *    job. An unusable request index is never treated as "new" (FIX-001 R05).
 *  - The accepted task copy is frozen and hashed before the job is
 *    acknowledged; a failure while persisting rolls the submission back so no
 *    job can stay `starting` without a process (FIX-001 R06).
 *  - Terminal states are written once, after cleanup, and are never overwritten
 *    by a late exit event. `completed` only means "the child exited 0".
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { BridgeError } from './errors.js';
import type { LoadedConfig, WorkspaceConfig } from './config.js';
import { resolveWorkspace, TIMEOUT_RANGE_SECONDS } from './config.js';
import { REDACTION_PATTERN_NAMES } from './redact.js';
import type { Logger } from './logging.js';
import { ensureDir, readJsonStrict, removeIfExists, writeFileAtomic, writeJsonAtomic } from './atomic.js';
import { sha256Hex } from './hashing.js';
import { assertWithinRoots } from './paths.js';
import { isProcessProvenDead, killPidTree, queryProcessLiveness, type KillResult } from './proctree.js';
import { assertValidJobId, assertValidRequestId, isValidJobRecord, JobStore, jobPaths } from './store.js';
import { StreamCapture, combinedText, locateTruncationNote, paginate, type PageResult } from './capture.js';
import { manifestOf, refreshSnapshot, summarizeManifest, type SnapshotLimits } from './audit.js';
import { diffManifests } from './hashing.js';
import type { Manifest } from './hashing.js';
import { acquireOwnership, type OwnershipHandle } from './ownership.js';
import { commandLineDigest, compareIdentity, normalizeChildIdentity, probeProcessIdentity } from './process-identity.js';
import type { Runner } from './runner.js';
import type { ChildIdentity, CleanupState, JobRecord, JobStatus, ManifestSummary, Mode } from './types.js';
import { isTerminal, MODES } from './types.js';

/**
 * Codex 提交请求时允许提供的五项信息，目录和启动器不属于请求输入。
 */
export interface SubmitInput {
  requestId: unknown;
  workspaceId: unknown;
  taskFile: unknown;
  mode: unknown;
  timeoutSeconds?: unknown;
}

/**
 * 对外状态视图；字段用于核对执行和证据，不能替代业务验收。
 */
export interface JobView {
  ok: true;
  jobId: string;
  status: JobStatus;
  terminal: boolean;
  mode: Mode;
  workspaceId: string;
  workspaceDir: string;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  recovered: boolean;
  error: { code: string; message: string } | null;
  pid: number | null;
  timeoutSeconds: number;
  runner: { type: string; command: string[] };
  task: {
    file: string;
    acceptedCopy: string;
    sha256: string;
    bytes: number;
    promptKind: 'inline' | 'pointer';
    taskArgChars: number;
    taskArgSha256: string;
  };
  output: {
    stdoutStoredBytes: number;
    stderrStoredBytes: number;
    stdoutRawBytes: number;
    stderrRawBytes: number;
    truncated: { stdout: boolean; stderr: boolean };
    stdoutLog: string;
    stderrLog: string;
    /** True while these counters come from the live in-memory capture (R4). */
    live: boolean;
  };
  cleanup: CleanupState | null;
  audit: {
    sourceWorkspaceId: string;
    sourceDir: string;
    snapshotDir: string;
    policy: { include: string[]; exclude: string[]; maxFiles: number; maxBytes: number; mode: string };
    copiedFiles: number;
    copiedBytes: number;
    skippedReparsePoints: number;
    sourceStable: boolean | null;
    snapshotStable: boolean | null;
    sourceManifestBefore: ManifestSummary | null;
    sourceManifestAfter: ManifestSummary | null;
    snapshotManifestBefore: ManifestSummary | null;
    snapshotManifestAfter: ManifestSummary | null;
    sourceDiff: { changed: string[]; added: string[]; removed: string[] } | null;
    findings: string[];
    reportPath: string | null;
    snapshotRefresh: 'refresh' | 'reused' | 'failed';
  } | null;
  lateExit: { code: number | null; signal: string | null; at: string } | null;
  persistence: { durable: boolean; error: { code: 'STATE_WRITE_FAILED'; message: string } | null };
}

/**
 * 某个输出流的磁盘长度和完整性判断，用来区分完整、损坏或无法证实。
 */
export interface ResultReadEntry {
  stream: 'stdout' | 'stderr';
  expectedBytes: number;
  observedBytes: number;
  integrity: 'exact' | 'truncation-marker-verified' | 'unverified-extra-bytes';
  note: string;
}

/**
 * 说明结果来自运行中收集还是磁盘日志，并列出实际读取流的核验情况。
 */
export interface ResultReadReport {
  source: 'live-capture' | 'stored-log';
  /** One entry per stream actually read (R3: never an unrelated stream). */
  entries: ResultReadEntry[];
}

/**
 * 状态信息加一页输出；page.output 才是本页正文，read 是读取证据。
 */
export interface ResultView extends JobView {
  page: PageResult;
  /**
   * How the returned text was verified: live in-memory capture or a stored log
   * checked against the recorded stored byte count (R3).
   */
  read: ResultReadReport;
}

/**
 * 提交回执：告诉调用方接受了哪个作业，以及是否复用了旧请求。
 */
export interface SubmitAck {
  accepted: true;
  jobId: string;
  status: JobStatus;
  reusedExistingJob: boolean;
  view: JobView;
}

/**
 * 只存在于内存的活动任务控制信息，包含输出收集器、计时器和子进程句柄。
 */
interface ActiveJob {
  jobId: string;
  stdout: StreamCapture;
  stderr: StreamCapture;
  killReason: 'cancel' | 'timeout' | 'shutdown' | 'state-write-failure' | null;
  timer: NodeJS.Timeout | null;
  childPid: number | null;
  child: import('node:child_process').ChildProcess | null;
  kill: (() => Promise<KillResult | null>) | null;
  /** Latest kill attempt, so late-arriving attribution evidence can be recorded. */
  lastKillPromise: Promise<KillResult | null> | null;
  /**
   * A stop was requested (cancel/timeout/shutdown) before the deferred start
   * ran. The job must then never spawn: there is no process to tree-kill, and
   * no kill may be fabricated for it (R1).
   */
  stopRequested: boolean;
  /** Proven: no child process was ever started for this job (R1). */
  neverStarted: boolean;
  exited: boolean;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  cleanupPromise: Promise<boolean> | null;
  finalized: boolean;
}

/**
 * 重启后遗留进程问题的阻断说明；身份未证明时防止新任务覆盖现场。
 */
interface OrphanBlock {
  jobIds: string[];
  pids: number[];
  guidance: string;
}

/**
 * 作业总管：协调运行器、档案柜、使用权、输出收集和审计检查。
 */
export class JobManager {
  readonly #config: LoadedConfig;
  readonly #store: JobStore;
  readonly #runner: Runner;
  readonly #log: Logger;
  #records = new Map<string, JobRecord>();
  #active: ActiveJob | null = null;
  #shuttingDown = false;
  #ownership: OwnershipHandle | null = null;
  #orphanBlock: OrphanBlock | null = null;
  #orphanResolution: Promise<void> | null = null;
  #unreadableJobs: Array<{ jobId: string; reason: string }> = [];
  #enumerationError: string | null = null;
  #ownershipLost: string | null = null;
  #auditManifests = new Map<string, { source: Manifest; snapshot: Manifest }>();
  #faultsUsed = new Set<string>();
  #pendingWrites = new Map<string, string>();
  #unresolvedSpawnJobIds: string[] = [];
  readonly #startedAt = new Date().toISOString();

  /**
   * 保存配置、运行器和档案柜引用，准备内存中的任务记录；真正恢复状态在 init 中进行。
   */
  constructor(config: LoadedConfig, runner: Runner) {
    this.#config = config;
    this.#runner = runner;
    this.#log = config.logger;
    this.#store = new JobStore(config.stateDir);
  }

  /**
   * 提供档案柜引用，方便既有验证或管理逻辑访问；不是新任务启动入口。
   */
  get store(): JobStore {
    return this.#store;
  }

  /**
   * 返回当前占用执行位置的任务编号；没有活动任务时为 null。
   */
  get activeJobId(): string | null {
    return this.#active?.jobId ?? null;
  }

  /**
   * 实时检查本实例是否仍拥有状态目录，而不是只记住启动时曾取得锁。
   */
  get isOwner(): boolean {
    return this.#ownershipLost === null && this.#ownership?.owned === true;
  }

  /** Re-validate ownership now; returns whether this instance is still the owner. */
  /**
   * 重新核对使用权；发现已失去锁时触发停止自己的任务和停止持久化。
   */
  checkOwnership(): boolean {
    this.#ownership?.heartbeat();
    return this.isOwner;
  }

  /**
   * Ownership was lost (another owner took over, or the lock could not be
   * refreshed): revoke execution and persistence rights immediately and stop any
   * job this instance still owns.
   */
  /**
   * 使用权丢失后撤销执行/保存权限，并处理本实例已启动的活动任务，避免继续与新持有者竞争。
   */
  #onOwnershipLost(reason: string): void {
    if (this.#ownershipLost !== null) return;
    this.#ownershipLost = reason;
    this.#log.error('lost state-directory ownership; revoking execution and persistence rights', { reason });
    const active = this.#active;
    if (active === null) return;
    const record = this.#records.get(active.jobId);
    if (record === undefined || isTerminal(record.status)) return;
    active.killReason = 'shutdown';
    // Terminal state first (in memory: persistence rights are revoked), then the
    // process tree, so a late exit cannot re-map the job to failed/completed.
    this.#finalize(record, active, {
      status: 'interrupted',
      errorCode: 'OWNERSHIP_LOST',
      errorMessage: `state-directory ownership was lost: ${reason}`,
    });
    void (async () => {
      try {
        await active.kill?.();
      } catch {
        /* best effort: another owner may already be managing this tree */
      }
    })();
  }

  /**
   * 取得审计快照共用的筛选规则及容量限制。
   */
  #snapshotLimits(): SnapshotLimits {
    return {
      include: this.#config.audit.include,
      exclude: this.#config.audit.exclude,
      maxFiles: this.#config.audit.maxSnapshotFiles,
      maxBytes: this.#config.audit.maxSnapshotBytes,
    };
  }

  /**
   * Take ownership of the state directory and recover persisted jobs.
   *
   * Synchronous by contract: callers (and the delivered interface) expect `init`
   * to return once ownership is decided. Orphan cleanup, when enabled, runs
   * asynchronously and blocks submissions until it is verified.
   */
  /**
   * 启动时读取历史任务并取得目录使用权；遗留的未结束任务记为中断，不自动重跑。
   */
  init(): void {
    this.#store.init();
    this.#ownership = acquireOwnership(this.#config.stateDir, {
      staleHeartbeatMs: this.#config.ownership.staleHeartbeatMs,
      heartbeatMs: this.#config.ownership.heartbeatMs,
      bridgeVersion: this.#config.serverVersion,
      onLost: (reason) => this.#onOwnershipLost(reason),
    });
    if (!this.#ownership.owned) {
      this.#log.warn('state directory is owned by another bridge; running read-only', {
        stateDir: this.#config.stateDir,
        diagnostic: this.#ownership.view().diagnostic,
      });
      return;
    }

    const records = this.#store.loadAllJobsStrict();
    this.#unreadableJobs = records.unreadable;
    this.#enumerationError = records.enumerationError;
    if (records.unreadable.length > 0 || records.enumerationError !== null) {
      this.#log.error('stored job evidence is not fully readable; new submissions are blocked until it is repaired', {
        unreadable: records.unreadable,
        enumerationError: records.enumerationError,
      });
    }
    const orphanJobIds: string[] = [];
    const orphanPids: number[] = [];
    for (const record of records.records) {
      this.#records.set(record.jobId, record);
      if (record.spawnPending === true && record.pid === null && (!isTerminal(record.status) || record.recovered)) {
        this.#unresolvedSpawnJobIds.push(record.jobId);
      }
      const stopVerified = record.cleanup?.confirmed === true;
      // A pid only counts as a possible orphan when this bridge never verified a
      // stop: a job that is still non-terminal, or one a previous recovery marked
      // interrupted without confirming the process is gone.
      const possibleOrphan =
        record.pid !== null &&
        !stopVerified &&
        (record.recovered === true || !isTerminal(record.status)) &&
        queryProcessLiveness(record.pid) !== 'dead';
      if (possibleOrphan) {
        orphanJobIds.push(record.jobId);
        orphanPids.push(record.pid as number);
      }
      if (isTerminal(record.status)) continue;
      const previous = record.status;
      record.status = 'interrupted';
      record.errorCode = 'INTERRUPTED';
      record.errorMessage = `bridge restarted while the job was ${previous}; the job was not re-run`;
      record.endedAt = new Date().toISOString();
      record.recovered = true;
      record.cleanup = null;
      this.#persist(record);
      this.#log.warn('recovered non-terminal job as interrupted', { jobId: record.jobId, previousStatus: previous });
    }

    if (orphanPids.length > 0) {
      const identityHint =
        'This bridge will not terminate a pid unless it can prove identity. Inspect the pid yourself (for example `Get-Process -Id <pid>`) and stop it only if it is the old job; ' +
        'if it is not, clear the stale record under stateDir/jobs. Enabling recovery.killOrphanedChildrenOnStart only applies when the recorded child identity can be verified.';
      const guidance =
        `a process from a previous bridge run may still be alive (jobs ${orphanJobIds.join(', ')}, pids ${orphanPids.join(', ')}). ` +
        `The bridge cannot prove that a reused pid is still the old job. ${identityHint}`;
      if (this.#config.recovery.killOrphanedChildrenOnStart) {
        this.#log.warn('evaluating orphan cleanup with identity proof before any termination', { pids: orphanPids });
        this.#orphanResolution = (async () => {
          const survivors: number[] = [];
          const evidence: Array<Record<string, unknown>> = [];
          try {
            for (const jobId of orphanJobIds) {
              const record = this.#records.get(jobId);
              if (record === undefined || record.pid === null) continue;
              const pid = record.pid;
              // Old records (written before identity recording existed) have no
              // identity field at all: that is "unverifiable", not a crash and
              // not a permission to terminate (FIX-003 F3-03).
              const identity = normalizeChildIdentity(record.childIdentity);
              const comparison =
                identity === null
                  ? { proven: false, reason: 'no valid child identity was recorded for this job; identity cannot be verified' }
                  : compareIdentity(identity, probeProcessIdentity(pid));
              evidence.push({ jobId, pid, proven: comparison.proven, reason: comparison.reason });
              if (!comparison.proven) {
                this.#log.warn('refusing to terminate a pid whose identity is not proven', { jobId, pid, reason: comparison.reason });
                if (queryProcessLiveness(pid) !== 'dead') survivors.push(pid);
                continue;
              }
              const result = await killPidTree(pid, this.#config.cleanup.killTimeoutMs);
              const stillAlive = queryProcessLiveness(pid) !== 'dead';
              if (stillAlive) survivors.push(pid);
              const now = new Date().toISOString();
              record.cleanup = {
                reason: 'orphan-recovery',
                requestedAt: now,
                attempts: 1,
                lastAttemptAt: now,
                method: result.method,
                killed: result.killed,
                exited: result.exited,
                detail: `identity proven (${comparison.reason})`,
                confirmed: !stillAlive,
                confirmedAt: stillAlive ? null : now,
                error: stillAlive ? 'pid still alive after the verified kill' : null,
              };
              this.#persist(record);
            }
          } catch (error) {
            // The gate must never be released by an exception, and the service
            // must not die from an unhandled rejection.
            this.#log.error('orphan identity verification failed', { message: error instanceof Error ? error.message : String(error) });
            evidence.push({ error: error instanceof Error ? error.message : String(error) });
            for (const jobId of orphanJobIds) {
              const record = this.#records.get(jobId);
              if (record?.pid != null && queryProcessLiveness(record.pid) !== 'dead' && !survivors.includes(record.pid)) survivors.push(record.pid);
            }
          }
          if (survivors.length > 0) {
            this.#orphanBlock = {
              jobIds: orphanJobIds,
              pids: survivors,
              guidance: `${guidance} Unverified or surviving pids: ${survivors.join(', ')}. ${identityHint}`,
            };
            this.#log.error('orphan cleanup not confirmed; new jobs stay blocked', { survivors, evidence });
          } else {
            this.#orphanBlock = null;
            this.#log.info('orphan cleanup confirmed for every verified pid', { evidence });
          }
        })().catch((error: unknown) => {
          // Last-resort guard: keep the block and stay diagnosable.
          this.#orphanBlock = {
            jobIds: orphanJobIds,
            pids: orphanPids,
            guidance: `${guidance} Orphan verification could not run: ${error instanceof Error ? error.message : String(error)}. ${identityHint}`,
          };
          this.#log.error('orphan resolution aborted; new jobs stay blocked', {
            message: error instanceof Error ? error.message : String(error),
          });
        });
      } else {
        this.#orphanBlock = { jobIds: orphanJobIds, pids: orphanPids, guidance };
        this.#log.warn('blocking new jobs until the recorded orphan is resolved', { pids: orphanPids });
      }
    }

    this.#log.info('job store loaded', {
      jobs: records.records.length,
      stateDir: this.#config.stateDir,
      orphans: orphanPids.length,
      unreadable: records.unreadable.length,
      ownership: this.#ownership.mode,
    });
  }

  /**
   * 保存任务档案；失败会记入待保存清单，必要时报告错误，不能伪装成已经持久化。
   */
  #persist(record: JobRecord, required = false): boolean {
    if (!this.isOwner) {
      // Persistence rights are revoked together with execution rights: an old
      // owner must never rewrite a record another owner now controls.
      this.#log.warn('persistence skipped: this instance is not the state-directory owner', {
        jobId: record.jobId,
        ownershipLost: this.#ownershipLost,
      });
      if (required) throw new BridgeError('STATE_DIR_BUSY', 'state-directory ownership was lost before acceptance');
      return false;
    }
    // R2-07: redact diagnostics at the disk gate, preserving machine fields.
    try {
      this.#store.saveJob(this.#redactedRecord(record));
      this.#pendingWrites.delete(record.jobId);
      return true;
    } catch (error) {
      const message = this.#config.redactor.redact(error instanceof Error ? error.message : String(error));
      this.#pendingWrites.set(record.jobId, message);
      this.#log.error('state write failed; process supervision retained and new jobs blocked until persistence recovers', { jobId: record.jobId, message });
      if (required) throw new BridgeError('STATE_WRITE_FAILED', message, { jobId: record.jobId });
      return false;
    }
  }

  /** Explicit mutation paths retry outstanding writes; health/status stay read-only. */
  /**
   * 在明确的修改入口重试尚未保存的档案；这只是本地写文件，不是重开模型任务。
   */
  #flushPendingWrites(): void {
    if (!this.isOwner) return;
    for (const id of [...this.#pendingWrites.keys()]) {
      const record = this.#records.get(id);
      if (record !== undefined) this.#persist(record);
    }
  }

  /**
   * 优先使用内存记录，再严格读取磁盘档案；区分不存在与不可读。
   */
  #load(jobId: string): JobRecord | null {
    const cached = this.#records.get(jobId);
    if (cached !== undefined) return cached;
    const loaded = this.#store.loadJobStrict(jobId);
    if (loaded.status === 'ok') {
      this.#records.set(jobId, loaded.record);
      return loaded.record;
    }
    if (loaded.status === 'invalid') {
      // An unreadable record is not "no such job": report the integrity problem.
      throw new BridgeError('JOB_RECORD_UNREADABLE', `job record ${jobId} cannot be read: ${loaded.reason}`, {
        jobId,
        reason: loaded.reason,
      });
    }
    return null;
  }

  /**
   * 验证超时参数为合法整数，并落在已配置的最小/最大秒数内。
   */
  #validateTimeout(value: unknown): number {
    const limits = this.#config.limits;
    // R2-05: the accepted window is the MCP schema window (1-3600), enforced
    // here as well as in `loadConfig`. The `Math.min` keeps a hand-built config
    // (a test or an embedder that bypasses `loadConfig`) from widening it.
    const min = Math.max(TIMEOUT_RANGE_SECONDS.min, limits.minTimeoutSeconds);
    const max = Math.min(TIMEOUT_RANGE_SECONDS.max, limits.maxTimeoutSeconds);
    if (value === undefined) {
      if (limits.defaultTimeoutSeconds < min || limits.defaultTimeoutSeconds > max) {
        throw new BridgeError('INVALID_TIMEOUT', `configured defaultTimeoutSeconds must be between ${min} and ${max}`, {
          defaultTimeoutSeconds: limits.defaultTimeoutSeconds,
          min,
          max,
        });
      }
      return limits.defaultTimeoutSeconds;
    }
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new BridgeError('INVALID_TIMEOUT', 'timeoutSeconds must be an integer', { timeoutSeconds: value });
    }
    if (value < min || value > max) {
      throw new BridgeError('INVALID_TIMEOUT', `timeoutSeconds must be between ${min} and ${max}`, {
        timeoutSeconds: value,
        min,
        max,
      });
    }
    return value;
  }

  /**
   * 验证任务模式只能是 implement、fix 或 audit。
   */
  #validateMode(value: unknown): Mode {
    if (typeof value !== 'string' || !(MODES as readonly string[]).includes(value)) {
      throw new BridgeError('INVALID_MODE', `mode must be one of ${MODES.join(', ')}`, { mode: value });
    }
    return value as Mode;
  }

  /**
   * Read and validate a task file (R2-03).
   *
   * The accepted copy is byte-frozen and its SHA-256 is part of the handoff
   * evidence ("this is exactly what the child received"). Buffer#toString('utf8')
   * would silently replace every invalid sequence with U+FFFD, so the frozen copy
   * could no longer be the bytes that were hashed: a 5-byte GBK file became a
   * 10-byte copy while `taskFileSha256` still described the original. The input
   * is therefore decoded with a fatal decoder and a non-UTF-8 task is refused
   * *before* acceptance, so no runner is started, no execution slot is taken and
   * no job id is issued. A UTF-8 BOM is valid UTF-8 and is preserved verbatim, so
   * the copy still matches the recorded hash byte for byte.
   */
  /**
   * 检查任务文件目录与大小，读取真实内容并计算摘要。受理后的任务会另存冻结副本。
   */
  #readTaskFile(taskFile: unknown): { canonicalPath: string; text: string; sha256: string; bytes: number } {
    const resolved = assertWithinRoots(this.#config.taskFileRoots, taskFile as string, {
      label: 'taskFile',
      requireExists: true,
    });
    let stats: fs.Stats;
    try {
      stats = fs.statSync(resolved.path);
    } catch {
      throw new BridgeError('TASK_FILE_NOT_FOUND', 'taskFile cannot be read', { taskFile: resolved.path });
    }
    if (!stats.isFile()) {
      throw new BridgeError('TASK_FILE_UNREADABLE', 'taskFile must be a regular file', { taskFile: resolved.path });
    }
    if (stats.size > this.#config.limits.maxTaskFileBytes) {
      throw new BridgeError('TASK_FILE_TOO_LARGE', `taskFile exceeds maxTaskFileBytes=${this.#config.limits.maxTaskFileBytes}`, {
        taskFile: resolved.path,
        bytes: stats.size,
      });
    }
    let buffer: Buffer;
    try {
      // Bounded read: even a stale stat or a growing file cannot allocate or
      // freeze an unbounded task. One extra byte distinguishes exact-cap EOF.
      const cap = this.#config.limits.maxTaskFileBytes;
      const chunks: Buffer[] = [];
      let bytes = 0;
      const fd = fs.openSync(resolved.path, 'r');
      try {
        while (bytes <= cap) {
          const chunk = Buffer.alloc(Math.min(64 * 1024, cap + 1 - bytes));
          const count = fs.readSync(fd, chunk, 0, chunk.length, null);
          if (count === 0) break;
          chunks.push(chunk.subarray(0, count)); bytes += count;
          if (bytes > cap) throw new BridgeError('TASK_FILE_TOO_LARGE', `taskFile exceeds maxTaskFileBytes=${cap}`, { taskFile: resolved.path, bytesAtLeast: bytes });
        }
        buffer = Buffer.concat(chunks, bytes);
      } finally { fs.closeSync(fd); }
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError('TASK_FILE_UNREADABLE', `taskFile cannot be read: ${error instanceof Error ? error.message : String(error)}`, {
        taskFile: resolved.path,
      });
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
    } catch {
      // The message never quotes the bytes: a rejected task may itself contain a
      // credential and must not be echoed into a diagnostic.
      throw new BridgeError('TASK_FILE_NOT_UTF8', 'taskFile is not valid UTF-8; a frozen accepted copy cannot be hashed byte-for-byte from re-encoded text', {
        taskFile: resolved.path,
        bytes: buffer.length,
        requirement: 'the task file must be valid UTF-8; convert it before submitting',
      });
    }
    if (text.trim() === '') {
      throw new BridgeError('EMPTY_TASK', 'taskFile is empty or whitespace only', { taskFile: resolved.path });
    }
    return { canonicalPath: resolved.path, text, sha256: sha256Hex(buffer), bytes: buffer.length };
  }

  /**
   * 短任务直接传全文；长任务传指向已接受副本的说明，避免命令行长度限制或正文被裁掉。
   */
  #buildTaskArg(acceptedPath: string, text: string, sha256: string, bytes: number): { taskArg: string; promptKind: 'inline' | 'pointer' } {
    if (text.length <= this.#config.limits.inlineTaskMaxChars) {
      return { taskArg: text, promptKind: 'inline' };
    }
    const pointer =
      `请读取并执行这份已冻结的任务文件（完整内容，未截断）：\n${acceptedPath}\n` +
      `该副本是本次作业的已接受任务，SHA-256=${sha256}，共 ${bytes} 字节；原始任务文件此后的修改不影响本作业。`;
    return { taskArg: pointer, promptKind: 'pointer' };
  }

  /**
   * Resolve the idempotency index. Never turns an unusable index into "new".
   */
  /**
   * 按 requestId 查已接受请求。同编号同内容返回旧作业；同编号不同内容拒绝，防止重复计费。
   */
  #resolveExistingRequest(requestId: string, requestHash: string): { job: JobRecord; reused: true } | { missing: true; invalidReason: string | null } {
    const index = this.#store.loadRequestStrict(requestId);
    if (index.status === 'ok') {
      const record = this.#load(index.record.jobId);
      if (record !== null) {
        // The index must identify the same request *and* the same job: an index
        // that points at another request's job is unusable evidence (F2-04).
        const identityMatches =
          record.jobId === index.record.jobId &&
          record.requestId === index.record.requestId &&
          record.requestHash === index.record.requestHash;
        if (identityMatches && record.requestHash === requestHash) return { job: record, reused: true };
        if (identityMatches && record.requestHash !== requestHash) {
          throw new BridgeError('REQUEST_CONFLICT', 'requestId was already used with different content', {
            requestId,
            existingJobId: record.jobId,
          });
        }
        return this.#recoverOrRefuse(
          requestId,
          requestHash,
          `index for ${requestId} points at job ${index.record.jobId}, whose record belongs to ${record.requestId} with a different hash`,
        );
      }
      // Index points at a job we cannot read: recover from the job records.
      return this.#recoverOrRefuse(requestId, requestHash, `index referenced job ${index.record.jobId}, which is missing or unreadable`);
    }
    if (index.status === 'invalid') {
      return this.#recoverOrRefuse(requestId, requestHash, `request index is unusable (${index.reason})`);
    }
    // Index missing: a job record may still prove this request already ran, so
    // recovery runs here too instead of assuming the request is new (R05).
    return this.#recoverOrRefuse(requestId, requestHash, 'request index is missing');
  }

  /** Rebuild a lost index from job records, or refuse rather than risk a re-run. */
  /**
   * 索引缺失时从任务档案寻找请求；只有证据能排除重复时才继续，证据损坏则拒绝猜测。
   */
  #recoverOrRefuse(requestId: string, requestHash: string, reason: string): { job: JobRecord; reused: true } | { missing: true; invalidReason: null } {
    const search = this.#store.findJobsByRequestIdStrict(requestId);
    // Unreadable or unlistable evidence means the search is inconclusive: we
    // cannot claim this request is new (FIX-002 F2-04).
    if (search.enumerationError !== null || search.unreadableCount > 0) {
      throw new BridgeError('REQUEST_INDEX_UNREADABLE', 'the stored job evidence cannot be fully read, so this request cannot be proven new; refusing to start a possibly duplicate run', {
        requestId,
        reason,
        enumerationError: search.enumerationError,
        unreadableJobs: search.unreadable.slice(0, 10),
        guidance: 'repair or remove the unreadable job record(s), then retry; the bridge will not start a possibly duplicate paid run',
      });
    }
    const verified = search.matches.filter(
      (record) => record.requestId === requestId && isValidJobRecord(record, record.jobId),
    );
    const same = verified.filter((record) => record.requestHash === requestHash);
    const different = verified.filter((record) => record.requestHash !== requestHash);
    if (same.length > 0) {
      const record = same.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[0] as JobRecord;
      this.#records.set(record.jobId, record);
      this.#store.saveRequest({ requestId, requestHash, jobId: record.jobId, createdAt: record.createdAt });
      this.#log.warn('rebuilt a lost request index from the job record', { requestId, jobId: record.jobId, reason });
      return { job: record, reused: true };
    }
    if (different.length > 0) {
      throw new BridgeError('REQUEST_CONFLICT', 'requestId was already used with different content', {
        requestId,
        existingJobId: different[0]?.jobId ?? null,
      });
    }
    if (reason === 'request index is missing') {
      // No index and conclusive job evidence that this request never ran.
      return { missing: true, invalidReason: null };
    }
    throw new BridgeError('REQUEST_INDEX_UNREADABLE', 'the request index cannot be read and no matching job record proves this request is new; refusing to start a possibly duplicate run', {
      requestId,
      reason,
    });
  }

  /**
   * 受理一次任务。先做安全和防重复检查，再保存任务副本与索引，最后异步启动；返回编号不代表任务完成。
   */
  async submit(input: SubmitInput): Promise<SubmitAck> {
    if (this.#shuttingDown) {
      throw new BridgeError('INTERNAL_ERROR', 'bridge is shutting down');
    }
    if (!this.isOwner) {
      throw new BridgeError('STATE_DIR_BUSY', 'this bridge does not own the state directory; it is read-only', {
        stateDir: this.#config.stateDir,
        ownershipLost: this.#ownershipLost,
        diagnostic: this.#ownership?.view().diagnostic ?? null,
      });
    }
    if (this.#orphanResolution !== null) {
      await this.#orphanResolution;
    }
    // Recovery can itself discover a write failure or lose ownership while
    // awaited. Recheck both gates after it, before any request is accepted.
    if (this.#shuttingDown || !this.isOwner) throw new BridgeError('STATE_DIR_BUSY', 'execution rights changed while waiting for recovery');
    this.#flushPendingWrites();
    if (this.#pendingWrites.size > 0) {
      throw new BridgeError('STATE_WRITE_FAILED', 'job state is not durably stored; new submissions are blocked', { jobIds: [...this.#pendingWrites.keys()] });
    }
    if (this.#enumerationError !== null || this.#unreadableJobs.length > 0) {
      // "Never read" is not "never executed" (FIX-002 F2-04).
      throw new BridgeError('REQUEST_INDEX_UNREADABLE', 'stored job evidence cannot be fully read; refusing to start a possibly duplicate run', {
        enumerationError: this.#enumerationError,
        unreadableJobs: this.#unreadableJobs.slice(0, 10),
        guidance: 'repair or remove the unreadable job record(s) under stateDir/jobs, then restart the bridge',
      });
    }
    if (this.#orphanBlock !== null) {
      throw new BridgeError('ORPHAN_UNRESOLVED', this.#orphanBlock.guidance, {
        orphanJobIds: this.#orphanBlock.jobIds,
        orphanPids: this.#orphanBlock.pids,
      });
    }
    if (this.#unresolvedSpawnJobIds.length > 0) {
      throw new BridgeError('ORPHAN_UNRESOLVED', 'a durable spawn intent has no recorded child pid; an unrecorded child cannot be ruled out. Inspect the abandoned job manually; the bridge will not auto-kill or start new work', { jobIds: this.#unresolvedSpawnJobIds });
    }

    const requestId = assertValidRequestId(input.requestId);
    const mode = this.#validateMode(input.mode);
    const timeoutSeconds = this.#validateTimeout(input.timeoutSeconds);
    const workspace = resolveWorkspace(this.#config, input.workspaceId, mode);
    const task = this.#readTaskFile(input.taskFile);

    /**
     * 受理步骤 1：为任务正文、工作区、模式和时限生成整体指纹，用它检查请求是否被换了内容。
     */
    const requestHash = sha256Hex(
      JSON.stringify({
        workspaceId: workspace.workspaceId,
        mode,
        taskFile: task.canonicalPath,
        timeoutSeconds,
        taskSha256: task.sha256,
      }),
    );

    /**
     * 受理步骤 2：先查防重复记录；同一请求已受理时返回原 jobId，不再启动一次模型。
     */
    const existing = this.#resolveExistingRequest(requestId, requestHash);
    if ('job' in existing) {
      return { accepted: true, jobId: existing.job.jobId, status: existing.job.status, reusedExistingJob: true, view: this.#view(existing.job) };
    }

    const runnerDescription = this.#runner.describe();
    if (!runnerDescription.available) {
      throw new BridgeError('RUNNER_UNAVAILABLE', runnerDescription.diagnostic ?? 'runner is not available', {
        runnerType: runnerDescription.type,
      });
    }

    if (this.#active !== null) {
      throw new BridgeError('BUSY', 'another job is still occupying the execution slot', {
        activeJobId: this.#active.jobId,
        activeStatus: this.#records.get(this.#active.jobId)?.status ?? 'unknown',
      });
    }

    if (mode === 'audit') {
      this.#assertAuditWorkspace(workspace);
    }

    const jobId = `job-${randomBytes(8).toString('hex')}`;
    const paths = jobPaths(this.#config.stateDir, jobId);
    const now = new Date().toISOString();
    const { taskArg, promptKind } = this.#buildTaskArg(paths.taskAcceptedFile, task.text, task.sha256, task.bytes);
    const sourceWorkspaceId = workspace.audit?.sourceWorkspaceId ?? null;
    const sourceWorkspace = sourceWorkspaceId === null ? null : this.#config.workspaces.get(sourceWorkspaceId) ?? null;

    /**
     * 受理步骤 3：为真正的新作业建立 starting 档案，记录执行范围和任务摘要。
     */
    const record: JobRecord = {
      jobId,
      requestId,
      requestHash,
      workspaceId: workspace.workspaceId,
      workspaceDir: workspace.dir,
      mode,
      taskFileOriginal: task.canonicalPath,
      taskFileAccepted: paths.taskAcceptedFile,
      taskFileSha256: task.sha256,
      taskFileBytes: task.bytes,
      promptKind,
      taskArgChars: taskArg.length,
      taskArgSha256: sha256Hex(taskArg),
      runnerType: this.#runner.type,
      command: this.#displayCommand(taskArg.length, sha256Hex(taskArg)),
      status: 'starting',
      createdAt: now,
      startedAt: null,
      endedAt: null,
      pid: null,
      childIdentity: null,
      spawnPending: false,
      exitCode: null,
      signal: null,
      timedOut: false,
      cancelRequested: false,
      errorCode: null,
      errorMessage: null,
      truncated: { stdout: false, stderr: false },
      bytes: { stdout: 0, stderr: 0 },
      rawBytes: { stdout: 0, stderr: 0 },
      stdoutLog: paths.stdoutLog,
      stderrLog: paths.stderrLog,
      timeoutSeconds,
      ownerPid: process.pid,
      ownerLockId: this.#ownership?.lockId ?? 'none',
      ownerStartedAt: this.#startedAt,
      recovered: false,
      cleanup: null,
      lateExit: null,
      audit:
        mode === 'audit' && workspace.audit !== null && sourceWorkspace !== null
          ? {
              sourceWorkspaceId: workspace.audit.sourceWorkspaceId,
              sourceDir: sourceWorkspace.dir,
              snapshotDir: workspace.dir,
              reportDir: workspace.audit.reportDir,
              policy: {
                include: [...this.#config.audit.include],
                exclude: [...this.#config.audit.exclude],
                maxFiles: this.#config.audit.maxSnapshotFiles,
                maxBytes: this.#config.audit.maxSnapshotBytes,
                mode: this.#config.audit.include.length > 0 ? 'allowlist' : 'deny-list',
              },
              copiedFiles: 0,
              copiedBytes: 0,
              skippedReparsePoints: 0,
              sourceManifestBefore: null,
              sourceManifestAfter: null,
              snapshotManifestBefore: null,
              snapshotManifestAfter: null,
              sourceStable: null,
              snapshotStable: null,
              sourceDiff: null,
              findings: [],
              reportPath: null,
              snapshotRefresh: 'refresh',
            }
          : null,
    };

    // Persist transactionally: a partial submission must not stay `starting`.
    /**
     * 受理步骤 4：准备内存控制对象和两条输出收集器；此时还没有启动 DSH。
     */
    const active: ActiveJob = {
      jobId,
      stdout: new StreamCapture({ capBytes: this.#config.limits.perStreamCaptureCapBytes, redactor: this.#config.redactor, logFile: paths.stdoutLog }),
      stderr: new StreamCapture({ capBytes: this.#config.limits.perStreamCaptureCapBytes, redactor: this.#config.redactor, logFile: paths.stderrLog }),
      killReason: null,
      timer: null,
      childPid: null,
      child: null,
      kill: null,
      lastKillPromise: null,
      stopRequested: false,
      neverStarted: false,
      exited: false,
      exitCode: null,
      exitSignal: null,
      cleanupPromise: null,
      finalized: false,
    };

    try {
      ensureDir(paths.dir);
      /**
       * 受理步骤 5：先保存已接受任务副本，再保存档案和索引。保存失败时回滚，保证尚未启动付费任务。
       */
      writeFileAtomic(paths.taskAcceptedFile, task.text);
      this.#records.set(jobId, record);
      if (this.#config.faults.failJobWriteOnce && !this.#faultsUsed.has('job')) {
        this.#faultsUsed.add('job');
        throw new Error('injected job-persistence failure (test-only faults.failJobWriteOnce)');
      }
      this.#persist(record, true);
      if (this.#config.faults.failRequestWriteOnce && !this.#faultsUsed.has('request')) {
        this.#faultsUsed.add('request');
        throw new Error('injected request-index write failure (test-only faults.failRequestWriteOnce)');
      }
      this.#store.saveRequest({ requestId, requestHash, jobId, createdAt: now });
    } catch (error) {
      this.#records.delete(jobId);
      this.#pendingWrites.delete(jobId);
      removeIfExists(paths.jobFile);
      try {
        fs.rmSync(paths.dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
      try {
        this.#store.removeRequest(requestId);
      } catch {
        /* best effort */
      }
      this.#log.error('submission rolled back after a persistence failure', {
        jobId,
        message: error instanceof Error ? error.message : String(error),
      });
      throw new BridgeError('STATE_WRITE_FAILED', `could not persist the accepted request; nothing was started: ${error instanceof Error ? error.message : String(error)}`, {
        jobId,
      });
    }

    this.#active = active;
    this.#log.info('job accepted', { jobId, requestId, workspaceId: workspace.workspaceId, mode, timeoutSeconds });

    /**
     * 受理步骤 6：安排稍后的启动，先把回执返回给 Codex。这里到真正启动之间可能收到取消，所以启动入口还会复查。
     */
    setImmediate(() => {
      void this.#startJob(record, active);
    });

    return { accepted: true, jobId, status: record.status, reusedExistingJob: false, view: this.#view(record) };
  }

  /**
   * A credential-free, task-free description of what was launched. The task text
   * itself is never stored in the job record: the frozen accepted copy plus its
   * SHA-256 is the record of what the child received.
   */
  /**
   * 记录不含任务正文的启动概要，用长度和指纹说明传了什么，不把正文塞进通用状态说明。
   */
  #displayCommand(taskChars: number, taskSha256: string): string[] {
    const description = this.#runner.describe();
    return [description.commandTemplate, `<task ${taskChars} chars sha256:${taskSha256.slice(0, 12)}>`];
  }

  /**
   * 确保审计使用单独快照目录，且与实施目录没有父子或同路径重叠。
   */
  #assertAuditWorkspace(workspace: WorkspaceConfig): void {
    if (workspace.audit === null) {
      throw new BridgeError('AUDIT_REQUIRES_SNAPSHOT', 'audit mode requires an audit workspace bound to a snapshot', {
        workspaceId: workspace.workspaceId,
      });
    }
    for (const other of this.#config.workspaces.values()) {
      if (other.workspaceId === workspace.workspaceId) continue;
      if (!other.allowedModes.includes('implement') && !other.allowedModes.includes('fix')) continue;
      const snapshot = workspace.dir;
      const impl = other.dir;
      const overlaps = (from: string, to: string): boolean => {
        const relative = path.relative(from, to);
        return relative === '' || (!path.isAbsolute(relative) && !relative.startsWith('..'));
      };
      if (overlaps(impl, snapshot) || overlaps(snapshot, impl)) {
        throw new BridgeError('AUDIT_REQUIRES_SNAPSHOT', 'audit cwd must not be an implementation directory', {
          auditWorkspaceId: workspace.workspaceId,
          implementationWorkspaceId: other.workspaceId,
        });
      }
    }
  }

  /**
   * 在异步启动前再次检查取消、关闭和使用权；先保存启动意图，再启动子进程并记录 PID。
   */
  async #startJob(record: JobRecord, active: ActiveJob): Promise<void> {
    if (active.finalized) return;
    if (!this.isOwner) {
      // Ownership can be lost between acceptance and start; never spawn then.
      this.#finalize(record, active, {
        status: 'interrupted',
        errorCode: 'OWNERSHIP_LOST',
        errorMessage: `state-directory ownership is not held (${this.#ownershipLost ?? 'not the owner'})`,
      });
      return;
    }
    // A cancel, shutdown or (in principle) timeout may already have been
    // requested between acceptance and this deferred start. Then nothing was
    // spawned: the job is finalized without a process tree, no runner is
    // started and no kill is invented (R1).
    if (active.stopRequested || active.killReason !== null || this.#shuttingDown || record.status === 'stopping') {
      this.#finalizeNeverStarted(record, active);
      return;
    }
    try {
      if (record.mode === 'audit' && record.audit !== null) {
        const limits = this.#snapshotLimits();
        const before = manifestOf(record.audit.sourceDir, limits);
        record.audit.sourceManifestBefore = summarizeManifest(before);
        const snapshot = refreshSnapshot(record.audit.sourceDir, record.audit.snapshotDir, limits);
        record.audit.snapshotManifestBefore = summarizeManifest(snapshot.manifest);
        record.audit.copiedFiles = snapshot.copiedFiles;
        record.audit.copiedBytes = snapshot.copiedBytes;
        record.audit.skippedReparsePoints = snapshot.skippedReparsePoints;
        record.audit.snapshotRefresh = 'refresh';
        record.audit.findings.push(
          `snapshot policy ${snapshot.policy.mode}: ${snapshot.copiedFiles} files copied, ${snapshot.excludedByRule} entries excluded by rule, ${snapshot.skippedReparsePoints} reparse points skipped`,
        );
        this.#auditManifests.set(record.jobId, { source: before, snapshot: snapshot.manifest });
        if (!this.#persist(record)) throw new BridgeError('STATE_WRITE_FAILED', 'audit preparation could not be persisted');
      }

      record.status = 'running';
      record.startedAt = new Date().toISOString();
      /**
       * 启动保护：先把“准备启动”写到磁盘。若桥此刻崩溃，重启后不能误认从未有子进程。
       */
      record.spawnPending = true;
      if (!this.#persist(record)) throw new BridgeError('STATE_WRITE_FAILED', 'spawn intent could not be persisted; no child started');

      const spec = {
        jobId: record.jobId,
        taskArg: this.#taskArgFor(record),
        cwd: record.workspaceDir,
        timeoutMs: record.timeoutSeconds * 1000,
        env: {
          DSH_BRIDGE_JOB_ID: record.jobId,
          DSH_BRIDGE_REQUEST_ID: record.requestId,
          DSH_BRIDGE_MODE: record.mode,
          DSH_BRIDGE_TASK_FILE: record.taskFileAccepted,
          DSH_BRIDGE_WORKSPACE: record.workspaceId,
        },
      };

      /**
       * 执行边界：这一行才调用运行器启动子进程；下面各回调接收输出、错误和真实关闭事件。
       */
      const handle = this.#runner.start(spec, {
        onStdout: (chunk) => {
          active.stdout.push(chunk);
        },
        onStderr: (chunk) => {
          active.stderr.push(chunk);
        },
        onError: (error) => {
          this.#onProcessError(record, active, error);
        },
        onExit: (code, signal) => {
          this.#onProcessExit(record, active, code, signal);
        },
      });

      active.kill = () => handle.kill();
      active.child = handle.child ?? null;
      active.childPid = handle.pid ?? null;
      record.pid = handle.pid ?? null;
      // Record the OS identity of the child we started, but only when automatic
      // orphan cleanup is enabled: it is the evidence a later run must match
      // before it may terminate this pid (FIX-002 F2-02).
      if (this.#config.recovery.killOrphanedChildrenOnStart && handle.pid !== undefined) {
        const probe = probeProcessIdentity(handle.pid);
        if (probe.status === 'ok') {
          const identity: ChildIdentity = {
            pid: handle.pid,
            creationTimeMs: probe.identity.creationTimeMs,
            executablePath: probe.identity.executablePath,
            commandLineDigest: probe.identity.commandLineDigest,
          };
          record.childIdentity = identity;
        } else {
          this.#log.warn('child identity could not be recorded; automatic orphan termination will refuse this job later', {
            jobId: record.jobId,
            pid: handle.pid,
            reason: probe.reason,
          });
          record.childIdentity = null;
        }
      } else if (handle.pid !== undefined) {
        // Record what we can without an OS probe: deliberately marked unverified.
        record.childIdentity = null;
      }
      active.timer = setTimeout(() => {
        void this.#onTimeout(record, active);
      }, spec.timeoutMs);
      if (typeof active.timer.unref === 'function') active.timer.unref();
      record.spawnPending = false;
      if (!this.#persist(record)) {
        record.errorCode = 'STATE_WRITE_FAILED';
        record.errorMessage = 'the child started but its state could not be persisted; stopping the owned child';
        await this.#requestStop(record, active, 'state-write-failure');
      }
    } catch (error) {
      const bridgeError = error instanceof BridgeError ? error : null;
      if (active.kill !== null && !active.exited && !active.finalized) {
        record.errorCode = 'STATE_WRITE_FAILED';
        record.errorMessage = error instanceof Error ? error.message : String(error);
        await this.#requestStop(record, active, 'state-write-failure');
        return;
      }
      active.neverStarted = active.kill === null;
      record.spawnPending = false;
      this.#finalize(record, active, {
        status: 'failed',
        errorCode: bridgeError?.code ?? 'SPAWN_FAILED',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 从已接受的任务副本重新取得正文；指针模式只说明副本位置、哈希和大小。
   */
  #taskArgFor(record: JobRecord): string {
    const text = fs.readFileSync(record.taskFileAccepted, 'utf8');
    if (record.promptKind === 'inline') return text;
    const bytes = Buffer.byteLength(text, 'utf8');
    return (
      `请读取并执行这份已冻结的任务文件（完整内容，未截断）：\n${record.taskFileAccepted}\n` +
      `该副本是本次作业的已接受任务，SHA-256=${record.taskFileSha256}，共 ${bytes} 字节；原始任务文件此后的修改不影响本作业。`
    );
  }

  /**
   * 接收启动/进程错误并结束作业；已经结束的作业只记录迟到事件，避免覆写终态。
   */
  #onProcessError(record: JobRecord, active: ActiveJob, error: Error): void {
    if (isTerminal(record.status)) {
      this.#log.warn('late process error ignored', { jobId: record.jobId, message: error.message });
      return;
    }
    active.exited = true;
    this.#finalize(record, active, {
      status: 'failed',
      errorCode: 'SPAWN_FAILED',
      errorMessage: error.message,
    });
  }

  /**
   * 接收真实关闭事件。退出码 0 对应 completed，非 0 对应失败；停止中的任务按已有取消/超时原因处理。
   */
  #onProcessExit(record: JobRecord, active: ActiveJob, code: number | null, signal: NodeJS.Signals | null): void {
    active.exited = true;
    active.exitCode = code;
    active.exitSignal = signal;
    if (isTerminal(record.status)) {
      record.lateExit = { code, signal, at: new Date().toISOString() };
      this.#persist(record);
      this.#log.warn('late exit event recorded for terminal job', { jobId: record.jobId, code, signal });
      return;
    }
    if (record.status === 'stopping' && record.cleanup !== null) {
      // The stop this bridge asked for has now been observed. If a cleanup
      // attempt is in flight, let it decide with the real KillResult; otherwise
      // decide here, attributing the stop only when the recorded kill succeeded.
      if (active.cleanupPromise !== null) return;
      const attributed = record.cleanup.killed === true && record.cleanup.exited === true;
      this.#confirmStopped(record, active, code, signal, record.cleanup, attributed);
      return;
    }
    if (code === 0) {
      this.#finalize(record, active, { status: 'completed', exitCode: 0, signal, errorCode: null, errorMessage: null });
    } else {
      this.#finalize(record, active, {
        status: 'failed',
        exitCode: code,
        signal,
        errorCode: 'PROCESS_EXIT_NONZERO',
        errorMessage: `child exited with code ${code ?? 'null'}${signal === null ? '' : ` (signal ${signal})`}`,
      });
    }
  }

  /**
   * 超时后转入同一套停止流程，不重新启动或自动付费重试。
   */
  async #onTimeout(record: JobRecord, active: ActiveJob): Promise<void> {
    if (isTerminal(record.status) || record.status === 'stopping') return;
    await this.#requestStop(record, active, 'timeout');
  }

  /**
   * Terminal outcome for a stop that was requested before anything was spawned.
   *
   * Nothing was started, so there is no process tree to terminate: this is
   * recorded as such (`method: 'not-started'`, `killed: false`,
   * `exited: false`) and `confirmed: true` only means "no owned process
   * exists", which is provable without a kill. A kill result is never invented.
   */
  /**
   * 处理受理后、启动前就被取消的情况：没有子进程就无需杀进程，并明确记录未启动的依据。
   */
  #finalizeNeverStarted(record: JobRecord, active: ActiveJob): void {
    if (isTerminal(record.status)) {
      active.neverStarted = true;
      return;
    }
    active.neverStarted = true;
    const reason = record.cleanup?.reason ?? active.killReason ?? 'cancel';
    if (record.cleanup !== null) {
      record.cleanup.method = 'not-started';
      record.cleanup.killed = false;
      record.cleanup.exited = false;
      record.cleanup.detail = 'no child process was started: there was no process tree to terminate';
      record.cleanup.error = null;
      record.cleanup.confirmed = true;
      record.cleanup.confirmedAt = new Date().toISOString();
    }
    if (active.timer !== null) {
      clearTimeout(active.timer);
      active.timer = null;
    }
    if (reason === 'timeout') {
      this.#finalize(record, active, {
        status: 'timed_out',
        timedOut: true,
        exitCode: null,
        signal: null,
        errorCode: 'TIMEOUT',
        errorMessage: `job exceeded timeoutSeconds=${record.timeoutSeconds}`,
      });
      return;
    }
    this.#finalize(record, active, {
      status: 'cancelled',
      exitCode: null,
      signal: null,
      errorCode: null,
      errorMessage: reason === 'shutdown' ? 'bridge shut down' : 'cancelled by request',
    });
  }

  /** Begin cleanup: persist `stopping` synchronously, then stop and verify. */
  /**
   * 先同步标记停止请求并保存 stopping，再等待清理；这样尚未执行的延后启动会看到取消信号。
   */
  async #requestStop(record: JobRecord, active: ActiveJob, reason: 'cancel' | 'timeout' | 'shutdown' | 'state-write-failure'): Promise<boolean> {
    // Record the request before any await: a deferred `#startJob` that has not
    // run yet must see it and decline to spawn (R1).
    /**
     * 停止步骤 1：先立刻标记，再做任何 await。这样延后的启动能及时看到取消，不会一边等待清理一边新开进程。
     */
    active.stopRequested = true;
    if (record.cleanup === null || record.status !== 'stopping') {
      const cleanup: CleanupState = {
        reason,
        requestedAt: new Date().toISOString(),
        attempts: 0,
        lastAttemptAt: null,
        method: null,
        killed: null,
        exited: null,
        detail: null,
        confirmed: false,
        confirmedAt: null,
        error: null,
      };
      record.cleanup = cleanup;
      if (!isTerminal(record.status)) {
        record.status = 'stopping';
        if (reason === 'timeout') {
          record.timedOut = true;
          record.errorCode = 'TIMEOUT';
          record.errorMessage = `job exceeded timeoutSeconds=${record.timeoutSeconds}`;
        }
      }
      active.killReason = reason;
      if (active.timer !== null) {
        clearTimeout(active.timer);
        active.timer = null;
      }
      // Persist before any await so observers cannot see a released slot early.
      this.#persist(record);
    }

    if (active.cleanupPromise !== null) return active.cleanupPromise;
    active.cleanupPromise = this.#attemptCleanup(record, active);
    const confirmed = await active.cleanupPromise;
    active.cleanupPromise = null;
    return confirmed;
  }

  /** Is the owned process observably gone (regardless of who stopped it)? */
  /**
   * 判断本次根进程是否已观察到停止；这个判断不等于所有脱离进程树的后代都已被清理。
   */
  #isStopped(active: ActiveJob, killResult: KillResult | null): boolean {
    if (active.exited) return true;
    if (killResult !== null && killResult.exited === true) return true;
    const child = active.child;
    if (child !== null && child.exitCode !== null && child.exitCode !== undefined) return true;
    if (child !== null && child.signalCode !== null && child.signalCode !== undefined) return true;
    if (active.childPid !== null && isProcessProvenDead(active.childPid)) return true;
    return false;
  }

  /**
   * Provenance of a stop: only our own tree-kill reporting both `killed` and
   * `exited` counts as verified. A root that died for any other reason proves
   * nothing about processes that may have detached from the tree (F2-02).
   */
  /**
   * 确认停止是否有本桥进程树清理的成功归因，避免把自然退出或别的程序终止当作本桥已完成清理。
   */
  #isStopAttributed(killResult: KillResult | null): boolean {
    return killResult !== null && killResult.killed === true && killResult.exited === true;
  }

  /**
   * 发起并有限等待停止操作，记录实际结果。根进程还活着或状态不明时保留占用，不提前给新任务让路。
   */
  async #attemptCleanup(record: JobRecord, active: ActiveJob): Promise<boolean> {
    const cleanup = record.cleanup;
    if (cleanup === null) return false;
    // Nothing was spawned: there is no kill to attempt and no tree to verify.
    if (active.neverStarted) {
      this.#finalizeNeverStarted(record, active);
      return true;
    }
    cleanup.attempts += 1;
    cleanup.lastAttemptAt = new Date().toISOString();
    this.#persist(record);

    let killResult: KillResult | null = null;
    let killError: string | null = null;
    // Read through functions: the values are assigned inside an async closure.
    const currentKill = (): KillResult | null => killResult;
    const currentError = (): string | null => killError;
    const killPromise: Promise<KillResult | null> = (async () => {
      try {
        killResult = (await active.kill?.()) ?? null;
      } catch (error) {
        killError = error instanceof Error ? error.message : String(error);
      }
      return killResult;
    })();
    active.lastKillPromise = killPromise;

    const deadline = Date.now() + this.#config.cleanup.confirmTimeoutMs;
    while (Date.now() < deadline) {
      // The deferred start declined to spawn while this cleanup was waiting:
      // there is no owned process, so stop waiting and do not call a kill.
      if (active.neverStarted) break;
      if (this.#isStopped(active, currentKill())) break;
      if (currentError() !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (active.neverStarted) {
      this.#finalizeNeverStarted(record, active);
      return true;
    }
    // Wait (bounded) for the kill attempt itself to settle so the recorded
    // method/result is the adapter's real outcome rather than a guess.
    await Promise.race([killPromise, new Promise((resolve) => setTimeout(resolve, 1000))]);

    const settled = currentKill();
    const stopped = this.#isStopped(active, settled);
    const attributed = this.#isStopAttributed(settled);
    cleanup.method = settled?.method ?? cleanup.method;
    cleanup.killed = settled?.killed ?? null;
    cleanup.exited = settled?.exited ?? null;
    cleanup.detail = settled?.detail ?? null;
    cleanup.error = currentError();
    /**
     * 停止步骤 2：根进程已经停止与“本桥的停止操作已获证”是两件事，必须分开保存。
     */
    cleanup.confirmed = stopped && attributed;
    cleanup.confirmedAt = cleanup.confirmed ? new Date().toISOString() : null;
    if (stopped && !attributed) {
      cleanup.error =
        'the owned root process stopped, but not through a verified tree kill; processes that detached from the tree are unverified';
      cleanup.detail = `${cleanup.detail ?? ''} (unverified provenance)`.trim();
    }
    if (!stopped && attributed) {
      cleanup.error = 'the kill reported success but the process is still observable';
    }
    this.#persist(record);

    if (stopped) {
      if (attributed) {
        this.#log.info('cleanup confirmed', { jobId: record.jobId, reason: cleanup.reason, attempts: cleanup.attempts });
      } else {
        this.#log.warn('owned root stopped without a verified tree kill; releasing the slot with cleanup.confirmed=false', {
          jobId: record.jobId,
          reason: cleanup.reason,
        });
      }
      this.#confirmStopped(record, active, active.exitCode, active.exitSignal, cleanup, attributed);
      return true;
    }

    this.#log.warn('cleanup could not be confirmed; the execution slot stays occupied', {
      jobId: record.jobId,
      reason: cleanup.reason,
      attempts: cleanup.attempts,
      error: cleanup.error,
    });
    if (cleanup.reason === 'shutdown') {
      // The bridge is exiting: never report an unverified stop as a clean cancel.
      this.#finalize(record, active, {
        status: 'interrupted',
        errorCode: 'CLEANUP_UNCONFIRMED',
        errorMessage: 'bridge shut down without confirming that the owned process tree stopped',
      });
    }
    return false;
  }

  /**
   * 根进程停止后按原因设置取消、超时或保存失败终态；清理是否获证另记在 cleanup 中。
   */
  #confirmStopped(
    record: JobRecord,
    active: ActiveJob,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    cleanup: CleanupState | null,
    attributed: boolean,
  ): void {
    if (isTerminal(record.status)) return;
    if (record.cleanup !== null) {
      record.cleanup.confirmed = attributed;
      record.cleanup.confirmedAt = attributed ? new Date().toISOString() : null;
      if (!attributed) {
        record.cleanup.error =
          record.cleanup.error ??
          'the owned root process stopped, but not through a verified tree kill; processes that detached from the tree are unverified';
      }
      this.#persist(record);
      // A tree kill that was still running when the confirmation window closed
      // can still prove provenance a moment later; record that evidence instead
      // of leaving a verified stop marked unverified.
      if (!attributed && active.lastKillPromise !== null) {
        const pendingKill = active.lastKillPromise;
        void pendingKill.then((late) => {
          if (late === null || late.killed !== true || late.exited !== true) return;
          if (record.cleanup === null || record.cleanup.confirmed) return;
          record.cleanup.confirmed = true;
          record.cleanup.confirmedAt = new Date().toISOString();
          record.cleanup.method = late.method;
          record.cleanup.killed = late.killed;
          record.cleanup.exited = late.exited;
          record.cleanup.detail = `${late.detail ?? ''} (provenance confirmed after the confirmation window)`.trim();
          record.cleanup.error = null;
          this.#persist(record);
          this.#log.info('late kill attribution recorded', { jobId: record.jobId, method: late.method });
        });
      }
    }
    const reason = cleanup?.reason ?? active.killReason ?? 'cancel';
    if (reason === 'state-write-failure') {
      this.#finalize(record, active, { status: 'failed', exitCode, signal, errorCode: 'STATE_WRITE_FAILED', errorMessage: 'job stopped after a state-write failure; inspect persistence diagnostics' });
      return;
    }
    if (reason === 'timeout') {
      this.#finalize(record, active, {
        status: 'timed_out',
        timedOut: true,
        exitCode,
        signal,
        errorCode: 'TIMEOUT',
        errorMessage: `job exceeded timeoutSeconds=${record.timeoutSeconds}`,
      });
      return;
    }
    this.#finalize(record, active, {
      status: 'cancelled',
      exitCode,
      signal,
      errorCode: null,
      errorMessage: reason === 'shutdown' ? 'bridge shut down' : 'cancelled by request',
    });
  }

  /** Single-shot terminal transition; later events are recorded, never applied. */
  /**
   * 只应用一次结束结论，收尾输出、保存计数，审计任务再检查文件变化，最后释放内存中的活动位置。
   */
  #finalize(record: JobRecord, active: ActiveJob, patch: Partial<JobRecord> & { status: JobStatus }): void {
    if (isTerminal(record.status)) return;
    active.finalized = true;
    if (active.timer !== null) {
      clearTimeout(active.timer);
      active.timer = null;
    }
    active.stdout.end();
    active.stderr.end();

    Object.assign(record, patch);
    if (active.exited || active.neverStarted || record.cleanup?.confirmed) record.spawnPending = false;
    record.endedAt = new Date().toISOString();
    record.bytes = { stdout: active.stdout.storedBytes, stderr: active.stderr.storedBytes };
    record.rawBytes = { stdout: active.stdout.rawBytes, stderr: active.stderr.rawBytes };
    record.truncated = { stdout: active.stdout.truncated, stderr: active.stderr.truncated };

    // Audit evidence is finalised here — only after the owned process stopped —
    // so writes that landed during cleanup are covered by the comparison.
    if (record.mode === 'audit' && record.audit !== null) {
      this.#finishAudit(record, active);
    }

    this.#persist(record);
    if (this.#active?.jobId === record.jobId) this.#active = null;
    this.#log.info('job finished', {
      jobId: record.jobId,
      status: record.status,
      exitCode: record.exitCode,
      errorCode: record.errorCode,
    });
  }

  /**
   * Return a copy with only display diagnostics redacted. Identities, error
   * codes, states, paths, hashes and audit policy/manifest fields stay exact.
   * The same projection guards persistence and views, including older records.
   */
  /**
   * 只遮盖供人阅读的诊断文字，保留状态、编号、路径和哈希等机器字段，防止脱敏破坏档案本身。
   */
  #redactedRecord(record: JobRecord): JobRecord {
    const redactor = this.#config.redactor;
    const text = (value: string | null): string | null => value === null ? null : redactor.redact(value);
    return {
      ...record,
      errorMessage: text(record.errorMessage),
      command: record.command.map((value) => redactor.redact(value)),
      cleanup: record.cleanup === null ? null : {
        ...record.cleanup,
        detail: text(record.cleanup.detail),
        error: text(record.cleanup.error),
      },
      audit: record.audit === null ? null : {
        ...record.audit,
        findings: record.audit.findings.map((value) => redactor.redact(value)),
      },
    };
  }

  /**
   * 结束后重新计算源代码和快照指纹。检测到变化或未受清单覆盖的输入就记录审计失败，并生成审计报告。
   */
  #finishAudit(record: JobRecord, active: ActiveJob): void {
    const audit = record.audit;
    if (audit === null) return;
    const limits = this.#snapshotLimits();
    try {
      const sourceAfter = manifestOf(audit.sourceDir, limits);
      const snapshotAfter = manifestOf(audit.snapshotDir, limits);
      audit.sourceManifestAfter = summarizeManifest(sourceAfter);
      audit.snapshotManifestAfter = summarizeManifest(snapshotAfter);
      audit.postRunReparsePoints = snapshotAfter.skippedReparsePoints;

      const inMemory = this.#auditManifests.get(record.jobId) ?? null;
      const sourceDiff = inMemory === null ? null : diffManifests(inMemory.source, sourceAfter);
      const snapshotDiff = inMemory === null ? null : diffManifests(inMemory.snapshot, snapshotAfter);
      audit.sourceDiff = sourceDiff === null ? null : { changed: sourceDiff.changed, added: sourceDiff.added, removed: sourceDiff.removed };
      audit.sourceStable = sourceDiff === null ? null : sourceDiff.same;
      audit.snapshotStable = snapshotDiff === null ? null : snapshotDiff.same;

      const findings: string[] = [];
      if (sourceDiff === null || snapshotDiff === null) {
        findings.push('before-manifests unavailable in this process (bridge restarted); stability reported as unknown');
      }
      if (sourceDiff !== null && !sourceDiff.same) {
        findings.push(
          `audited source changed during the audit run (changed=${sourceDiff.changed.length}, added=${sourceDiff.added.length}, removed=${sourceDiff.removed.length})`,
        );
        record.status = 'failed';
        record.errorCode = 'AUDIT_SOURCE_MODIFIED';
        record.errorMessage = 'audited source changed while the audit ran; the audit cannot be reported as clean';
      }
      if (snapshotDiff !== null && !snapshotDiff.same) {
        findings.push(
          `audit snapshot changed during the audit run (changed=${snapshotDiff.changed.length}, added=${snapshotDiff.added.length}, removed=${snapshotDiff.removed.length})`,
        );
        if (record.errorCode === null) {
          record.status = 'failed';
          record.errorCode = 'AUDIT_SNAPSHOT_MODIFIED';
          record.errorMessage = 'the audit snapshot was modified; the audit was not read-only';
        }
      }

      // Any file inside the snapshot that the policy did not select would be
      // visible to the auditor without being covered by change detection.
      const undetected = this.#findUndetectedInputs(audit.snapshotDir, snapshotAfter);
      if (undetected.length > 0) {
        findings.push(`snapshot contains ${undetected.length} file(s) outside the audited manifest: ${undetected.slice(0, 10).join(', ')}`);
        record.status = 'failed';
        record.errorCode = record.errorCode ?? 'AUDIT_UNDETECTED_INPUT';
        record.errorMessage = record.errorMessage ?? 'the snapshot contains inputs that change detection does not cover';
      }
      if (findings.length === 0) findings.push('source and snapshot manifests unchanged across the audit run');
      audit.findings = findings;

      ensureDir(audit.reportDir);
      const reportFile = path.join(audit.reportDir, `${record.jobId}.audit.json`);
      // The audit envelope also contains machine identities and manifests.
      // Only findings are diagnostic text; preserve all structural fields.
      writeJsonAtomic(
        reportFile,
        {
          jobId: record.jobId,
          requestId: record.requestId,
          mode: record.mode,
          workspaceId: record.workspaceId,
          createdAt: record.createdAt,
          endedAt: record.endedAt,
          status: record.status,
          sourceDir: audit.sourceDir,
          snapshotDir: audit.snapshotDir,
          policy: audit.policy,
          copiedFiles: audit.copiedFiles,
          copiedBytes: audit.copiedBytes,
          copyTimeSkippedReparsePoints: audit.skippedReparsePoints,
          postRunReparsePoints: snapshotAfter.skippedReparsePoints,
          excludedByRuleReportedInFindings: true,
          sourceManifestBefore: audit.sourceManifestBefore,
          sourceManifestAfter: audit.sourceManifestAfter,
          snapshotManifestBefore: audit.snapshotManifestBefore,
          snapshotManifestAfter: audit.snapshotManifestAfter,
          sourceDiff: audit.sourceDiff,
          findings: audit.findings.map((value) => this.#config.redactor.redact(value)),
          undetectedInputs: undetected.slice(0, 50),
          exitCode: record.exitCode,
          output: {
            stdoutLog: record.stdoutLog,
            stderrLog: record.stderrLog,
            truncated: record.truncated,
          },
          isolationBoundary:
            'Directory checks and one-shot snapshots are scheduling and change-detection measures, not an OS sandbox. The audit child runs under the same OS user as the bridge.',
        },
      );
      audit.reportPath = reportFile;
      writeFileAtomic(path.join(audit.reportDir, `${record.jobId}.audit-final.md`), active.stdout.text() + '\n');
    } catch (error) {
      audit.snapshotRefresh = 'failed';
      audit.findings.push(`audit verification failed: ${error instanceof Error ? error.message : String(error)}`);
      record.status = 'failed';
      record.errorCode = record.errorCode ?? 'SNAPSHOT_FAILED';
      record.errorMessage = error instanceof Error ? error.message : String(error);
    }
  }

  /** Files present in the snapshot that the audited manifest does not contain. */
  /**
   * 寻找快照中可见、但指纹清单没有覆盖的文件，防止审计输入和变化检测范围不一致。
   */
  #findUndetectedInputs(snapshotDir: string, manifest: Manifest): string[] {
    const known = new Set(manifest.files.map((file) => file.path));
    const undetected: string[] = [];
    const walk = (dir: string, relDir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
        const abs = path.join(dir, entry.name);
        let stats: fs.Stats;
        try {
          stats = fs.lstatSync(abs);
        } catch {
          continue;
        }
        if (stats.isSymbolicLink()) { undetected.push(rel); continue; }
        if (stats.isDirectory()) {
          walk(abs, rel);
          continue;
        }
        if (!stats.isFile()) continue;
        if (!known.has(rel)) undetected.push(rel);
      }
    };
    walk(snapshotDir, '');
    return undetected.sort();
  }

  /**
   * 把任务档案整理成查询用视图，并附上持久化、停止及审计信息。
   */
  #view(record: JobRecord): JobView {
    record = this.#redactedRecord(record);
    const startedMs = record.startedAt === null ? null : Date.parse(record.startedAt);
    const endedMs = record.endedAt === null ? null : Date.parse(record.endedAt);
    // R4: a running job reports its *live* capture counters and truncation
    // flags; only after finalization do the persisted values apply. A live job
    // never reports `truncated: false` while its capture is already discarding
    // bytes.
    const active = this.#active?.jobId === record.jobId ? this.#active : null;
    const output: JobView['output'] =
      active === null
        ? {
            stdoutStoredBytes: record.bytes.stdout,
            stderrStoredBytes: record.bytes.stderr,
            stdoutRawBytes: record.rawBytes.stdout,
            stderrRawBytes: record.rawBytes.stderr,
            truncated: record.truncated,
            stdoutLog: record.stdoutLog,
            stderrLog: record.stderrLog,
            live: false,
          }
        : {
            stdoutStoredBytes: active.stdout.storedBytes,
            stderrStoredBytes: active.stderr.storedBytes,
            stdoutRawBytes: active.stdout.rawBytes,
            stderrRawBytes: active.stderr.rawBytes,
            truncated: { stdout: active.stdout.truncated, stderr: active.stderr.truncated },
            stdoutLog: record.stdoutLog,
            stderrLog: record.stderrLog,
            live: true,
          };
    return {
      ok: true,
      jobId: record.jobId,
      status: record.status,
      terminal: isTerminal(record.status),
      mode: record.mode,
      workspaceId: record.workspaceId,
      workspaceDir: record.workspaceDir,
      createdAt: record.createdAt,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      durationMs: startedMs === null ? null : (endedMs ?? Date.now()) - startedMs,
      exitCode: record.exitCode,
      signal: record.signal,
      timedOut: record.timedOut,
      cancelled: record.status === 'cancelled',
      recovered: record.recovered,
      error: record.errorCode === null ? null : { code: record.errorCode, message: record.errorMessage ?? '' },
      pid: record.pid,
      timeoutSeconds: record.timeoutSeconds,
      runner: { type: record.runnerType, command: record.command },
      task: {
        file: record.taskFileOriginal,
        acceptedCopy: record.taskFileAccepted,
        sha256: record.taskFileSha256,
        bytes: record.taskFileBytes,
        promptKind: record.promptKind,
        taskArgChars: record.taskArgChars,
        taskArgSha256: record.taskArgSha256,
      },
      output,
      cleanup: record.cleanup,
      audit: record.audit,
      lateExit: record.lateExit,
      persistence: {
        durable: !this.#pendingWrites.has(record.jobId),
        error: this.#pendingWrites.has(record.jobId) ? { code: 'STATE_WRITE_FAILED', message: this.#pendingWrites.get(record.jobId)! } : null,
      },
    };
  }

  /**
   * 只读查询作业状态；查询完成状态不启动新任务，也不自动宣布业务验收通过。
   */
  status(jobId: unknown): JobView {
    const id = assertValidJobId(jobId);
    const record = this.#load(id);
    if (record === null) throw new BridgeError('JOB_NOT_FOUND', `unknown jobId: ${id}`, { jobId: id });
    return this.#view(record);
  }

  /**
   * Read one persisted output log and verify it against the recorded stored byte
   * count (R3, corrected by R1-05).
   *
   * The storage format is exact: the retained bytes come first, and a truncated
   * stream appends exactly one standalone truncation note after them. Therefore
   *  - a stream whose recorded byte count is 0 and whose log was never written is
   *    normal empty output, not an error;
   *  - a missing or unreadable log is `OUTPUT_LOG_UNREADABLE`;
   *  - a truncated log is verified by {@link locateTruncationNote}: the extra
   *    bytes must be exactly one well-formed note, and removing it must yield
   *    exactly the recorded byte count. A log that is shorter than the recorded
   *    bytes, whose extra bytes are not one note (bytes removed from the retained
   *    output hidden behind marker bytes, a garbled/duplicated note, trailing
   *    bytes), or that holds several byte-identical notes, is
   *    `OUTPUT_LOG_INCOMPLETE`: it never silently succeeds;
   *  - a *non-truncated* terminal record with extra bytes on disk is also
   *    `OUTPUT_LOG_INCOMPLETE`. The only tolerated extra bytes are a record whose
   *    counters were never finalised (`recovered`/non-terminal): that boundary is
   *    served best effort and explicitly reported as `unverified-extra-bytes`
   *    instead of being presented as complete.
   *
   * R1-05 detail: release builds before this fix wrote the note the moment data
   * was discarded, so a legal log could be `retained + note + retained`. That
   * legacy layout is still accepted when the evidence is unambiguous (see
   * {@link locateTruncationNote}); a body line that merely *looks* like a note is
   * never removed from a non-truncated log.
   *
   * The historical `completed` / exit-code semantics of the job record are never
   * rewritten by a damaged log.
   */
  /**
   * 按档案字节数严格核验磁盘日志；缺失、变短或不合法的截断说明都报告证据错误，不静默返回成功。
   */
  #readStoredLog(record: JobRecord, stream: 'stdout' | 'stderr'): { text: string; entry: ResultReadEntry } {
    const file = stream === 'stdout' ? record.stdoutLog : record.stderrLog;
    const expectedBytes = stream === 'stdout' ? record.bytes.stdout : record.bytes.stderr;
    const truncated = record.truncated[stream];
    let data: Buffer;
    try {
      data = fs.readFileSync(file);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? null;
      if (code === 'ENOENT' && expectedBytes === 0 && !truncated) {
        return {
          text: '',
          entry: { stream, expectedBytes, observedBytes: 0, integrity: 'exact', note: 'no output was written for this stream' },
        };
      }
      throw new BridgeError('OUTPUT_LOG_UNREADABLE', `the recorded ${stream} log cannot be read, so the stored output cannot be verified`, {
        jobId: record.jobId,
        stream,
        logFile: file,
        expectedBytes,
        cause: code ?? (error instanceof Error ? error.message : String(error)),
      });
    }

    if (truncated) {
      if (data.length < expectedBytes) {
        throw new BridgeError('OUTPUT_LOG_INCOMPLETE', `the recorded ${stream} log holds fewer bytes than the stored output; the stored output is incomplete`, {
          jobId: record.jobId,
          stream,
          logFile: file,
          expectedBytes,
          observedBytes: data.length,
          truncated: true,
        });
      }
      const note = locateTruncationNote(data, expectedBytes, this.#config.limits.perStreamCaptureCapBytes);
      if (note !== null) {
        const retained = Buffer.concat([data.subarray(0, note.start), data.subarray(note.start + note.bytes)]);
        return {
          text: retained.toString('utf8'),
          entry: {
            stream,
            expectedBytes,
            observedBytes: data.length,
            integrity: 'truncation-marker-verified',
            note: note.trailing
              ? 'the retained bytes are followed by exactly one truncation note at the recorded offset'
              : 'pre-R1-05 log: exactly one truncation note sits inside the retained bytes and removing it yields exactly the recorded byte count',
          },
        };
      }
      throw new BridgeError('OUTPUT_LOG_INCOMPLETE', `the recorded ${stream} log does not match the stored output: the extra bytes are not exactly one well-formed truncation note`, {
        jobId: record.jobId,
        stream,
        logFile: file,
        expectedBytes,
        observedBytes: data.length,
        truncated: true,
      });
    }

    if (data.length < expectedBytes) {
      throw new BridgeError('OUTPUT_LOG_INCOMPLETE', `the recorded ${stream} log holds fewer bytes than the stored output; the stored output is incomplete`, {
        jobId: record.jobId,
        stream,
        logFile: file,
        expectedBytes,
        observedBytes: data.length,
      });
    }
    if (data.length > expectedBytes) {
      const unfinalised = record.recovered === true || !isTerminal(record.status);
      if (!unfinalised) {
        throw new BridgeError('OUTPUT_LOG_INCOMPLETE', `the recorded ${stream} log holds more bytes than the stored output; the stored output cannot be proven complete`, {
          jobId: record.jobId,
          stream,
          logFile: file,
          expectedBytes,
          observedBytes: data.length,
        });
      }
      return {
        text: data.toString('utf8'),
        entry: {
          stream,
          expectedBytes,
          observedBytes: data.length,
          integrity: 'unverified-extra-bytes',
          note: 'this record was recovered without finalised counters; the log is served best effort and is not proven complete',
        },
      };
    }
    return {
      text: data.toString('utf8'),
      entry: { stream, expectedBytes, observedBytes: data.length, integrity: 'exact', note: 'the log length matches the stored byte count' },
    };
  }

  /**
   * 运行中读取实时已脱敏输出，结束后读取磁盘日志；只读取请求的输出流，另一流损坏不会影响单流查询。
   */
  #outputText(record: JobRecord, stream: 'combined' | 'stdout' | 'stderr'): { text: string; truncated: { stdout: boolean; stderr: boolean }; read: ResultReadReport } {
    const active = this.#active?.jobId === record.jobId ? this.#active : null;
    if (active !== null) {
      const truncated = { stdout: active.stdout.truncated, stderr: active.stderr.truncated };
      const live: ResultReadReport = { source: 'live-capture', entries: [] };
      if (stream === 'stdout') return { text: active.stdout.text(), truncated, read: live };
      if (stream === 'stderr') return { text: active.stderr.text(), truncated, read: live };
      return { text: combinedText(active.stdout.text(), active.stderr.text()), truncated, read: live };
    }
    // Only the requested stream is read: a damaged unrelated log must not make a
    // healthy single-stream read fail.
    const truncated = record.truncated;
    if (stream === 'stdout') {
      const stdout = this.#readStoredLog(record, 'stdout');
      return { text: stdout.text, truncated, read: { source: 'stored-log', entries: [stdout.entry] } };
    }
    if (stream === 'stderr') {
      const stderr = this.#readStoredLog(record, 'stderr');
      return { text: stderr.text, truncated, read: { source: 'stored-log', entries: [stderr.entry] } };
    }
    const stdout = this.#readStoredLog(record, 'stdout');
    const stderr = this.#readStoredLog(record, 'stderr');
    return {
      text: combinedText(stdout.text, stderr.text),
      truncated,
      read: { source: 'stored-log', entries: [stdout.entry, stderr.entry] },
    };
  }

  /**
   * 校验流名称和分页参数，取得输出并切出一页；页码偏移按码点，不按 UTF-16 长度。
   */
  result(jobId: unknown, options: { stream?: unknown; offset?: unknown; limit?: unknown } = {}): ResultView {
    const id = assertValidJobId(jobId);
    const record = this.#load(id);
    if (record === null) throw new BridgeError('JOB_NOT_FOUND', `unknown jobId: ${id}`, { jobId: id });

    const streamRaw = options.stream ?? 'combined';
    if (streamRaw !== 'combined' && streamRaw !== 'stdout' && streamRaw !== 'stderr') {
      throw new BridgeError('INVALID_ARGUMENT', 'stream must be combined, stdout or stderr', { stream: streamRaw });
    }
    const offsetRaw = options.offset ?? 0;
    if (typeof offsetRaw !== 'number' || !Number.isInteger(offsetRaw) || offsetRaw < 0) {
      throw new BridgeError('INVALID_ARGUMENT', 'offset must be a non-negative integer', { offset: offsetRaw });
    }
    const limitRaw = options.limit;
    if (limitRaw !== undefined && (typeof limitRaw !== 'number' || !Number.isInteger(limitRaw) || limitRaw <= 0)) {
      throw new BridgeError('INVALID_ARGUMENT', 'limit must be a positive integer', { limit: limitRaw });
    }

    const maxPageBytes = this.#config.limits.resultPageMaxBytes;
    const { text, truncated, read } = this.#outputText(record, streamRaw);
    /**
     * 读取步骤：输出正文放进 page.output；nextOffset 是下一页起点，totalChars 是整条输出的码点总数。
     */
    const page = paginate(
      text,
      { stream: streamRaw, offset: offsetRaw, limit: typeof limitRaw === 'number' ? limitRaw : Math.max(1, maxPageBytes) },
      maxPageBytes,
      truncated,
    );
    return { ...this.#view(record), page, read };
  }

  /**
   * 取消指定作业。已结束时返回原状态；活动作业只停止本实例的句柄，未证实的清理结果明确保留。
   */
  async cancel(jobId: unknown): Promise<JobView & { alreadyTerminal: boolean; kill: { method: string; detail: string | null } | null }> {
    if (!this.isOwner) throw new BridgeError('STATE_DIR_BUSY', 'this instance cannot cancel jobs owned by another bridge');
    this.#flushPendingWrites();
    const id = assertValidJobId(jobId);
    const record = this.#load(id);
    if (record === null) throw new BridgeError('JOB_NOT_FOUND', `unknown jobId: ${id}`, { jobId: id });
    if (isTerminal(record.status)) {
      return { ...this.#view(record), alreadyTerminal: true, kill: null };
    }

    const active = this.#active?.jobId === id ? this.#active : null;
    record.cancelRequested = true;
    this.#persist(record);
    if (active === null) {
      this.#finalizeDetached(record);
      return { ...this.#view(record), alreadyTerminal: false, kill: null };
    }

    // Retry path: a previous attempt that could not be confirmed is retried here.
    const confirmed = await this.#requestStop(record, active, 'cancel');
    const cleanup = record.cleanup;
    return {
      ...this.#view(record),
      alreadyTerminal: false,
      kill: cleanup === null ? null : { method: cleanup.confirmed ? cleanup.method ?? 'unknown' : 'unconfirmed', detail: cleanup.error ?? cleanup.detail },
    };
  }

  /**
   * 对本实例没有活动句柄的记录处理取消状态；这不声称已执行或证明了系统进程树清理。
   */
  #finalizeDetached(record: JobRecord): void {
    if (isTerminal(record.status)) return;
    record.status = 'cancelled';
    record.errorCode = null;
    record.errorMessage = 'cancelled by request (no live process handle)';
    record.endedAt = new Date().toISOString();
    this.#persist(record);
  }

  /**
   * 桥关闭时禁止新受理，停止自己的活动作业并释放使用权；不影响别的 DSH 工作。
   */
  async shutdown(): Promise<void> {
    this.#shuttingDown = true;
    const active = this.#active;
    if (active !== null) {
      const record = this.#records.get(active.jobId);
      if (record !== undefined) {
        this.#log.info('shutdown: stopping owned job', { jobId: active.jobId, pid: active.childPid });
        await this.#requestStop(record, active, 'shutdown');
      }
    } else {
      this.#log.info('shutdown: no active job to clean up');
    }
    this.#flushPendingWrites();
    if (this.#ownership?.owned) this.#ownership.release();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  /** Release ownership without stopping; used by tests and read-only instances. */
  /**
   * 仅释放状态目录使用权，供既有测试或只读实例使用；不是替代 shutdown 的日常关闭入口。
   */
  releaseOwnership(): void {
    this.#ownership?.release();
  }

  /**
   * 汇总当前配置、运行器可用性、目录使用权、作业和证据问题；不提交任务，也不输出凭据内容。
   */
  health(): Record<string, unknown> {
    const description = this.#runner.describe();
    const activeRecord = this.#active === null ? null : this.#records.get(this.#active.jobId) ?? null;
    const recent = [...this.#records.values()]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, 5)
      .map((record) => ({ jobId: record.jobId, status: record.status, mode: record.mode, workspaceId: record.workspaceId, createdAt: record.createdAt }));
    const ownership = this.#ownership?.view() ?? null;
    return {
      ok: true,
      bridge: {
        name: this.#config.serverName,
        version: this.#config.serverVersion,
        pid: process.pid,
        startedAt: this.#startedAt,
        configPath: this.#config.configPath,
        stateDir: this.#config.stateDir,
        logLevel: this.#config.logLevel,
      },
      ownership: {
        owned: this.isOwner,
        mode: this.#ownershipLost === null ? (ownership?.mode ?? 'unknown') : 'lost',
        lockId: ownership?.lockId ?? null,
        lostReason: this.#ownershipLost,
        diagnostic: ownership?.diagnostic ?? null,
        existingOwner: ownership?.existingOwner ?? null,
        heartbeatStaleMs: this.#config.ownership.staleHeartbeatMs,
        policy:
          'ownership is re-checked live: a handle that no longer holds the lock reports owned=false, revokes persistence and stops its own job; a state directory has exactly one effective owner',
      },
      orphanBlock:
        this.#orphanBlock === null
          ? null
          : { jobIds: this.#orphanBlock.jobIds, pids: this.#orphanBlock.pids, guidance: this.#orphanBlock.guidance, resolving: this.#orphanResolution !== null },
      recoveryIdentityPolicy: {
        recordedAtSpawn: 'only when recovery.killOrphanedChildrenOnStart is enabled',
        proofRequired: 'exact creation time + executable path + command-line digest of the recorded child',
        onUnverified: 'never terminate; keep ORPHAN_UNRESOLVED and block new work with manual diagnostics',
      },
      cleanupProofScope:
        'cleanup.confirmed=true means either (a) no child process was ever started (cleanup.method=not-started: nothing needed terminating) or (b) this bridge observed its owned root process stop and attributed that stop to its own tree-kill reporting killed+exited. It does NOT prove that processes which detached from the tree are gone; when attribution is missing, confirmed is false (see cleanup.error).',
      integrity: {
        unreadableJobs: this.#unreadableJobs,
        enumerationError: this.#enumerationError,
        pendingStateWrites: [...this.#pendingWrites].map(([jobId, message]) => ({ jobId, code: 'STATE_WRITE_FAILED', message })),
        unresolvedSpawnJobIds: [...this.#unresolvedSpawnJobIds],
        policy: 'a job record that cannot be read is reported as an integrity error; it is never treated as absent evidence',
      },
      runner: {
        type: description.type,
        available: description.available,
        diagnostic: description.diagnostic === null ? null : this.#config.redactor.redact(description.diagnostic),
        commandTemplate: this.#config.redactor.redact(description.commandTemplate),
        details: this.#config.redactor.redactValue(description.details),
      },
      workspaces: this.#config.workspaceOrder.map((workspaceId) => {
        const workspace = this.#config.workspaces.get(workspaceId) as WorkspaceConfig;
        return {
          workspaceId,
          dir: workspace.dir,
          allowedModes: workspace.allowedModes,
          exists: fs.existsSync(workspace.dir),
          isAuditSnapshot: workspace.audit !== null,
          sourceWorkspaceId: workspace.audit?.sourceWorkspaceId ?? null,
        };
      }),
      taskFileRoots: this.#config.taskFileRoots,
      snapshotPolicy: {
        mode: this.#config.audit.include.length > 0 ? 'allowlist' : 'deny-list',
        include: [...this.#config.audit.include],
        exclude: [...this.#config.audit.exclude],
        maxSnapshotFiles: this.#config.audit.maxSnapshotFiles,
        maxSnapshotBytes: this.#config.audit.maxSnapshotBytes,
        sharedRule: 'the snapshot copy and the snapshot manifest use the same compiled policy; a copied file is always hashed',
      },
      capabilities: {
        statuses: ['starting', 'running', 'stopping', 'completed', 'failed', 'cancelled', 'timed_out', 'interrupted'],
        modes: [...MODES],
        tools: ['dsh_health', 'dsh_submit', 'dsh_status', 'dsh_result', 'dsh_cancel'],
        mcpTasksExtension: false,
        maxActiveJobs: this.#config.concurrency.maxActiveJobs,
        slotPolicy: 'the slot is released when no child was started or the owned root is observed stopped; verified tree-kill attribution is reported separately in cleanup.confirmed, and unresolved state writes block new jobs',
        timeoutRangeSeconds: [this.#config.limits.minTimeoutSeconds, this.#config.limits.maxTimeoutSeconds],
        defaultTimeoutSeconds: this.#config.limits.defaultTimeoutSeconds,
        perStreamCaptureCapBytes: this.#config.limits.perStreamCaptureCapBytes,
        resultPageMaxBytes: this.#config.limits.resultPageMaxBytes,
        inlineTaskMaxChars: this.#config.limits.inlineTaskMaxChars,
        taskTransports: ['inline-argv', 'pointer-file'],
        redaction: {
          patternRules: [...REDACTION_PATTERN_NAMES],
          configuredLiteralSecrets: this.#config.redactor.literalCount,
          shortLiteralSecrets: this.#config.redactor.shortLiteralCount,
          unresolvedSecretEnvNames: this.#config.redactor.unresolvedSecretEnvNames,
          emptySecretEnvNames: this.#config.redactor.emptySecretEnvNames,
          diskPolicy: 'complete lines are redacted before any disk write; an incomplete trailing line stays buffered',
          configuredValuePolicy:
            'every explicitly configured non-empty literal is redacted at any length; an empty literal is refused at config load; a declared secret environment variable that is unset or empty has no value to redact and is reported by name as a declared boundary, never as a leak; values are never logged',
        },
        unicode: {
          decode: 'incremental UTF-8 (StringDecoder); invalid bytes become U+FFFD',
          pagination: 'Unicode code points; offset/nextOffset count code points',
        },
        cleanup: this.#config.cleanup,
      },
      tokenEconomy: {
        pointerHandoffAboveChars: this.#config.limits.inlineTaskMaxChars,
        resultPageMaxBytes: this.#config.limits.resultPageMaxBytes,
        perStreamCaptureCapBytes: this.#config.limits.perStreamCaptureCapBytes,
        freshSessionPerRound: true,
        sessionResumeAvailable: false,
        guidance: [
          'Pass the plan as a task file and let the bridge hand the child a frozen copy (or a short pointer above the inline threshold) instead of pasting long context into MCP arguments.',
          'Read output page by page: fetch page.totalChars first, then request only the window you need (the tail is usually the outcome).',
          'A fix round should send the audit findings and the changed-file list, not the whole repository: every job starts a fresh DSH session, so re-sent context is paid again.',
          'Audit runs execute against a one-shot snapshot, so neither side has to re-read the implementation tree twice in one round.',
          'Do not enable runner.production.jsonEvents unless structured events are actually needed: NDJSON events are larger than the final-message default.',
          'DSH 0.2.0-rc.2 supports --session-id resume, which would let a fix round continue the previous session; v1 deliberately keeps a fresh session per round (TASK-001 §5) and does not expose the caller-supplied session id.',
        ],
      },
      activeJob: activeRecord === null ? null : { jobId: activeRecord.jobId, status: activeRecord.status, startedAt: activeRecord.startedAt },
      recentJobs: recent,
      limits: this.#config.limits,
      recovery: {
        killOrphanedChildrenOnStart: this.#config.recovery.killOrphanedChildrenOnStart,
        policy:
          'jobs that were active when the bridge exited are marked interrupted on the next start and are never re-run; while a recorded orphan pid may still be alive, new jobs are refused until the operator resolves it or enables verified cleanup',
      },
    };
  }
}

// Re-exported for callers that only need to inspect a persisted job file.
export { readJsonStrict };
