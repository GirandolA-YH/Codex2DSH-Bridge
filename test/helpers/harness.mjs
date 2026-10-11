/**
 * Offline test harness.
 *
 * Every test file gets its own sandbox directory, state directory, task root and
 * config file, so no test can observe another test's jobs. The runner is always
 * the fake child process; the real DSH is never launched by the suite.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXTURES = path.join(ROOT, 'fixtures');
export const FAKE_RUNNER = path.join(FIXTURES, 'fake-runner.mjs');
export const TEE = path.join(ROOT, 'test', 'helpers', 'server-tee.mjs');
export const ENTRY = path.join(ROOT, 'dist', 'src', 'index.js');

export function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

export function makeEnv(name) {
  const dir = path.join(ROOT, 'test', '.tmp', name);
  rmrf(dir);
  const paths = {
    dir,
    state: path.join(dir, 'state'),
    tasks: path.join(dir, 'tasks'),
    impl: path.join(dir, 'sandbox', 'impl'),
    audit: path.join(dir, 'sandbox', 'audit-snapshot'),
    outside: path.join(dir, 'sandbox', 'outside'),
    reports: path.join(dir, 'sandbox', 'reports'),
    work: path.join(dir, 'sandbox', 'work'),
    logs: path.join(dir, 'logs'),
  };
  for (const value of Object.values(paths)) {
    if (typeof value === 'string') fs.mkdirSync(value, { recursive: true });
  }
  fs.writeFileSync(path.join(paths.impl, 'module.js'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(paths.outside, 'secret.txt'), 'outside the allowed roots\n');
  return paths;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Deep-merge an override so a test can replace one runner field and keep the rest. */
function mergeDeep(base, override) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    if (key === '__name') continue;
    if (isPlainObject(value) && isPlainObject(out[key])) out[key] = mergeDeep(out[key], value);
    else out[key] = value;
  }
  return out;
}

export function writeConfig(env, overrides = {}) {
  const defaults = {
    server: { name: 'dsh-codex-bridge', version: '0.1.0', logLevel: 'info' },
    stateDir: env.state,
    taskFileRoots: [env.tasks],
    workspaces: {
      impl: { dir: env.impl, allowedModes: ['implement', 'fix'], description: 'self-test implementation sandbox' },
      work: { dir: env.work, allowedModes: ['implement', 'fix'], description: 'second implementation workspace' },
      audit: {
        dir: env.audit,
        allowedModes: ['audit'],
        audit: { sourceWorkspaceId: 'impl', reportDir: env.reports },
        description: 'audit snapshot of impl',
      },
    },
    runner: {
      type: 'fake',
      fake: { command: process.execPath, argsPrefix: [FAKE_RUNNER] },
      production: {
        command: process.execPath,
        argsPrefix: [path.join(ROOT, 'fixtures', 'fake-runner.mjs')],
        profile: 'headless',
      },
    },
    limits: {
      defaultTimeoutSeconds: 30,
      minTimeoutSeconds: 1,
      maxTimeoutSeconds: 60,
      perStreamCaptureCapBytes: 5 * 1024 * 1024,
      resultPageMaxBytes: 64 * 1024,
      inlineTaskMaxChars: 16384,
      maxTaskFileBytes: 1024 * 1024,
    },
    concurrency: { maxActiveJobs: 1 },
    recovery: { killOrphanedChildrenOnStart: false },
    cleanup: { confirmTimeoutMs: 2500, killTimeoutMs: 5000 },
    ownership: { staleHeartbeatMs: 30000, heartbeatMs: 1000 },
    audit: { maxSnapshotBytes: 512 * 1024 * 1024, maxSnapshotFiles: 20000 },
    redaction: { extraSecretEnv: [], extraLiteralSecrets: [] },
  };
  const config = mergeDeep(defaults, overrides);
  const configPath = path.join(env.dir, `bridge.config.${overrides.__name ?? 'test'}.json`);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

export function writeTask(env, fileName, content) {
  const file = path.join(env.tasks, fileName);
  fs.writeFileSync(file, content);
  return file;
}

export async function startBridge(configPath, env, options = {}) {
  const stdoutLog = path.join(env.logs, `${options.name ?? 'server'}.stdout.log`);
  const stderrLog = path.join(env.logs, `${options.name ?? 'server'}.stderr.log`);
  const pidFile = path.join(env.logs, `${options.name ?? 'server'}.pid`);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [TEE, ENTRY, '--config', configPath],
    env: {
      ...process.env,
      SERVER_STDOUT_LOG: stdoutLog,
      SERVER_STDERR_LOG: stderrLog,
      SERVER_PID_FILE: pidFile,
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'bridge-selftest', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return {
    client,
    transport,
    stdoutLog,
    stderrLog,
    pidFile,
    serverPid: () => (fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : null),
    close: async () => {
      try {
        await client.close();
      } catch {
        /* already closed */
      }
    },
  };
}

export async function callTool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`tool ${name} returned non-JSON content: ${text.slice(0, 400)}`);
  }
  return { isError: result.isError === true, payload: parsed, raw: result };
}

export async function callToolExpectError(client, name, args = {}) {
  const { isError, payload } = await callTool(client, name, args);
  if (!isError) throw new Error(`expected ${name} to fail, got ${JSON.stringify(payload).slice(0, 300)}`);
  return payload.error;
}

export async function waitForTerminal(client, jobId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { payload } = await callTool(client, 'dsh_status', { jobId });
    if (payload.job.terminal) return payload.job;
    if (Date.now() > deadline) throw new Error(`job ${jobId} did not finish within ${timeoutMs} ms (last status ${payload.job.status})`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function exists(target) {
  return fs.existsSync(target);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(predicate, timeoutMs = 10000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
