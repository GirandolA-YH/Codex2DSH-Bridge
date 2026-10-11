#!/usr/bin/env node
/**
 * dsh-monitor —— 本机只读 DSH 作业监控面板
 *
 * 启动：node server.mjs
 * 默认监听 127.0.0.1:4178，只提供 GET 数据接口与静态资源。
 * 本进程不启动桥、不启动任何模型作业、不写状态目录。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConfig, USAGE, DEFAULT_STATE_ROOT } from './src/config.mjs';
import { createMonitor } from './src/monitor.mjs';
import { createRequestHandler, startServer } from './src/http.mjs';
import { materializeDemoState } from './fixtures/demo.mjs';

const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
const VERSION = '1.0.0';

/** 生产只读模式：只用操作者给出的路径，不做任何推导。 */
function buildRealConfig(config) {
  const workspaceMap = {
    ...(config.workspaceMap ?? {}),
    names: { ...(config.workspaceMap?.names ?? {}), ...(config.names ?? {}) },
  };
  return {
    host: config.host,
    port: config.port,
    stateRoot: config.stateRoot,
    acceptanceLedger: config.acceptanceLedger,
    workspaceMap,
    limits: config.limits,
    refreshIntervalMs: config.refreshIntervalMs,
    staleHeartbeatMs: config.staleHeartbeatMs,
    demo: false,
    cleanup: null,
  };
}

/** 演示模式：把夹具写到系统临时目录，退出时删除；绝不与真实数据混在一起。 */
function buildDemoConfig(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-monitor-demo-'));
  const demo = materializeDemoState(dir, { now: Date.now() });
  return {
    host: config.host,
    port: config.port,
    stateRoot: demo.root,
    acceptanceLedger: demo.ledgerPath,
    workspaceMap: {
      byWorkspaceId: { 'demo-workspace': demo.workspaceDir },
      names: { 'job-demo000000000002': '演示：已完成并验收通过' },
      workspaceNames: { 'demo-workspace': '演示工作目录' },
    },
    limits: config.limits,
    refreshIntervalMs: config.refreshIntervalMs,
    staleHeartbeatMs: config.staleHeartbeatMs,
    demo: true,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 临时目录清理失败不影响退出 */
      }
    },
  };
}

function printSummary(config, meta, extra) {
  const lines = [];
  lines.push('DSH 作业监控（只读面板）');
  lines.push(`  模式      ${config.demo ? '演示数据（--demo，页面会显示“演示数据”横幅）' : '生产只读'}`);
  lines.push(`  状态根    ${config.stateRoot}`);
  lines.push(`  验收账本  ${config.acceptanceLedger ?? '未配置（验收状态一律“未提供验收记录”）'}`);
  lines.push(
    `  交付白名单 ${meta.workspaceMap.configured ? `${meta.workspaceMap.workspaceCount} 个工作区 / ${meta.workspaceMap.jobOverrideCount} 个作业覆盖` : '未配置（显示“未配置交付目录”）'}`,
  );
  lines.push(`  刷新间隔  ${config.refreshIntervalMs} ms`);
  if (extra) lines.push(...extra);
  return lines.join('\n');
}

async function main() {
  const result = buildConfig(process.argv.slice(2));
  if (result.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  if (!result.ok) {
    process.stderr.write(`参数错误：${result.message}\n\n${USAGE}`);
    process.exit(2);
  }

  const config = result.config.demo ? buildDemoConfig(result.config) : buildRealConfig(result.config);
  const monitor = createMonitor({ ...config, version: VERSION });

  if (result.config.dump === true || result.config.dumpJob !== null) {
    const payload =
      result.config.dumpJob !== null ? monitor.detail(result.config.dumpJob) : monitor.list();
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    if (config.cleanup) config.cleanup();
    process.exit(0);
  }

  const handler = createRequestHandler({
    monitor,
    publicDir: PUBLIC_DIR,
    limits: config.limits,
    logger: (message) => process.stderr.write(`[dsh-monitor] ${message}\n`),
  });

  let started;
  try {
    started = await startServer({ host: config.host, port: config.port, handler });
  } catch (error) {
    if (config.cleanup) config.cleanup();
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }

  process.stdout.write(
    `${printSummary(config, monitor.meta(), [`  地址      ${started.url}`, '  提示      Ctrl+C 停止；本面板不写入任何状态目录。'])}\n`,
  );

  let closing = false;
  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    process.stdout.write(`\n收到 ${signal}，正在停止面板…\n`);
    started.server.close(() => {
      if (config.cleanup) config.cleanup();
      process.stdout.write('面板已停止。\n');
      process.exit(0);
    });
    setTimeout(() => {
      if (config.cleanup) config.cleanup();
      process.exit(0);
    }, 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// 只有直接执行 server.mjs 才启动服务；被 import 时（测试）不产生副作用。
const entry = process.argv[1];
const isDirectRun =
  typeof entry === 'string' && path.resolve(entry).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isDirectRun) {
  main().catch((error) => {
    process.stderr.write(`启动失败：${error && error.message ? error.message : '未知错误'}\n`);
    process.exit(1);
  });
}

export { buildRealConfig, buildDemoConfig, DEFAULT_STATE_ROOT };
