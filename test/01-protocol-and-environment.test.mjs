/**
 * A01 — local versions and the real headless parameter surface (read-only).
 * A02 — real MCP protocol: initialize, tools/list, five tools/call, clean disconnect,
 *       and stdout carrying only JSON-RPC frames.
 *
 * No real model task is started: A01 only reads installed package metadata and
 * the app.asar archive, and A02 uses the fake runner.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import * as H from './helpers/harness.mjs';

const APPDATA = process.env.APPDATA ?? '';
const LOCALAPPDATA = process.env.LOCALAPPDATA ?? '';
const GLOBAL_DSH_PKG = path.join(APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
const GLOBAL_HEADLESS = path.join(APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-headless', 'lib', 'startup.js');
const DESKTOP_ROOT = path.join(LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources');
const DESKTOP_ASAR = path.join(DESKTOP_ROOT, 'app.asar');
const ASAR_TOOL = path.join(H.ROOT, 'tools', 'inspect-asar.mjs');

function readAsarEntry(entryPath) {
  return execFileSync(process.execPath, [ASAR_TOOL, 'read', DESKTOP_ASAR, entryPath], { encoding: 'utf8' });
}

test('A01 two DSH installations exist and their headless surfaces differ', async (t) => {
  if (!fs.existsSync(GLOBAL_DSH_PKG) || !fs.existsSync(DESKTOP_ASAR)) {
    t.skip('pilot machine layout not present');
    return;
  }
  const globalVersion = JSON.parse(fs.readFileSync(GLOBAL_DSH_PKG, 'utf8')).version;
  const runtimeHome = path.join(process.env.USERPROFILE ?? '', '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'runtime.json');
  const desktopVersion = JSON.parse(fs.readFileSync(runtimeHome, 'utf8')).desktopVersion;
  const asarDshVersion = JSON.parse(readAsarEntry('/dsh/node_modules/@deepseek-ai/dsh/package.json')).version;
  const asarHeadlessVersion = JSON.parse(readAsarEntry('/dsh/node_modules/@deepseek-ai/dsh-headless/package.json')).version;

  assert.match(globalVersion, /^0\.1\.0-rc\.\d+$/, 'global npm CLI is the stale 0.1.0-rc.x install');
  assert.match(desktopVersion, /^0\.2\.0-rc\.\d+$/, 'desktop runtime is 0.2.0-rc.x');
  assert.equal(asarDshVersion, asarHeadlessVersion, 'asar dsh and dsh-headless agree');
  assert.equal(asarDshVersion, desktopVersion, 'asar dsh matches the desktop runtime version');
  assert.notEqual(globalVersion, asarDshVersion, 'the two installations really differ');

  const newStartup = readAsarEntry('/dsh/node_modules/@deepseek-ai/dsh-headless/lib/startup.js');
  assert.match(newStartup, /--json/, '0.2.0-rc.2 supports --json');
  assert.match(newStartup, /--session-id/, '0.2.0-rc.2 supports --session-id');
  assert.match(newStartup, /reads stdin|`-`/, '0.2.0-rc.2 supports the `-` stdin transport');

  const oldStartup = fs.readFileSync(GLOBAL_HEADLESS, 'utf8');
  assert.doesNotMatch(oldStartup, /--json/, 'the stale CLI has no --json');
  assert.doesNotMatch(oldStartup, /--session-id/, 'the stale CLI has no --session-id');
  assert.match(oldStartup, /\[task\.\.\.\]/, 'the stale CLI accepts the task positional only');

  t.diagnostic(`global npm dsh=${globalVersion}; desktop/asar dsh=${asarDshVersion}`);
});

test('A01 the production launcher is inspected without being executed', async () => {
  const env = H.makeEnv('a01-launcher');
  const binPath = path.join(APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  const configPath = H.writeConfig(env, {
    __name: 'a01',
    runner: {
      type: 'production',
      production: {
        command: process.execPath,
        argsPrefix: [binPath],
        profile: 'headless',
        taskTransport: 'argv',
        jsonEvents: false,
      },
    },
  });
  const bridge = await H.startBridge(configPath, env, { name: 'a01' });
  try {
    const { payload } = await H.callTool(bridge.client, 'dsh_health');
    assert.equal(payload.ok, true);
    assert.equal(payload.runner.type, 'production');
    assert.equal(payload.runner.available, true, payload.runner.diagnostic ?? '');
    assert.equal(payload.runner.details.detectedDshVersion, '0.1.0-rc.6');
    assert.equal(payload.runner.details.taskTransport, 'argv');
    assert.equal(payload.runner.details.jsonEvents, false);
    assert.equal(typeof payload.runner.details.credentialsFilePresent, 'boolean');
    assert.equal(payload.capabilities.mcpTasksExtension, false);
    assert.equal(payload.activeJob, null);
  } finally {
    await bridge.close();
  }
});

test('A02 real MCP protocol round trip over stdio', async () => {
  const env = H.makeEnv('a02');
  const configPath = H.writeConfig(env, { __name: 'a02' });
  const taskFile = H.writeTask(env, 'roundtrip.md', 'FAKE_EXIT=0\nreply with ok\n');
  const bridge = await H.startBridge(configPath, env, { name: 'a02' });

  const tools = await bridge.client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name).sort(),
    ['dsh_cancel', 'dsh_health', 'dsh_result', 'dsh_status', 'dsh_submit'],
  );
  for (const tool of tools.tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.ok(typeof tool.description === 'string' && tool.description.length > 20);
  }

  const health = await H.callTool(bridge.client, 'dsh_health');
  assert.equal(health.isError, false);
  assert.equal(health.payload.ok, true);

  const unknown = await H.callToolExpectError(bridge.client, 'dsh_status', { jobId: 'job-0000000000000000' });
  assert.equal(unknown.code, 'JOB_NOT_FOUND');

  const submit = await H.callTool(bridge.client, 'dsh_submit', {
    requestId: 'a02-roundtrip',
    workspaceId: 'impl',
    taskFile,
    mode: 'implement',
  });
  assert.equal(submit.isError, false);
  const jobId = submit.payload.jobId;
  assert.match(jobId, /^job-[0-9a-f]{16}$/);

  const finished = await H.waitForTerminal(bridge.client, jobId);
  assert.equal(finished.status, 'completed');
  assert.equal(finished.exitCode, 0);

  const result = await H.callTool(bridge.client, 'dsh_result', { jobId, limit: 4096 });
  assert.equal(result.isError, false);
  assert.equal(result.payload.page.totalChars > 0, true);
  assert.equal(result.payload.job.terminal, true);

  const cancel = await H.callTool(bridge.client, 'dsh_cancel', { jobId });
  assert.equal(cancel.isError, false);
  assert.equal(cancel.payload.alreadyTerminal, true);

  await bridge.close();
  await H.sleep(400);

  // stdout must carry only protocol frames; logs go to stderr.
  const stdoutText = fs.readFileSync(bridge.stdoutLog, 'utf8');
  const lines = stdoutText.split('\n').filter((line) => line.trim() !== '');
  assert.ok(lines.length >= 6, `expected protocol frames, saw ${lines.length} lines`);
  for (const line of lines) {
    const frame = JSON.parse(line);
    assert.equal(frame.jsonrpc, '2.0', `non protocol line on stdout: ${line.slice(0, 200)}`);
  }
  const stderrText = fs.readFileSync(bridge.stderrLog, 'utf8');
  assert.match(stderrText, /bridge ready on stdio/);
});

test('A02 raw stdio stream carries only JSON-RPC frames end to end', async () => {
  const env = H.makeEnv('a02-raw');
  const configPath = H.writeConfig(env, { __name: 'a02raw' });
  const child = spawn(process.execPath, [H.ENTRY, '--config', configPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdoutText = '';
  let stderrText = '';
  child.stdout.on('data', (chunk) => {
    stdoutText += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk) => {
    stderrText += chunk.toString('utf8');
  });

  const send = (frame) => child.stdin.write(`${JSON.stringify(frame)}\n`);
  const waitForFrame = async (predicate, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (const line of stdoutText.split('\n')) {
        if (line.trim() === '') continue;
        let frame;
        try {
          frame = JSON.parse(line);
        } catch {
          throw new Error(`non-JSON line on stdout: ${line.slice(0, 200)}`);
        }
        if (predicate(frame)) return frame;
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for a frame; stdout so far: ${stdoutText.slice(0, 400)}`);
      await H.sleep(50);
    }
  };

  try {
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'raw-stdio-selftest', version: '1.0.0' },
      },
    });
    const initialized = await waitForFrame((frame) => frame.id === 1);
    assert.equal(initialized.result.serverInfo.name, 'dsh-codex-bridge');

    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const listed = await waitForFrame((frame) => frame.id === 2);
    assert.deepEqual(
      listed.result.tools.map((tool) => tool.name).sort(),
      ['dsh_cancel', 'dsh_health', 'dsh_result', 'dsh_status', 'dsh_submit'],
    );

    child.stdin.end();
    const exitCode = await new Promise((resolve) => child.on('close', (code) => resolve(code)));
    assert.equal(exitCode, 0, 'the bridge exits cleanly when stdin ends');

    for (const line of stdoutText.split('\n').filter((line) => line.trim() !== '')) {
      assert.equal(JSON.parse(line).jsonrpc, '2.0', `stdout carried a non-protocol line: ${line.slice(0, 200)}`);
    }
    assert.match(stderrText, /bridge ready on stdio/);
    assert.match(stderrText, /bridge shutting down/);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});
