/**
 * 中文模块导读
 * 假运行器：启动测试夹具，模拟输出、失败或等待，帮助验证桥的行为。
 * 这里不用真实模型；假运行器测试通过不能代替真实 DSH 工具层和业务验收。
 */
/**
 * Test runner: a fixed fake child process selected only by service
 * configuration. It exists so that Windows process-tree, timeout, cancellation,
 * output-cap and protocol behaviour can be exercised without starting a real
 * model task. It can never be selected through MCP arguments.
 *
 * `killBehaviour` is test-only fault injection (FIX-001 R03): `noop` reports a
 * stop that did not happen, and `delayMs` makes the stop slow. Both are used to
 * prove that the bridge keeps the execution slot occupied until a stop is
 * *confirmed*, with a real child process still alive.
 */
import { BridgeError } from '../errors.js';
import type { FakeRunnerConfig } from '../config.js';
import type { Runner, RunnerDescription, RunnerEvents, RunnerHandle, RunnerSpec } from '../runner.js';
import type { KillResult } from '../proctree.js';
import { sleep } from '../atomic.js';
import { envFor, makeHandle, spawnRunnerProcess } from './shared.js';
import { checkLauncher } from './production.js';

/**
 * 用夹具替代真实模型的测试运行器。
 */
export class FakeRunner implements Runner {
  readonly type = 'fake' as const;
  readonly #config: FakeRunnerConfig;

  /**
   * 保存测试运行器配置。
   */
  constructor(config: FakeRunnerConfig) {
    this.#config = config;
  }

  /**
   * 报告测试夹具的可用性，用于本地自测。
   */
  describe(): RunnerDescription {
    const check = checkLauncher(this.#config.command, this.#config.argsPrefix);
    return {
      type: 'fake',
      available: check.available,
      diagnostic: check.diagnostic,
      commandTemplate: [this.#config.command, ...this.#config.argsPrefix, '<task>'].join(' '),
      details: { ...check.details, killBehaviour: this.#config.killBehaviour },
    };
  }

  /**
   * 按夹具约定启动模拟作业，连接与真实运行器相同的输出和结束回调。
   */
  start(spec: RunnerSpec, events: RunnerEvents): RunnerHandle {
    const args = [...this.#config.argsPrefix, ...this.#config.extraArgs, spec.taskArg];
    const env = envFor(process.env, this.#config.env);
    for (const [key, value] of Object.entries(spec.env)) env[key] = value;
    let child;
    try {
      child = spawnRunnerProcess({
        command: this.#config.command,
        args,
        cwd: spec.cwd,
        env,
        events,
      });
    } catch (error) {
      throw new BridgeError('SPAWN_FAILED', `failed to spawn fake runner: ${error instanceof Error ? error.message : String(error)}`, {
        command: this.#config.command,
      });
    }
    const base = makeHandle(child, args);
    const behaviour = this.#config.killBehaviour;
    return {
      ...base,
      kill: async (): Promise<KillResult | null> => {
        if (behaviour.mode === 'noop') {
          return {
            method: 'noop (test-injected)',
            killed: false,
            exited: false,
            detail: 'injected no-op kill: the child was deliberately left running',
          };
        }
        if (behaviour.delayMs > 0) await sleep(behaviour.delayMs);
        return base.kill();
      },
    };
  }
}
