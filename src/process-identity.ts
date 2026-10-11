/**
 * 中文模块导读
 * 进程身份核对：检查某个 PID 是否仍是当初由桥启动的那个进程。
 * PID 会被系统重复使用，所以还要比较创建时间、程序路径和启动参数摘要，避免误杀后来占用同一编号的程序。
 */
/**
 * Process identity probing (FIX-002 F2-02, tightened by FIX-003 F3-02).
 *
 * A pid is reusable, so "pid is alive" is not evidence that a recorded job still
 * owns it. Before any automatic orphan termination the bridge compares the
 * *current* process identity against the identity it recorded when it spawned
 * that job: creation time + executable path + a command-line digest.
 *
 * The recorded creation time already comes from the OS query, so it is compared
 * **exactly**: any difference means a different process. Missing, mistyped or
 * non-finite fields on either side are "not proven", never "proven by accident"
 * (e.g. via NaN comparisons), and never throw.
 *
 * Windows: `Get-CimInstance Win32_Process`. POSIX: `/proc`. When the host cannot
 * produce complete evidence, the answer is `unavailable` and the caller must NOT
 * terminate anything.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { ChildIdentity } from './types.js';

/**
 * 从系统查询到的进程身份信息。
 */
export interface ProcessIdentity {
  pid: number;
  creationTimeMs: number;
  executablePath: string;
  commandLineDigest: string;
}

/**
 * 身份查询结果；成功与无法确认应分别处理。
 */
export type IdentityProbe =
  | { status: 'ok'; identity: ProcessIdentity }
  | { status: 'unavailable'; reason: string }
  | { status: 'not-found'; reason: string };

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/**
 * 对启动命令文字做摘要，用于身份比较，减少直接保存整条命令的需要。
 */
export function commandLineDigest(commandLine: string): string {
  return createHash('sha256').update(commandLine.replace(/\s+/g, ' ').trim()).digest('hex');
}

/**
 * 规范程序路径，减少大小写、分隔符等表示差异对身份比较的影响。
 */
function normalizePath(value: string): string {
  return path.resolve(value).replace(/[\\/]+$/, '').toLowerCase();
}

/**
 * Validate an identity record on its own terms. Returns `null` when any required
 * field is missing, mistyped, empty or not finite — old records without the
 * field are `null`, not a crash.
 */
/**
 * 检查保存的子进程身份信息；缺字段、错误类型或非法值都不能作为自动清理依据。
 */
export function normalizeChildIdentity(value: unknown): ChildIdentity | null {
  if (value === null || value === undefined || typeof value !== 'object') return null;
  const candidate = value as Partial<ChildIdentity>;
  if (typeof candidate.pid !== 'number' || !Number.isInteger(candidate.pid) || candidate.pid <= 0) return null;
  if (typeof candidate.creationTimeMs !== 'number' || !Number.isFinite(candidate.creationTimeMs) || candidate.creationTimeMs <= 0) return null;
  if (typeof candidate.executablePath !== 'string' || candidate.executablePath.trim() === '') return null;
  if (typeof candidate.commandLineDigest !== 'string' || !DIGEST_PATTERN.test(candidate.commandLineDigest)) return null;
  return {
    pid: candidate.pid,
    creationTimeMs: candidate.creationTimeMs,
    executablePath: candidate.executablePath,
    commandLineDigest: candidate.commandLineDigest,
  };
}

/**
 * 把系统返回的创建时间转换成可比较的毫秒时间。
 */
function parseCreationDate(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || value === '') return null;
  // PowerShell 5.1 serializes DateTime as /Date(1696000000000)/
  const legacy = /\/Date\((-?\d+)\)\//.exec(value);
  if (legacy !== null) {
    const parsed = Number(legacy[1]);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 从 Windows 系统查询进程创建时间、程序路径和命令信息；查询失败返回未知，而不是猜测身份。
 */
function probeWindows(pid: number): IdentityProbe {
  const script =
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction Stop; ` +
    'if ($p -eq $null) { Write-Output "null" } else { ' +
    '$p | Select-Object ProcessId,CreationDate,ExecutablePath,CommandLine | ConvertTo-Json -Compress }';
  let output: string;
  try {
    output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    return { status: 'unavailable', reason: `identity probe failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (output === '' || output === 'null') return { status: 'not-found', reason: 'process not found' };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(output) as Record<string, unknown>;
  } catch (error) {
    return { status: 'unavailable', reason: `identity probe returned unparseable output: ${error instanceof Error ? error.message : String(error)}` };
  }
  const creationTimeMs = parseCreationDate(parsed['CreationDate']);
  const executablePath = typeof parsed['ExecutablePath'] === 'string' && parsed['ExecutablePath'].trim() !== '' ? parsed['ExecutablePath'] : '';
  // A null/absent CommandLine is incomplete evidence: it must not become an
  // "empty but proved" command line (FIX-003 F3-02).
  const commandLine = typeof parsed['CommandLine'] === 'string' && parsed['CommandLine'].trim() !== '' ? parsed['CommandLine'] : '';
  if (creationTimeMs === null) return { status: 'unavailable', reason: 'CIM returned no usable CreationDate' };
  if (executablePath === '') return { status: 'unavailable', reason: 'CIM returned no ExecutablePath' };
  if (commandLine === '') return { status: 'unavailable', reason: 'CIM returned no CommandLine; identity is incomplete' };
  return { status: 'ok', identity: { pid, creationTimeMs, executablePath, commandLineDigest: commandLineDigest(commandLine) } };
}

/**
 * 在支持的类 Unix 环境查询进程信息，为身份比较提供系统证据。
 */
function probePosix(pid: number): IdentityProbe {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const closing = stat.lastIndexOf(')');
    const fields = stat.slice(closing + 2).split(' ');
    const startTicks = Number(fields[19]);
    const bootTimeSeconds = Number(/btime (\d+)/.exec(fs.readFileSync('/proc/stat', 'utf8'))?.[1] ?? 'NaN');
    if (!Number.isFinite(startTicks) || !Number.isFinite(bootTimeSeconds)) {
      return { status: 'unavailable', reason: 'cannot derive process start time' };
    }
    const executablePath = fs.readlinkSync(`/proc/${pid}/exe`);
    const commandLine = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
    if (executablePath === '' || commandLine === '') {
      return { status: 'unavailable', reason: 'process identity fields are incomplete' };
    }
    return {
      status: 'ok',
      identity: {
        pid,
        creationTimeMs: Math.round(bootTimeSeconds * 1000 + (startTicks / 100) * 1000),
        executablePath,
        commandLineDigest: commandLineDigest(commandLine),
      },
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { status: 'not-found', reason: 'process not found' };
    return { status: 'unavailable', reason: `identity probe failed: ${code ?? String(error)}` };
  }
}

/**
 * 按操作系统选择查询方式，返回成功、已不存在或无法确认的结果。
 */
export function probeProcessIdentity(pid: number): IdentityProbe {
  if (!Number.isInteger(pid) || pid <= 0) return { status: 'unavailable', reason: 'invalid pid' };
  return os.platform() === 'win32' ? probeWindows(pid) : probePosix(pid);
}

/**
 * 保存身份与当前系统身份的逐项比较结果。
 */
export interface IdentityComparison {
  proven: boolean;
  reason: string;
}

/**
 * 检查期望身份是否足以支持比较；不能用半份信息批准自动清理。
 */
function validateExpected(expected: unknown): { ok: true; identity: ChildIdentity } | { ok: false; reason: string } {
  const normalized = normalizeChildIdentity(expected);
  if (normalized === null) return { ok: false, reason: 'recorded child identity is missing or invalid (pid/creationTimeMs/executablePath/commandLineDigest)' };
  return { ok: true, identity: normalized };
}

/**
 * Prove that the currently running `pid` is the same process the bridge started.
 *
 * Requires an exact creation-time match **and** the same executable path
 * **and** the same command-line digest. Anything less is "not proven", and no
 * input shape may throw or be accepted through implicit conversion.
 */
/**
 * 逐项比对 PID、创建时间、程序路径和命令摘要；只有匹配才认可为当初的子进程。
 */
export function compareIdentity(expected: unknown, observed: IdentityProbe): IdentityComparison {
  const checked = validateExpected(expected);
  if (!checked.ok) return { proven: false, reason: checked.reason };
  const wanted = checked.identity;

  if (observed === null || observed === undefined || typeof observed !== 'object') {
    return { proven: false, reason: 'no observed identity' };
  }
  if (observed.status === 'not-found') return { proven: false, reason: 'the recorded pid no longer exists' };
  if (observed.status === 'unavailable') return { proven: false, reason: observed.reason };
  if (observed.status !== 'ok') return { proven: false, reason: 'observed identity has an unknown status' };

  const identity = observed.identity as Partial<ProcessIdentity> | undefined;
  if (identity === null || identity === undefined || typeof identity !== 'object') {
    return { proven: false, reason: 'observed identity is missing' };
  }
  if (typeof identity.pid !== 'number' || !Number.isInteger(identity.pid) || identity.pid <= 0) {
    return { proven: false, reason: 'observed pid is invalid' };
  }
  if (identity.pid !== wanted.pid) return { proven: false, reason: 'pid mismatch' };
  if (typeof identity.creationTimeMs !== 'number' || !Number.isFinite(identity.creationTimeMs) || identity.creationTimeMs <= 0) {
    return { proven: false, reason: 'observed creation time is missing or not finite' };
  }
  if (identity.creationTimeMs !== wanted.creationTimeMs) {
    return {
      proven: false,
      reason: `process creation time differs by ${identity.creationTimeMs - wanted.creationTimeMs} ms (recorded ${new Date(wanted.creationTimeMs).toISOString()}, observed ${new Date(identity.creationTimeMs).toISOString()})`,
    };
  }
  if (typeof identity.executablePath !== 'string' || identity.executablePath.trim() === '') {
    return { proven: false, reason: 'observed executable path is missing' };
  }
  if (normalizePath(identity.executablePath) !== normalizePath(wanted.executablePath)) {
    return { proven: false, reason: `executable path differs (recorded ${wanted.executablePath}, observed ${identity.executablePath})` };
  }
  if (typeof identity.commandLineDigest !== 'string' || !DIGEST_PATTERN.test(identity.commandLineDigest)) {
    return { proven: false, reason: 'observed command-line digest is missing or malformed' };
  }
  if (identity.commandLineDigest !== wanted.commandLineDigest) {
    return { proven: false, reason: 'command line differs from the recorded child' };
  }
  return { proven: true, reason: 'creation time, executable path and command line all match the recorded child exactly' };
}
