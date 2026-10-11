/**
 * 中文模块导读
 * 进程停止工具：尝试停止桥启动的根进程及其进程树，并报告实际观察结果。
 * 进程查询分 alive / dead / unknown；权限或查询错误不等于进程已经死了。
 * 系统进程树操作不保证找回已自行脱离进程树的程序；不能把停止根进程说成所有后代都已消失。
 */
/**
 * Process-tree termination.
 *
 * The bridge kills only pids it started (`taskkill /T /F` on Windows, the
 * process group on POSIX). It never kills by image name, so unrelated
 * `node.exe`/`dsh` processes owned by the user are untouched. Killing an
 * already-dead pid is a no-op, which keeps `dsh_cancel` idempotent.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 系统停止操作实际报告的方式、执行情况、停止观察和错误。
 */
export interface KillResult {
  method: string;
  killed: boolean;
  exited: boolean;
  detail: string | null;
}

/** PIDs the runtime can actually query: positive, and within the C int range. */
export const MAX_QUERYABLE_PID = 2147483647;

/**
 * 进程生死判断的三个值：alive、dead、unknown。
 */
export type ProcessLiveness = 'alive' | 'dead' | 'unknown';

/**
 * Tri-state liveness (FIX-006 F6-01).
 *
 * Only two outcomes are evidence:
 *   - the query succeeded, or was refused for lack of permission (`EPERM`) => alive
 *   - the query said the process does not exist (`ESRCH`)                 => dead
 *
 * Every other outcome — invalid or out-of-range pid, `EIO`/`EINVAL`/`ENOSYS`,
 * an unexpected or missing error code — is `unknown`: the holder's state is not
 * proven either way. Callers that make destructive or confirmation decisions
 * must treat `unknown` as "not proven stopped".
 */
/**
 * 区分仍在运行、已证明死亡、无法判断。查询返回 ESRCH 才认定 dead；权限错误 EPERM 表示仍存在，其余错误保留 unknown。
 */
export function queryProcessLiveness(pid: number): ProcessLiveness {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || pid > MAX_QUERYABLE_PID) return 'unknown';
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'dead';
    if (code === 'EPERM') return 'alive';
    return 'unknown';
  }
}

/** True only when the process is proven to exist (or to exist but be protected). */
/**
 * 兼容用的是否存活查询；涉及回收安全时应使用明确死亡判断，而不是对结果取反。
 */
export function isProcessAlive(pid: number): boolean {
  return queryProcessLiveness(pid) === 'alive';
}

/** True only when the query proved the process does not exist. */
/**
 * 仅在查询明确返回 dead 时成立，未知结果不能通过这一关。
 */
export function isProcessProvenDead(pid: number): boolean {
  return queryProcessLiveness(pid) === 'dead';
}

/**
 * 找到 Windows 系统 taskkill 程序的位置。
 */
function taskkillPath(): string {
  const root = process.env['SystemRoot'] ?? 'C:\\Windows';
  const candidate = path.join(root, 'System32', 'taskkill.exe');
  return fs.existsSync(candidate) ? candidate : 'taskkill';
}

/**
 * 在有限时间内检查根进程是否停止；超过期限后明确返回未证实。
 */
export function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => done(child.exitCode !== null || child.signalCode !== null), timeoutMs);
    child.once('exit', () => done(true));
  });
}

/** Kill a pid's whole tree by pid only (recovery path, no ChildProcess handle). */
/**
 * 尝试按系统方式停止给定根 PID 的进程树，并记录方式、错误和停止观察；已脱离树的进程仍属于未证明范围。
 */
export async function killPidTree(pid: number, timeoutMs = 5000): Promise<KillResult> {
  if (isProcessProvenDead(pid)) {
    return { method: 'none', killed: false, exited: true, detail: 'pid not alive' };
  }
  if (process.platform === 'win32') {
    const detail = await new Promise<string | null>((resolve) => {
      let settled = false;
      const done = (value: string | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => done('taskkill timed out'), timeoutMs);
      let killer: ChildProcess;
      try {
        killer = spawn(taskkillPath(), ['/PID', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        done(error instanceof Error ? error.message : String(error));
        return;
      }
      let output = '';
      killer.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
      });
      killer.stderr?.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
      });
      killer.on('error', (error) => done(error.message));
      killer.on('close', (code) => done(`exit=${code ?? 'null'} ${output.trim()}`.trim()));
    });
    return { method: 'taskkill /PID <pid> /T /F', killed: isProcessProvenDead(pid), exited: isProcessProvenDead(pid), detail };
  }
  let detail: string | null = null;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    detail = (error as NodeJS.ErrnoException).code ?? String(error);
    try {
      process.kill(pid, 'SIGKILL');
    } catch (inner) {
      detail = `${detail}; ${(inner as NodeJS.ErrnoException).code ?? String(inner)}`;
    }
  }
  return { method: 'process-group SIGKILL', killed: isProcessProvenDead(pid), exited: isProcessProvenDead(pid), detail };
}

/**
 * 从本次启动拿到的子进程句柄发起停止；不凭任意进程名称去杀其他工作。
 */
export async function killProcessTree(child: ChildProcess, timeoutMs = 5000): Promise<KillResult> {
  const pid = child.pid;
  if (pid === undefined) {
    return { method: 'none', killed: false, exited: true, detail: 'child has no pid' };
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    return { method: 'none', killed: false, exited: true, detail: 'child already exited' };
  }

  let method: string;
  let detail: string | null = null;

  if (process.platform === 'win32') {
    method = 'taskkill /PID <pid> /T /F';
    detail = await new Promise<string | null>((resolve) => {
      let settled = false;
      const done = (value: string | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => done('taskkill timed out'), timeoutMs);
      let killer: ChildProcess;
      try {
        killer = spawn(taskkillPath(), ['/PID', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        done(error instanceof Error ? error.message : String(error));
        return;
      }
      let output = '';
      killer.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
      });
      killer.stderr?.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
      });
      killer.on('error', (error) => done(error.message));
      killer.on('close', (code) => done(`exit=${code ?? 'null'} ${output.trim()}`.trim()));
    });
  } else {
    method = 'process-group SIGKILL';
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (error) {
      detail = (error as NodeJS.ErrnoException).code ?? String(error);
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }

  const exited = await waitForExit(child, timeoutMs);
  return { method, killed: exited, exited, detail };
}
