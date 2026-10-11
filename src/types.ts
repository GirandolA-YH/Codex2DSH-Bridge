/**
 * 中文模块导读
 * 数据词典：约定任务状态、日志信息和保存记录有哪些字段。
 * type/interface 描述数据格式，本身不会发车、启动模型或写文件。
 * 看到 JobRecord 可以理解为一张“任务档案”；null 通常表示尚无记录或无法证明，并不等于成功。
 */
/** Shared data contracts persisted to disk and returned over MCP. */

/**
 * 任务模式：implement 是实施，fix 是修复，audit 是独立审计。
 */
export type Mode = 'implement' | 'fix' | 'audit';

export const MODES: readonly Mode[] = ['implement', 'fix', 'audit'];

/**
 * Job lifecycle. `completed` means "the DSH process exited 0" — it never means
 * the work was accepted, correct or audited. Acceptance is Codex's decision and
 * has no representation in this bridge.
 *
 * `stopping` is a non-terminal cleanup state: the terminal outcome is recorded
 * only after the job's own process tree is confirmed stopped (or the bridge
 * explicitly records that it could not confirm it).
 */
/**
 * 运行状态词典：描述进程生命周期，不包含业务验收 PASS。
 */
export type JobStatus =
  /**
   * 请求已受理，子进程可能还未启动。
   */
  | 'starting'
  /**
   * 处于启动/执行阶段；子进程证据另看 pid 和 spawnPending。
   */
  | 'running'
  /**
   * 正在请求停止和收集清理证据，还不能当作已结束。
   */
  | 'stopping'
  /**
   * 子进程退出码为 0；仍未代表业务验收通过。
   */
  | 'completed'
  /**
   * 运行、状态保存或审计检查等环节发生失败。
   */
  | 'failed'
  /**
   * 作业按取消流程结束；实际停止范围看 cleanup。
   */
  | 'cancelled'
  /**
   * 超过配置时限后结束。
   */
  | 'timed_out'
  /**
   * 重启或使用权等原因导致中断，不自动重跑。
   */
  | 'interrupted';

export const TERMINAL_STATUSES: readonly JobStatus[] = [
  'completed',
  'failed',
  'cancelled',
  'timed_out',
  'interrupted',
];

/**
 * 判断状态是否已经结束，用于防止后来的事件重写最终结论。
 */
export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** What the bridge actually did when it tried to stop a job's process tree. */
/**
 * 停止操作的实际证据：尝试次数、系统报告、确认范围和错误分别记录。
 */
export interface CleanupState {
  reason: 'cancel' | 'timeout' | 'shutdown' | 'orphan-recovery' | 'state-write-failure';
  requestedAt: string;
  attempts: number;
  lastAttemptAt: string | null;
  method: string | null;
  /** Result reported by the runner for the last attempt. */
  killed: boolean | null;
  exited: boolean | null;
  detail: string | null;
  /** True only after the bridge verified the owned process is gone. */
  /**
   * 记录是否获得约定范围内的停止证据；不保证已自行脱离进程树的后代也被找回。
   */
  confirmed: boolean;
  confirmedAt: string | null;
  error: string | null;
}

/**
 * 文件清单的摘要，记录内容指纹、文件数、总大小和时间。
 */
export interface ManifestSummary {
  digest: string;
  fileCount: number;
  totalBytes: number;
  capturedAt: string;
}

/**
 * 审计输入、前后清单、变化结果及报告位置的记录。
 */
export interface AuditInfo {
  sourceWorkspaceId: string;
  sourceDir: string;
  snapshotDir: string;
  reportDir: string;
  policy: {
    include: string[];
    exclude: string[];
    maxFiles: number;
    maxBytes: number;
    mode: 'deny-list' | 'allowlist';
  };
  copiedFiles: number;
  copiedBytes: number;
  skippedReparsePoints: number;
  /** Reparse points found at the final check, distinct from copy-time skips. */
  postRunReparsePoints?: number;
  sourceManifestBefore: ManifestSummary | null;
  sourceManifestAfter: ManifestSummary | null;
  snapshotManifestBefore: ManifestSummary | null;
  snapshotManifestAfter: ManifestSummary | null;
  sourceStable: boolean | null;
  snapshotStable: boolean | null;
  sourceDiff: { changed: string[]; added: string[]; removed: string[] } | null;
  findings: string[];
  reportPath: string | null;
  snapshotRefresh: 'refresh' | 'reused' | 'failed';
}

/**
 * Identity fingerprint of the process the bridge started (FIX-002 F2-02).
 *
 * Recorded at spawn time *only* when automatic orphan cleanup is enabled. It is
 * the evidence a later run must match before it may terminate a pid: a live pid
 * alone, a pid written in a file, or a fuzzy process name are not proof.
 */
/**
 * 子进程身份指纹；PID 相同还不够，须结合创建时间、程序路径和命令摘要。
 */
export interface ChildIdentity {
  pid: number;
  creationTimeMs: number;
  executablePath: string;
  commandLineDigest: string;
}

/**
 * 磁盘任务档案的完整格式，便于重启恢复、状态查询和事后核对。
 */
export interface JobRecord {
  /**
   * 本次作业编号，查询状态、结果和取消时使用。
   */
  jobId: string;
  /**
   * 请求防重复编号；同编号同内容会复用原作业。
   */
  requestId: string;
  /**
   * 请求内容指纹，检查同编号是否被换了任务或参数。
   */
  requestHash: string;
  /**
   * 配置中允许的工作区编号。
   */
  workspaceId: string;
  /**
   * 经过配置与路径检查的实际执行目录。
   */
  workspaceDir: string;
  /**
   * 实施、修复或审计模式。
   */
  mode: Mode;
  /**
   * 提交时读取的原任务文件路径。
   */
  taskFileOriginal: string;
  /**
   * 受理时保存的任务副本；后续原文件修改不影响本次任务。
   */
  taskFileAccepted: string;
  /**
   * 已接受任务内容指纹，便于核对到底执行了哪份文字。
   */
  taskFileSha256: string;
  /**
   * 已接受任务的 UTF-8 字节数。
   */
  taskFileBytes: number;
  /**
   * inline 表示直接传全文；pointer 表示传冻结文件位置。
   */
  promptKind: 'inline' | 'pointer';
  taskArgChars: number;
  taskArgSha256: string;
  /**
   * production 使用真实 DSH，fake 使用本地夹具。
   */
  runnerType: 'production' | 'fake';
  /**
   * 供查看的启动概要，任务正文不会完整塞进此字段。
   */
  command: string[];
  /**
   * 进程生命周期状态；completed 仍需另外验收业务。
   */
  status: JobStatus;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  /**
   * 启动后拿到的子进程编号；null 表示没有可记录的编号。
   */
  pid: number | null;
  /** Present only when the identity probe succeeded at spawn time. */
  /**
   * 自动孤儿清理开启且查询成功时记录的身份依据。
   */
  childIdentity: ChildIdentity | null;
  /** Durable spawn intent; true means restart cannot rule out an unrecorded child. */
  /**
   * 已保存启动意图但尚未可靠登记 PID；重启时据此防止忽略可能已启动的子进程。
   */
  spawnPending?: boolean;
  /**
   * 系统进程退出码，不是业务分数。
   */
  exitCode: number | null;
  signal: string | null;
  /**
   * 是否超过本次约定的运行时限。
   */
  timedOut: boolean;
  /**
   * 是否曾请求取消；发出请求不等于停止已经确认。
   */
  cancelRequested: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  /**
   * 分别记录两条输出流是否因容量限制被丢弃。
   */
  truncated: { stdout: boolean; stderr: boolean };
  /**
   * 已保存的脱敏正文大小，单位为 UTF-8 字节。
   */
  bytes: { stdout: number; stderr: number };
  /**
   * 子进程原始输出的字节计数，可能大于保存量。
   */
  rawBytes: { stdout: number; stderr: number };
  /**
   * 标准输出日志路径。
   */
  stdoutLog: string;
  /**
   * 错误/诊断输出日志路径；有 stderr 并不自动代表业务失败。
   */
  stderrLog: string;
  /**
   * 本次作业的运行时限，单位为秒。
   */
  timeoutSeconds: number;
  ownerPid: number;
  /**
   * 本次桥启动的使用权代次编号。
   */
  ownerLockId: string;
  ownerStartedAt: string;
  /**
   * 此记录是否经过重启恢复；恢复不自动重开模型。
   */
  recovered: boolean;
  /**
   * 停止操作的事实记录；null 表示没有相关记录，不应当作清理成功。
   */
  cleanup: CleanupState | null;
  /**
   * 结束后迟到的关闭事件，只补记证据。
   */
  lateExit: { code: number | null; signal: string | null; at: string } | null;
  /**
   * 审计专用输入及变化检查记录；非审计任务为 null。
   */
  audit: AuditInfo | null;
}

/**
 * 防重复请求索引：将调用方 requestId 与已接受的 jobId 绑定。
 */
export interface RequestRecord {
  schema: 'dsh-codex-bridge/request-index/v2';
  requestId: string;
  requestHash: string;
  jobId: string;
  createdAt: string;
}
