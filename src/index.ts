#!/usr/bin/env node
/**
 * 中文模块导读
 * 启动入口：把整个桥接程序组装起来。
 * 阅读顺序：先看 main，了解“读配置 → 创建任务管理器 → 建立 MCP 连接”；再看关闭流程。
 * stdout 是 Codex 与桥之间的协议通道，普通日志要走 stderr；把说明文字写进 stdout 会破坏通信。
 */
/**
 * Entry point: a local stdio MCP server.
 *
 * stdout carries only the MCP protocol stream; every diagnostic goes to stderr.
 * The single required flag is `--config <path>`; the caller (Codex) can never
 * influence the runner, the environment or the working directory through MCP
 * arguments.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BridgeError } from './errors.js';
import { loadConfig } from './config.js';
import { Redactor } from './redact.js';
import { createServer } from './mcp-server.js';
import { JobManager } from './jobs.js';
import { FakeRunner } from './runners/fake.js';
import { ProductionRunner } from './runners/production.js';
import type { Runner } from './runner.js';

const USAGE = `dsh-codex-bridge — local stdio MCP bridge for DSH headless jobs

Usage:
  node dist/src/index.js --config <path-to-config.json>

The config file fixes the runner, workspaces, task-file roots and limits.
MCP callers can only choose a workspaceId, a mode, a task file and a timeout.`;

/**
 * 读取启动参数；这里只接受配置路径和帮助开关，不接受工具调用者指定的启动命令。
 */
function parseArgs(argv: readonly string[]): { configPath: string | null; help: boolean } {
  let configPath: string | null = null;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--config') {
      const value = argv[index + 1];
      if (value === undefined) throw new BridgeError('CONFIG_INVALID', '--config requires a path');
      configPath = value;
      index += 1;
      continue;
    }
    throw new BridgeError('CONFIG_INVALID', `unknown argument: ${arg}`, { argument: arg });
  }
  return { configPath, help };
}

/**
 * 启动桥：加载配置、选择运行器、取得状态目录使用权、建立 MCP 连接，并安装关闭时的清理步骤。
 */
async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(USAGE + '\n');
    return;
  }
  if (parsed.configPath === null) {
    process.stderr.write(USAGE + '\n');
    process.exitCode = 2;
    return;
  }

  const config = loadConfig(parsed.configPath);
  // Fail loud but credential-free: an unexpected crash must be visible in stderr
  // instead of silently leaving a job that looks active.
  process.on('uncaughtException', (error) => {
    try {
      process.stderr.write(`dsh-codex-bridge: FATAL uncaught exception: ${config.redactor.redact(error?.stack ?? String(error))}\n`);
    } catch {
      /* stderr may already be gone */
    }
    process.exit(70);
  });
  process.on('unhandledRejection', (reason) => {
    try {
      const text = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
      process.stderr.write(`dsh-codex-bridge: FATAL unhandled rejection: ${config.redactor.redact(text)}\n`);
    } catch {
      /* stderr may already be gone */
    }
    process.exit(71);
  });
  const runner: Runner = config.runner.type === 'fake' ? new FakeRunner(config.runner.fake) : new ProductionRunner(config.runner.production);
  const jobs = new JobManager(config, runner);
  jobs.init();

  if (!jobs.isOwner) {
    const ownership = (jobs.health() as { ownership?: { diagnostic?: string | null; existingOwner?: unknown } }).ownership;
    process.stderr.write(
      `dsh-codex-bridge: FATAL STATE_DIR_BUSY: ${config.redactor.redact(ownership?.diagnostic ?? 'the state directory is owned by another bridge')}\n` +
        `  stateDir: ${config.stateDir}\n` +
        '  Refusing to start: a second bridge must not rewrite or schedule over the live owner\'s jobs.\n',
    );
    process.exit(2);
  }

  const description = runner.describe();
  config.logger.info('bridge starting', {
    version: config.serverVersion,
    runnerType: description.type,
    runnerAvailable: description.available,
    runnerDiagnostic: description.diagnostic,
    stateDir: config.stateDir,
  });

  const server = createServer(config, jobs);
  const transport = new StdioServerTransport();

  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (reason: string): Promise<void> => {
    // Idempotent *and* awaitable: several triggers (stdin end/close, protocol
    // close, signals) can arrive together, and every one of them must wait for
    // the single cleanup pass instead of exiting early.
    if (shutdownPromise === null) {
      shutdownPromise = (async () => {
        config.logger.info('bridge shutting down', { reason });
        try {
          await jobs.shutdown();
        } catch (error) {
          config.logger.error('shutdown cleanup failed', { message: error instanceof Error ? error.message : String(error) });
        }
        try {
          await server.close();
        } catch {
          /* the transport may already be gone */
        }
      })();
    }
    return shutdownPromise;
  };
  const shutdownAndExit = (reason: string): void => {
    void shutdown(reason).then(() => {
      process.exit(0);
    });
  };

  // `server.connect()` installs its own transport.onclose, so the bridge cleanup
  // is attached to the protocol's close hook instead. The stdin listeners are the
  // belt-and-braces path: on Windows a client that terminates the process cannot
  // deliver SIGTERM, but an orderly close always ends stdin.
  server.onclose = () => shutdownAndExit('server closed');
  process.stdin.on('end', () => shutdownAndExit('stdin ended'));
  process.stdin.on('close', () => shutdownAndExit('stdin closed'));

  process.on('SIGINT', () => shutdownAndExit('SIGINT'));
  process.on('SIGTERM', () => shutdownAndExit('SIGTERM'));
  process.on('SIGHUP', () => shutdownAndExit('SIGHUP'));

  await server.connect(transport);
  config.logger.info('bridge ready on stdio');
}

/**
 * Credential-free FATAL reporting for failures raised *before* a redactor
 * exists (R2-04). `loadConfig` itself can fail, and its message may quote a
 * configured value; the fallback therefore still runs the pattern rules. It
 * cannot use configured literals (the configuration is what failed to load),
 * which is a declared boundary rather than a reason to print the raw message.
 */
/**
 * 处理配置尚未成功加载时的致命错误；只能使用通用脱敏规则，不能假装已知道配置里的所有秘密值。
 */
function fatalText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  try {
    return new Redactor(process.env, {}).redact(message);
  } catch {
    return 'FATAL error (message withheld: the credential-free redactor could not be constructed)';
  }
}

main().catch((error: unknown) => {
  const code = error instanceof BridgeError ? error.code : 'INTERNAL_ERROR';
  process.stderr.write(`dsh-codex-bridge: FATAL ${code}: ${fatalText(error)}\n`);
  process.exit(2);
});
