/**
 * 中文模块导读
 * 运行器接口：规定“负责启动外部程序的组件”必须提供哪些操作。
 * JobManager 只依赖这个统一接口，真实 DSH 与测试用假运行器因此能使用同一套调度流程。
 */
/** Runner contract shared by the production (DSH) and fake (test) runners. */
import type { ChildProcess } from 'node:child_process';
import type { KillResult } from './proctree.js';

/**
 * 一次启动所需的任务文字、工作目录、时限与固定环境信息。
 */
export interface RunnerSpec {
  jobId: string;
  /** The task text handed to the child as a single argv element. */
  taskArg: string;
  cwd: string;
  timeoutMs: number;
  /** Extra environment entries for the child (server-side configuration only). */
  env: Record<string, string>;
}

/**
 * 把输出、错误和结束事件交回任务管理器的回调。
 */
export interface RunnerEvents {
  onStdout(chunk: Buffer): void;
  onStderr(chunk: Buffer): void;
  onExit(code: number | null, signal: NodeJS.Signals | null): void;
  onError(error: Error): void;
}

/**
 * 本次子进程的编号、句柄及停止方法。
 */
export interface RunnerHandle {
  readonly pid: number | undefined;
  readonly command: string[];
  readonly child: ChildProcess | null;
  /**
   * Stop this run's own process tree. The result is the *actual* termination
   * outcome (`killed`/`exited`/`detail`); callers must not treat a resolved
   * promise as proof that the process is gone (FIX-001 R03).
   */
  kill(): Promise<KillResult | null>;
}

/**
 * 只读展示运行器类型、可用性及启动概要。
 */
export interface RunnerDescription {
  type: 'production' | 'fake';
  available: boolean;
  /** Actionable, credential-free diagnostic when `available` is false. */
  diagnostic: string | null;
  /** Command template for humans; never contains a task or a credential. */
  commandTemplate: string;
  details: Record<string, unknown>;
}

/**
 * 真实与假运行器共同遵守的接口：describe 查看，start 执行。
 */
export interface Runner {
  readonly type: 'production' | 'fake';
  describe(): RunnerDescription;
  start(spec: RunnerSpec, events: RunnerEvents): RunnerHandle;
}
