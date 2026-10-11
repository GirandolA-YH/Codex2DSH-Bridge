/** R4 contracts: pure checks, explicitly injected races, and offline native MCP/fake-child runs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig, AUDIT_HARD_DENY } from '../dist/src/config.js';
import { JobManager } from '../dist/src/jobs.js';
import { isValidJobRecord } from '../dist/src/store.js';
import { Redactor, REDACTION_PATTERN_NAMES } from '../dist/src/redact.js';
import { StreamCapture } from '../dist/src/capture.js';
import { compilePolicy } from '../dist/src/hashing.js';
import { refreshSnapshot } from '../dist/src/audit.js';
import * as H from './helpers/harness.mjs';

class ImmediateRunner {
  type = 'fake'; starts = 0;
  describe() { return { type: 'fake', available: true, diagnostic: null, commandTemplate: 'in-memory fake', details: {} }; }
  start(_spec, events) { this.starts++; setImmediate(() => events.onExit(0, null)); return { pid: undefined, command: [], kill: async () => null }; }
}

test('R4-02 simulated lost-index controls and surviving missing record never duplicate a request', async () => {
  const env = H.makeEnv('r4-lost-evidence'); const cfg = loadConfig(H.writeConfig(env, { server: { logLevel: 'error' } })); const runner = new ImmediateRunner();
  const input = { requestId: 'lost-evidence', workspaceId: 'impl', mode: 'fix', taskFile: H.writeTask(env, 'task.md', 'fake\n') };
  const first = new JobManager(cfg, runner); first.init(); const sub = await first.submit(input); await H.sleep(30); first.releaseOwnership();
  const job = first.store.jobFile(sub.jobId), idx = first.store.requestFile(input.requestId);
  fs.unlinkSync(idx);
  const indexLost = new JobManager(cfg, runner); indexLost.init();
  assert.equal((await indexLost.submit(input)).jobId, sub.jobId); assert.equal(runner.starts, 1); indexLost.releaseOwnership();
  fs.unlinkSync(job);
  const recordLost = new JobManager(cfg, runner); recordLost.init();
  try {
    assert.equal(recordLost.health().integrity.unreadableJobs.length, 1);
    await assert.rejects(recordLost.submit(input), e => e.code === 'REQUEST_INDEX_UNREADABLE');
    assert.throws(() => recordLost.status(sub.jobId), e => e.code === 'JOB_RECORD_UNREADABLE');
  } finally { recordLost.releaseOwnership(); }
  fs.unlinkSync(idx);
  const bothLost = new JobManager(cfg, runner); bothLost.init();
  try { await assert.rejects(bothLost.submit(input), e => e.code === 'REQUEST_INDEX_UNREADABLE'); assert.equal(runner.starts, 1); assert.equal(bothLost.store.jobIds().length, 1); }
  finally { await bothLost.shutdown(); }
});

test('R4-02 pure shallow records are rejected while the supported missing-childIdentity legacy record stays readable', async () => {
  const env = H.makeEnv('r4-record-schema'); const cfg = loadConfig(H.writeConfig(env)); const runner = new ImmediateRunner(); const m = new JobManager(cfg, runner); m.init();
  const sub = await m.submit({ requestId: 'schema', workspaceId: 'impl', mode: 'fix', taskFile: H.writeTask(env, 'task.md', 'fake\n') }); await H.sleep(30);
  const good = m.store.loadJob(sub.jobId); assert.equal(isValidJobRecord(good), true);
  const legacy = { ...good }; delete legacy.childIdentity; assert.equal(isValidJobRecord(legacy), true);
  const minimal = Object.fromEntries(['jobId', 'requestId', 'requestHash', 'status', 'createdAt'].map(k => [k, good[k]]));
  assert.equal(isValidJobRecord(minimal), false);
  for (const field of ['command', 'bytes', 'rawBytes', 'cleanup', 'audit', 'errorMessage', 'taskFileAccepted']) { const bad = { ...good }; delete bad[field]; assert.equal(isValidJobRecord(bad), false, field); }
  m.store.saveJob(minimal); m.releaseOwnership(); const next = new JobManager(cfg, runner); next.init();
  try { assert.equal(next.health().integrity.unreadableJobs.length, 1); assert.throws(() => next.status(sub.jobId), e => e.code === 'JOB_RECORD_UNREADABLE'); }
  finally { await next.shutdown(); }
});

for (const type of ['fake', 'production']) test(`R4-03 native offline stdio health redacts ${type} runner diagnostics without changing workspace paths`, async () => {
  const env = H.makeEnv('r4-health-' + type); const long = 'DUMMY_HEALTH_R4_826192'; const short = '短';
  const raw = { redaction: { extraLiteralSecrets: [long, short] }, runner: { type, fake: { argsPrefix: [H.FAKE_RUNNER, long, short] }, production: { extraArgs: [long, short] } } };
  const cfg = H.writeConfig(env, raw), b = await H.startBridge(cfg, env);
  try {
    const health = (await H.callTool(b.client, 'dsh_health')).payload;
    const text = JSON.stringify(health.runner); assert.equal(text.includes(long), false); assert.equal(text.includes(short), false); assert.equal(text.includes('***REDACTED***'), true);
    assert.equal(health.workspaces.find(w => w.workspaceId === 'impl').dir, env.impl);
    assert.deepEqual(health.capabilities.redaction.patternRules, REDACTION_PATTERN_NAMES);
  } finally { await b.close(); }
});

test('R4-04 pure Windows deny rules prune case-variant directories, filter snapshots and refuse include conflicts', () => {
  const env = H.makeEnv('r4-case-policy');
  const names = ['.ENV', 'Secrets.json', 'AUTH.JSON', 'ID_RSA', 'APP.PEM', 'Bridge.Config.JSON', 'Node_Modules/x.js', 'Reports/x.md', 'Dist/x.js', 'codex-audit-1.md'];
  for (const name of names) { const f = path.join(env.impl, name); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'excluded fake\n'); }
  fs.writeFileSync(path.join(env.impl, 'sample.example.json'), '{"safe":true}');
  const result = refreshSnapshot(env.impl, env.audit, { exclude: AUDIT_HARD_DENY, maxFiles: 100, maxBytes: 100000 });
  if (process.platform === 'win32') for (const n of names) assert.equal(fs.existsSync(path.join(env.audit, n)), false, n);
  assert.equal(fs.existsSync(path.join(env.audit, 'module.js')), true); assert.equal(fs.existsSync(path.join(env.audit, 'sample.example.json')), true);
  assert.equal(result.manifest.fileCount, result.copiedFiles);
  for (const include of ['.ENV', 'Secrets.json', 'NODE_MODULES/*.js', '**/*audit*.md']) {
    if (process.platform === 'win32') assert.throws(() => loadConfig(H.writeConfig(env, { audit: { include: [include] } })), e => e.code === 'CONFIG_INVALID', include);
  }
  const p = compilePolicy({ exclude: ['.env'] }); assert.equal(p.denies('.ENV', '.ENV'), process.platform === 'win32');
});

test('R4-05 pure JSON, nested/serialized strings and chunked capture redact credential values while keeping JSON readable', () => {
  const env = H.makeEnv('r4-json-redaction'); const r = new Redactor({}, {});
  for (const key of ['token', 'api_key', 'apiKey', 'client_secret', 'password', 'auth_token']) {
    for (const value of ['DUMMY_JSON_R4_736281', 'a', 'fake \\"quote\\" ending', 'fake "quote" ending', 'fake trailing \\']) {
      const json = JSON.stringify({ nested: { [key]: value } });
      const redacted = r.redact(json); assert.equal(JSON.parse(redacted).nested[key], '***REDACTED***');
      const serialized = JSON.stringify(json); const sanitized = r.redact(serialized);
      assert.equal(JSON.parse(JSON.parse(sanitized)).nested[key], '***REDACTED***');
    }
  }
  const dummy = 'DUMMY_SPLIT_JSON_R4_938472'; const json = JSON.stringify({ token: dummy }) + '\n';
  const log = path.join(env.logs, 'stdout.log'); const cap = new StreamCapture({ capBytes: 4096, redactor: r, logFile: log });
  for (const byte of Buffer.from(json)) cap.push(Buffer.from([byte])); cap.end();
  assert.equal(fs.readFileSync(log, 'utf8').includes(dummy), false); assert.equal(r.redact('api_key=DUMMY_ASSIGN_R4_82619').includes('DUMMY_ASSIGN_R4_82619'), false);
});

test('R4-05 native offline MCP result and stdout/stderr logs redact JSON while accepted task bytes remain unchanged', async () => {
  const env = H.makeEnv('r4-json-mcp'); const dummy = 'DUMMY_JSON_MCP_R4_823917';
  const taskText = JSON.stringify({ nested: { auth_token: dummy } }) + '\nFAKE_STDERR=' + JSON.stringify({ password: dummy }) + '\n';
  const task = H.writeTask(env, 'task.md', taskText); const b = await H.startBridge(H.writeConfig(env), env);
  try {
    const sub = (await H.callTool(b.client, 'dsh_submit', { requestId: 'r4-json', workspaceId: 'impl', mode: 'fix', taskFile: task })).payload;
    const job = await H.waitForTerminal(b.client, sub.jobId);
    const result = await H.callTool(b.client, 'dsh_result', { jobId: job.jobId }); assert.equal(JSON.stringify(result.payload).includes(dummy), false);
    assert.equal(fs.readFileSync(job.output.stdoutLog, 'utf8').includes(dummy), false); assert.equal(fs.readFileSync(job.output.stderrLog, 'utf8').includes(dummy), false);
    assert.equal(fs.readFileSync(job.task.acceptedCopy, 'utf8'), taskText);
  } finally { await b.close(); }
});

test('R4-06 native offline audit detects a newly created junction without following its target', async () => {
  const env = H.makeEnv('r4-audit-junction'); const fixture = path.join(env.dir, 'junction-child.mjs'); const link = path.join(env.audit, 'escape-junction');
  fs.writeFileSync(fixture, "import fs from 'node:fs'; import path from 'node:path'; fs.symlinkSync(process.env.R4_TARGET, path.join(process.cwd(),'escape-junction'), 'junction'); console.log('fake audit done');\n");
  fs.writeFileSync(path.join(env.impl, '.env'), 'DUMMY_EXCLUDED_R4=fiction\n'); const before = fs.readFileSync(path.join(env.impl, 'module.js'));
  const cfg = H.writeConfig(env, { runner: { fake: { argsPrefix: [fixture], env: { R4_TARGET: env.impl } } } }); const b = await H.startBridge(cfg, env);
  try {
    const task = H.writeTask(env, 'task.md', 'create only an isolated test junction\n');
    const sub = (await H.callTool(b.client, 'dsh_submit', { requestId: 'r4-junction', workspaceId: 'audit', mode: 'audit', taskFile: task })).payload;
    const job = await H.waitForTerminal(b.client, sub.jobId); assert.equal(job.status, 'failed'); assert.equal(job.error.code, 'AUDIT_UNDETECTED_INPUT');
    const report = H.readJson(job.audit.reportPath); assert.equal(report.undetectedInputs.includes('escape-junction'), true); assert.equal(report.postRunReparsePoints, 1); assert.equal(report.copyTimeSkippedReparsePoints, 0);
    assert.deepEqual(fs.readFileSync(path.join(env.impl, 'module.js')), before); assert.equal(fs.existsSync(path.join(env.impl, '.env')), true);
  } finally { await b.close(); if (fs.existsSync(link)) fs.unlinkSync(link); }
});

test('R4-08 injected stale stat cannot bypass bounded task reads; exact cap succeeds and cap+1 does not start', async () => {
  const env = H.makeEnv('r4-task-cap'); const cfg = loadConfig(H.writeConfig(env, { limits: { maxTaskFileBytes: 128 }, server: { logLevel: 'error' } }));
  const runner = new ImmediateRunner(); const m = new JobManager(cfg, runner); m.init(); const task = H.writeTask(env, 'task.md', 'x'.repeat(4096));
  const stat = fs.statSync;
  fs.statSync = (p, ...args) => { const s = stat(p, ...args); if (path.resolve(String(p)) === task) { const fake = Object.create(s); Object.defineProperty(fake, 'size', { value: 16 }); return fake; } return s; };
  try { await assert.rejects(m.submit({ requestId: 'cap-race', workspaceId: 'impl', mode: 'fix', taskFile: task }), e => e.code === 'TASK_FILE_TOO_LARGE'); assert.equal(runner.starts, 0); assert.equal(m.store.jobIds().length, 0); }
  finally { fs.statSync = stat; }
  try {
    fs.writeFileSync(task, 'x'.repeat(129)); await assert.rejects(m.submit({ requestId: 'too-big', workspaceId: 'impl', mode: 'fix', taskFile: task }), e => e.code === 'TASK_FILE_TOO_LARGE');
    fs.writeFileSync(task, 'x'.repeat(128)); const sub = await m.submit({ requestId: 'exact-cap', workspaceId: 'impl', mode: 'fix', taskFile: task }); await H.sleep(30); assert.equal(m.status(sub.jobId).task.bytes, 128); assert.equal(runner.starts, 1);
  } finally { await m.shutdown(); }
});

test('R4-08 native offline MCP refuses null/noninteger/out-of-range timeouts and accepts omitted/valid integer', async () => {
  const env = H.makeEnv('r4-timeouts'); const task = H.writeTask(env, 'task.md', 'FAKE_EXIT=0\n'); const b = await H.startBridge(H.writeConfig(env), env);
  try {
    for (const [i, value] of [null, 1.2, '30', 0, 61].entries()) {
      const err = await H.callToolExpectError(b.client, 'dsh_submit', { requestId: 'invalid-' + i, workspaceId: 'impl', mode: 'fix', taskFile: task, timeoutSeconds: value }); assert.equal(err.code, 'INVALID_TIMEOUT');
    }
    assert.equal(fs.readdirSync(path.join(env.state, 'jobs')).length, 0);
    for (const [i, value] of [undefined, 1].entries()) {
      const input = { requestId: 'valid-' + i, workspaceId: 'impl', mode: 'fix', taskFile: task }; if (value !== undefined) input.timeoutSeconds = value;
      const sub = (await H.callTool(b.client, 'dsh_submit', input)).payload; const job = await H.waitForTerminal(b.client, sub.jobId); assert.equal(job.timeoutSeconds, value ?? 30);
    }
  } finally { await b.close(); }
});

test('R4-07 native isolated quick-start copy builds, generates a confined config and runs all five tools with fake only', async () => {
  const env = H.makeEnv('r4-quickstart'); const sample = path.join(env.dir, 'clean-copy'); fs.mkdirSync(sample);
  for (const dir of ['src', 'config', 'fixtures', 'tools']) fs.cpSync(path.join(H.ROOT, dir), path.join(sample, dir), { recursive: true });
  for (const f of ['package.json', 'package-lock.json', 'tsconfig.json']) fs.copyFileSync(path.join(H.ROOT, f), path.join(sample, f));
  execFileSync(process.execPath, [path.join(H.ROOT, 'node_modules/typescript/bin/tsc'), '-p', path.join(sample, 'tsconfig.json')], { cwd: sample, windowsHide: true });
  execFileSync(process.execPath, ['tools/setup-selftest.mjs'], { cwd: sample, windowsHide: true });
  const file = path.join(sample, 'config/bridge.config.json'), cfg = loadConfig(file), runtime = path.join(sample, 'sandbox/selftest');
  for (const p of [cfg.stateDir, ...cfg.taskFileRoots, ...[...cfg.workspaces.values()].map(w => w.dir)]) assert.equal(p.startsWith(runtime + path.sep), true, p);
  assert.equal(cfg.runner.type, 'fake'); assert.equal(cfg.runner.fake.command, process.execPath);
  assert.throws(() => execFileSync(process.execPath, ['tools/setup-selftest.mjs'], { cwd: sample, windowsHide: true, stdio: 'pipe' }));
  const client = new Client({ name: 'r4-sample', version: '1' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(sample, 'dist/src/index.js'), '--config', file], cwd: sample, stderr: 'pipe' });
  await client.connect(transport);
  try {
    assert.equal((await client.listTools()).tools.length, 5); assert.equal((await H.callTool(client, 'dsh_health')).payload.runner.available, true);
    const sub = (await H.callTool(client, 'dsh_submit', { requestId: 'quickstart', workspaceId: 'impl', mode: 'implement', taskFile: path.join(runtime, 'tasks/demo.md') })).payload;
    const job = await H.waitForTerminal(client, sub.jobId); assert.equal(job.status, 'completed');
    assert.equal((await H.callTool(client, 'dsh_result', { jobId: job.jobId })).payload.page.output.includes('FAKE_DONE'), true);
    assert.equal((await H.callTool(client, 'dsh_cancel', { jobId: job.jobId })).payload.alreadyTerminal, true);
    assert.equal(cfg.runner.production.command, process.execPath);
  } finally { await client.close(); }
});
