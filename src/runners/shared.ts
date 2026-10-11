/**
 * 中文模块导读
 * 启动外部程序的公共步骤：真实运行器和假运行器都使用这里。
 * 用参数数组加 shell:false 传任务，引号、换行、反引号和 $() 都按文字交给子进程，不交给命令解释器执行。
 */
/** Shared spawn plumbing for both runners. */
import { spawn, type ChildProcess } from 'node:child_process';
import { killProcessTree, type KillResult } from '../proctree.js';
import type { RunnerEvents, RunnerHandle } from '../runner.js';

/**
 * 启动外部程序的固定命令、参数数组、目录、环境和事件接收方。
 */
export interface SpawnOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  events: RunnerEvents;
  /**
   * When set, the task text is written to the child's stdin (0.2.0-rc.2 `-`
   * transport). Otherwise stdin is closed immediately: the headless app never
   * reads it in argv mode.
   */
  stdinText?: string | null;
}

/**
 * Spawn with an argv array and `shell: false`. The task text is therefore a
 * single data argument: quotes, newlines, backticks and `$()` are never
 * interpreted by a shell.
 */
/**
 * 用固定程序和参数数组启动子进程，连接 stdout/stderr 回调及结束事件；shell:false 让任务始终是数据。
 */
export function spawnRunnerProcess(options: SpawnOptions): ChildProcess {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    /**
     * 任务文字按参数传递，避免引号或 $() 被命令解释器当作命令。
     */
    shell: false,
    windowsHide: true,
    // POSIX: give the child its own process group so the whole tree can be
    // signalled. Windows uses taskkill /T instead.
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // The headless app reads stdin only in the `-` transport; otherwise closing it
  // immediately avoids any accidental wait.
  try {
    if (typeof options.stdinText === 'string') {
      child.stdin?.end(options.stdinText, 'utf8');
    } else {
      child.stdin?.end();
    }
  } catch {
    /* ignore */
  }
  child.stdout?.on('data', (chunk: Buffer) => options.events.onStdout(chunk));
  child.stderr?.on('data', (chunk: Buffer) => options.events.onStderr(chunk));
  child.on('error', (error: Error) => options.events.onError(error));
  child.on('close', (code: number | null, signal: NodeJS.Signals | null) => options.events.onExit(code, signal));
  return child;
}

/**
 * 把子进程整理成统一句柄，提供 PID、启动信息和停止本次进程的操作。
 */
export function makeHandle(child: ChildProcess, command: string[], killTimeoutMs = 5000): RunnerHandle {
  return {
    pid: child.pid,
    command,
    child,
    async kill(): Promise<KillResult | null> {
      return killProcessTree(child, killTimeoutMs);
    },
  };
}

/**
 * 按既定优先级合并父进程环境、配置环境和固定环境设置，不由工具调用者任意控制。
 */
export function envFor(
  base: NodeJS.ProcessEnv,
  extra: Record<string, string>,
  fixed: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return { ...base, ...extra, ...fixed };
}
