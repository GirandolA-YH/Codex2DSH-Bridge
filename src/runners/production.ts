/**
 * 中文模块导读
 * 真实运行器：按固定配置启动已安装的 DSH headless 程序。
 * describe 只是检查和展示可用性；start 才会实际启动程序，后者可能产生模型费用。
 * 版本声明与实际探测结果是两回事；本机旧版与桌面版支持的参数差异仍需按安装环境核实。
 */
/**
 * Production runner: launches the installed DSH headless app.
 *
 * Verified on this machine (2026-10-09):
 *  - npm CLI `@deepseek-ai/dsh@0.1.0-rc.6` (stale global install on PATH):
 *    positional task only, no `--json`, no `--session-id`, no stdin.
 *  - desktop runtime `0.2.0-rc.2` (resources/app.asar/dsh):
 *    `--json`, `--session-id <id>` and `-` (task on stdin) are supported.
 *
 * The launcher is therefore explicit configuration, never caller input, and the
 * task transport is selectable so that both installations remain usable.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BridgeError } from '../errors.js';
import type { ProductionRunnerConfig } from '../config.js';
import type { Runner, RunnerDescription, RunnerEvents, RunnerHandle, RunnerSpec } from '../runner.js';
import { envFor, makeHandle, spawnRunnerProcess } from './shared.js';

/**
 * 启动器检查结果，available 只代表相关文件检查可用。
 */
interface LauncherCheck {
  available: boolean;
  diagnostic: string | null;
  details: Record<string, unknown>;
}

/** Inspect the configured launcher without ever executing it. */
/**
 * 只检查配置启动器及相关文件是否存在，不执行程序，也不验证模型业务结果。
 */
export function checkLauncher(command: string, argsPrefix: readonly string[]): LauncherCheck {
  const details: Record<string, unknown> = { command, argsPrefix };
  if (!fs.existsSync(command)) {
    return { available: false, diagnostic: `launcher command not found: ${command}`, details };
  }
  const first = argsPrefix[0];
  if (first !== undefined && !first.startsWith('-')) {
    const asarIndex = first.toLowerCase().indexOf('.asar');
    if (asarIndex >= 0) {
      // Paths inside app.asar are not real filesystem entries; validate the
      // archive that contains them instead.
      const archive = first.slice(0, asarIndex + '.asar'.length);
      if (!fs.existsSync(archive)) {
        return { available: false, diagnostic: `asar archive not found: ${archive}`, details: { ...details, archive } };
      }
      details['asarArchive'] = archive;
    } else if (!fs.existsSync(first)) {
      return { available: false, diagnostic: `launcher entry script not found: ${first}`, details };
    }
  }
  return { available: true, diagnostic: null, details };
}

/** Best-effort version detection next to a real (non-asar) entry script. */
/**
 * 尝试从真实入口附近的包信息读取版本；读不到则返回 null，不能把声明版本当作实际探测值。
 */
export function detectDshVersion(argsPrefix: readonly string[]): string | null {
  const first = argsPrefix[0];
  if (first === undefined || first.startsWith('-')) return null;
  if (first.toLowerCase().includes('.asar')) return null;
  let dir = path.dirname(first);
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = path.join(dir, 'package.json');
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { name?: string; version?: string };
      if (parsed.name === '@deepseek-ai/dsh' && typeof parsed.version === 'string') return parsed.version;
    } catch {
      /* keep walking up */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * 真正启动 DSH headless 的运行器。
 */
export class ProductionRunner implements Runner {
  readonly type = 'production' as const;
  readonly #config: ProductionRunnerConfig;

  /**
   * 保存经过校验的启动配置；构造对象本身不调用模型。
   */
  constructor(config: ProductionRunnerConfig) {
    this.#config = config;
  }

  /**
   * 检查启动器和凭据文件是否存在，返回可用性及版本信息；不读取或返回凭据内容。
   */
  describe(): RunnerDescription {
    const check = checkLauncher(this.#config.command, this.#config.argsPrefix);
    const detected = detectDshVersion(this.#config.argsPrefix);
    // Probe the conventional DSH home when no explicit one is configured, so the
    // boolean is meaningful. The file itself is never read, copied or reported.
    const dshHome = this.#config.dshHome ?? path.join(os.homedir(), '.dsh');
    const credentialsFile = path.join(dshHome, '.credentials.yaml');
    const commandTemplate = [
      this.#config.command,
      ...this.#config.argsPrefix,
      '--profile',
      this.#config.profile,
      ...(this.#config.jsonEvents ? ['--json'] : []),
      ...this.#config.extraArgs,
      this.#config.taskTransport === 'stdin' ? '-' : '<task>',
    ].join(' ');

    return {
      type: 'production',
      available: check.available,
      diagnostic: check.diagnostic,
      commandTemplate,
      details: {
        ...check.details,
        profile: this.#config.profile,
        taskTransport: this.#config.taskTransport,
        jsonEvents: this.#config.jsonEvents,
        declaredDshVersion: this.#config.declaredDshVersion,
        detectedDshVersion: detected,
        dshHomeConfigured: this.#config.dshHome !== null,
        // Boolean only: the file itself is never read, copied or reported.
        credentialsFilePresent: fs.existsSync(credentialsFile),
      },
    };
  }

  /**
   * 组装固定 headless 参数、工作目录和环境，启动一次真实 DSH 子进程，返回可取消的句柄。
   */
  start(spec: RunnerSpec, events: RunnerEvents): RunnerHandle {
    const config = this.#config;
    const args = [...config.argsPrefix, '--profile', config.profile];
    if (config.jsonEvents) args.push('--json');
    args.push(...config.extraArgs);
    args.push(config.taskTransport === 'stdin' ? '-' : spec.taskArg);

    const fixed: Record<string, string> = {};
    if (config.dshHome !== null) fixed['DSH_HOME'] = config.dshHome;

    const env = envFor(process.env, config.env, fixed);
    for (const [key, value] of Object.entries(spec.env)) env[key] = value;

    let child;
    try {
      child = spawnRunnerProcess({
        command: config.command,
        args,
        cwd: spec.cwd,
        env,
        events,
        stdinText: config.taskTransport === 'stdin' ? spec.taskArg : null,
      });
    } catch (error) {
      throw new BridgeError('SPAWN_FAILED', `failed to spawn DSH headless: ${error instanceof Error ? error.message : String(error)}`, {
        command: config.command,
      });
    }
    return makeHandle(child, args);
  }
}
