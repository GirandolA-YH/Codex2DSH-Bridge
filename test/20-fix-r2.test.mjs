/**
 * R2 regressions (offline, in-process; no OS subprocess and no model call).
 *
 * R2-01: an `Authorization` header is redacted as header + scheme + credential
 *        for *any* scheme (Token, ApiKey, Digest, AWS4-HMAC-SHA256, unknown
 *        future schemes), case-insensitively and across a chunk split, while
 *        non-credential prose and the previously covered schemes are unchanged.
 * R2-02: the built-in audit deny set cannot be replaced by `audit.exclude`; it is
 *        merged, `audit.include` may not re-admit it, and copy/manifest stay in
 *        agreement.
 * R2-03: a non-UTF-8 task file is refused before acceptance, so the "frozen copy
 *        + hash" handoff holds: no runner start, no slot, no job id. Every
 *        accepted copy hashes to the recorded SHA-256.
 * R2-04: the error channel is redacted before disk and before return --
 *        `status.error.message`, the status/result bodies, `job.json`, audit
 *        findings and the FATAL path -- while error codes survive.
 * R2-05: the accepted timeout window is 1-3600 on the server, in both
 *        `loadConfig` and the direct `JobManager` path.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Redactor } from '../dist/src/redact.js';
import { refreshSnapshot } from '../dist/src/audit.js';
import { loadConfig, resolveAuditPolicy, AUDIT_HARD_DENY, TIMEOUT_RANGE_SECONDS } from '../dist/src/config.js';
import { JobManager } from '../dist/src/jobs.js';
import { TOOLS } from '../dist/src/mcp-server.js';
import { BridgeError } from '../dist/src/errors.js';
import * as H from './helpers/harness.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const SECRET = 'FAKE-R2-LITERAL-SECRET-0123456789ABCDEF';

/**
 * Assert that `action` fails with `code`. `JobManager.submit` is async (its
 * validation rejections surfaces as a rejected promise even for argument
 * errors), so the helper awaits the result and also accepts a synchronous throw.
 */
async function expectBridgeError(action, code) {
  let thrown = null;
  try {
    await action();
  } catch (error) {
    thrown = error;
  }
  assert.notEqual(thrown, null, `expected ${code}, but nothing was thrown`);
  assert.equal(thrown instanceof BridgeError, true, `expected a BridgeError, got ${thrown}`);
  assert.equal(thrown.code, code, `expected ${code}, got ${thrown.code}: ${thrown.message}`);
  return thrown;
}

/** A fixture with an in-process fake runner: nothing is spawned. */
function makeFixture(name, options = {}) {
  const dir = path.join(H.ROOT, 'test', '.tmp', 'r2fix', name);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const part of ['state', 'tasks', 'impl', 'source', 'snapshot', 'audit-report']) {
    fs.mkdirSync(path.join(dir, part), { recursive: true });
  }
  fs.writeFileSync(path.join(dir, 'source/code.txt'), 'neutral source\n');
  const raw = {
    server: { logLevel: 'error' },
    stateDir: path.join(dir, 'state'),
    taskFileRoots: [path.join(dir, 'tasks')],
    workspaces: {
      impl: { dir: path.join(dir, 'impl'), allowedModes: ['implement'] },
      source: { dir: path.join(dir, 'source'), allowedModes: ['fix'] },
      audit: {
        dir: path.join(dir, 'snapshot'),
        allowedModes: ['audit'],
        audit: { sourceWorkspaceId: 'source', reportDir: path.join(dir, 'audit-report') },
      },
    },
    runner: {
      type: 'fake',
      fake: { command: process.execPath, argsPrefix: [] },
      production: { command: process.execPath, argsPrefix: [], profile: 'headless' },
    },
    limits: {
      defaultTimeoutSeconds: 5,
      minTimeoutSeconds: 1,
      maxTimeoutSeconds: 3600,
      perStreamCaptureCapBytes: 512,
      resultPageMaxBytes: 64,
      ...(options.limits ?? {}),
    },
    cleanup: { confirmTimeoutMs: 100, killTimeoutMs: 100 },
    ...(options.audit ? { audit: options.audit } : {}),
    ...(options.redaction ? { redaction: options.redaction } : {}),
  };
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify(raw));
  const taskFile = path.join(dir, 'tasks/task.md');
  fs.writeFileSync(taskFile, 'offline fixture; no model, no production state\n');
  const cfg = loadConfig(configFile, options.env ?? {});
  const control = { starts: 0, kills: 0, events: null, alive: false, failWith: options.failWith ?? null };
  const runner = {
    type: 'fake',
    describe: () => ({ type: 'fake', available: true, diagnostic: null, commandTemplate: 'in-process offline fake', details: {} }),
    start(spec, events) {
      control.starts += 1;
      control.events = events;
      if (control.failWith !== null) {
        // SPAWN_FAILED is the ordinary error path, not external tampering.
        throw new Error(control.failWith);
      }
      control.alive = true;
      return {
        pid: undefined,
        child: null,
        command: ['<in-process>'],
        kill: async () => {
          control.kills += 1;
          control.alive = false;
          events.onExit(null, 'SIGTERM');
          return { method: 'offline-fake', killed: true, exited: true, detail: 'in-process fixture only' };
        },
      };
    },
  };
  const manager = new JobManager(cfg, runner);
  manager.init();
  return {
    dir,
    cfg,
    manager,
    control,
    taskFile,
    configFile,
    submit: (extra = {}) =>
      manager.submit({
        requestId: `${name}-req`,
        workspaceId: 'impl',
        mode: 'implement',
        taskFile,
        ...extra,
      }),
    submitAudit: (extra = {}) =>
      manager.submit({
        requestId: `${name}-audit-req`,
        workspaceId: 'audit',
        mode: 'audit',
        taskFile,
        ...extra,
      }),
    async finish() {
      if (control.alive) {
        control.alive = false;
        control.events.onExit(0, null);
      }
      await manager.shutdown();
    },
  };
}

/** Every byte stored under a directory, so a leak anywhere is visible. */
function allStateBytes(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) out.push({ file: abs, text: fs.readFileSync(abs, 'utf8') });
    }
  };
  walk(dir);
  return out;
}

// ---------------------------------------------------------------------------
// R2-01
// ---------------------------------------------------------------------------

test('R2-01 every Authorization scheme is redacted while the header stays readable', () => {
  const redactor = new Redactor({}, {});
  const credentials = {
    'Token': 'FAKE-Token-CREDENTIAL-0123456789',
    'ApiKey': 'FAKE-ApiKey-CREDENTIAL-0123456789',
    'Digest': 'username="auditor", response="FAKE-Digest-RESPONSE-0123456789"',
    'AWS4-HMAC-SHA256': 'Credential=FAKEAWSKEY/20260101, SignedHeaders=host, Signature=FAKEAWS',
    'Negotiate': 'FAKE-Unknown-Scheme-CREDENTIAL-0123456789',
    'DPoP': 'FAKE-DPoP-CREDENTIAL-0123456789',
  };
  for (const [scheme, credential] of Object.entries(credentials)) {
    const line = `Authorization: ${scheme} ${credential}\n`;
    const out = redactor.redact(line);
    assert.equal(out.includes('FAKE'), false, `${scheme} credential survived: ${out}`);
    assert.match(out, /^Authorization: /, `${scheme}: the header must stay readable`);
    assert.match(out, /\*\*\*REDACTED\*\*\*/);
    assert.equal(
      out.split('***REDACTED***').length - 1,
      1,
      `${scheme}: exactly one placeholder is expected, got ${JSON.stringify(out)}`,
    );
  }
});

test('R2-01 scheme matching is case-insensitive and the Bearer/Basic control group still works', () => {
  const redactor = new Redactor({}, {});
  for (const header of ['authorization:', 'AUTHORIZATION:', 'AuThOrIzAtIoN:']) {
    const out = redactor.redact(`${header} tOkEn FAKE-Case-Insensitive-0123456789\n`);
    assert.equal(out.includes('FAKE'), false, `${header} leaked`);
    assert.match(out, /\*\*\*REDACTED\*\*\*/);
  }
  const bearer = redactor.redact('Authorization: Bearer FAKEBearerToken0123456789\n');
  assert.equal(bearer.includes('FAKEBearerToken0123456789'), false);
  assert.match(bearer, /^Authorization: Bearer /);
  const basic = redactor.redact('Authorization: Basic RkFLRTpCQVNJQzEyMzQ1Njc4OQ==\n');
  assert.equal(basic.includes('RkFLRTpCQVNJQzEyMzQ1Njc4OQ=='), false);
  assert.match(basic, /^Authorization: Basic /);
  // A bare Bearer token without the header name stays covered by its own rule.
  assert.equal(redactor.redact('retry with Bearer FAKEBareBearer0123456789\n').includes('FAKEBareBearer0123456789'), false);
});

test('R2-01 a header split across chunks is still redacted (streaming buffer)', () => {
  const redactor = new Redactor({}, {});
  const line = 'Authorization: AWS4-HMAC-SHA256 Credential=FAKEAWSKEY/20260101, Signature=FAKESIGVALUE\n';
  for (let split = 1; split < line.length; split += 1) {
    const chunks = [];
    const stream = redactor.createStream((text) => chunks.push(text));
    stream.push(line.slice(0, split));
    stream.push(line.slice(split));
    stream.flush();
    const joined = chunks.join('');
    assert.equal(joined.includes('FAKE'), false, `split ${split} leaked: ${joined}`);
    assert.match(joined, /^Authorization: AWS4-HMAC-SHA256 /);
  }
});

test('R2-01 non-credential text is never rewritten by the Authorization rule', () => {
  const redactor = new Redactor({}, {});
  for (const text of [
    'the Authorization header was missing from the request\n',
    'Authorization:\n',
    'Authorization: none\n',
    'a normal token word appears in prose here\n',
    'the token budget is exhausted\n',
    'token: short\n',
  ]) {
    assert.equal(redactor.redact(text), text, `innocent line was rewritten: ${text}`);
  }
});

// ---------------------------------------------------------------------------
// R2-02
// ---------------------------------------------------------------------------

test('R2-02 audit.exclude extends the built-in deny set instead of replacing it', () => {
  const env = H.makeEnv('r2-hard-deny');
  const source = path.join(env.dir, 'source');
  const snapshot = path.join(env.dir, 'snapshot');
  const add = (rel, body) => {
    const file = path.join(source, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  };
  add('module.js', 'export const value = 1;\n');
  add('requirements.md', 'deliverable requirements\n');
  add('src/deep/impl.js', 'export const deep = 2;\n');
  add('.env', 'DEMO_VALUE=FAKE_ENV_CREDENTIAL_12345\n');
  add('credential-store.json', '{"token":"synthetic"}\n');
  add('OLD-AUDIT.md', 'previous reviewer conclusions\n');
  add('node_modules/dep/index.js', 'module.exports = {};\n');

  const configPath = H.writeConfig(env, { __name: 'r2-hard-deny', audit: { exclude: ['node_modules'] } });
  const config = loadConfig(configPath);
  // The operator's entry is present and the built-in set is still in force.
  assert.equal(config.audit.exclude.includes('node_modules'), true);
  for (const pattern of ['.env', '**/*AUDIT*.md', '**/*credential*']) {
    assert.equal(config.audit.exclude.includes(pattern), true, `${pattern} was dropped from the deny set`);
  }

  const result = refreshSnapshot(source, snapshot, {
    include: config.audit.include,
    exclude: config.audit.exclude,
    maxFiles: 1000,
    maxBytes: 1024 * 1024,
  });
  for (const forbidden of ['.env', 'credential-store.json', 'OLD-AUDIT.md', 'node_modules']) {
    assert.equal(fs.existsSync(path.join(snapshot, forbidden)), false, `${forbidden} reached the snapshot`);
    assert.equal(
      result.copiedPaths.some((rel) => rel === forbidden || rel.startsWith(`${forbidden}/`)),
      false,
      `${forbidden} was copied`,
    );
  }
  // Legitimate deliverables are still fully visible, and copy == manifest.
  assert.deepEqual([...result.copiedPaths].sort(), ['module.js', 'requirements.md', 'src/deep/impl.js']);
  assert.deepEqual(
    [...result.manifest.files.map((file) => file.path)].sort(),
    [...result.copiedPaths].sort(),
    'copy set and manifest set must agree',
  );
});

test('R2-02 audit.include cannot re-admit hard-denied material, and non-conflicting includes load', async () => {
  const env = H.makeEnv('r2-include-conflict');
  const conflicting = [
    ['.env'],
    ['**/*AUDIT*.md'],
    ['**/*.pem'],
    ['**/*'],
    ['node_modules', 'src/**'],
  ];
  for (const include of conflicting) {
    const file = H.writeConfig(env, { __name: `conflict-${Math.random().toString(16).slice(2)}`, audit: { include } });
    await expectBridgeError(() => loadConfig(file), 'CONFIG_INVALID');
  }
  // An allowlist that does not touch hard-denied material still loads and still
  // passes every hard-deny rule through to the snapshot.
  const ok = loadConfig(H.writeConfig(env, { __name: 'include-ok', audit: { include: ['src/**', '*.md'] } }));
  assert.deepEqual(ok.audit.include, ['src/**', '*.md']);
  const policy = resolveAuditPolicy({ include: ok.audit.include, exclude: [] });
  assert.deepEqual(policy.exclude, [...AUDIT_HARD_DENY]);
  // The default policy (no audit block at all) is unchanged.
  const defaults = loadConfig(H.writeConfig(env, { __name: 'defaults' }));
  assert.deepEqual(defaults.audit.exclude, [...AUDIT_HARD_DENY]);
  assert.deepEqual(defaults.audit.include, []);
});

test('R2-02 the effective audit policy reaches the job record and the snapshot findings', async () => {
  const fx = makeFixture('r2-audit-record', { audit: { exclude: ['node_modules'], maxSnapshotFiles: 20000, maxSnapshotBytes: 512 * 1024 * 1024 } });
  try {
    const ack = await fx.submitAudit();
    await tick();
    assert.notEqual(fx.control.events, null, 'the audit runner must have started');
    fx.control.events.onStdout(Buffer.from('audit notes\n'));
    fx.control.events.onExit(0, null);
    fx.control.alive = false;
    await tick();

    const view = fx.manager.status(ack.jobId);
    assert.equal(view.audit.policy.exclude.includes('node_modules'), true);
    assert.equal(view.audit.policy.exclude.includes('.env'), true, 'the record must show the policy that actually ran');
    assert.equal(view.audit.policy.exclude.includes('**/*AUDIT*.md'), true);
    assert.equal(view.audit.findings.length > 0, true);
  } finally {
    await fx.finish();
  }
});

// ---------------------------------------------------------------------------
// R2-03
// ---------------------------------------------------------------------------

test('R2-03 a GBK task file is refused before acceptance and no runner is started', async () => {
  const fx = makeFixture('r2-gbk');
  try {
    const gbk = path.join(fx.dir, 'tasks/gbk.md');
    // 0xC4 0xE3 0xBA 0xC3 is "你好" in GBK: not valid UTF-8.
    fs.writeFileSync(gbk, Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x0a]));
    const error = await expectBridgeError(() => fx.manager.submit({ requestId: 'gbk-req', workspaceId: 'impl', mode: 'implement', taskFile: gbk }), 'TASK_FILE_NOT_UTF8');
    assert.equal(error.message.includes('\uFFFD'), false, 'the rejection must not quote re-encoded bytes');
    assert.equal(fx.control.starts, 0, 'a rejected task must not start the runner');
    assert.equal(fx.manager.activeJobId, null, 'a rejected task must not occupy the execution slot');
    // No job directory and no request index entry were created.
    const jobs = fs.existsSync(path.join(fx.dir, 'state', 'jobs')) ? fs.readdirSync(path.join(fx.dir, 'state', 'jobs')) : [];
    assert.deepEqual(jobs, [], 'a rejected task must not consume a job');
    const requests = fs.existsSync(path.join(fx.dir, 'state', 'requests')) ? fs.readdirSync(path.join(fx.dir, 'state', 'requests')) : [];
    assert.deepEqual(requests, [], 'a rejected task must not be recorded as accepted');

    // The submission slot is still usable afterwards.
    const ack = await fx.submit({ requestId: 'after-reject' });
    assert.equal(ack.accepted, true);
    await tick();
    assert.equal(fx.control.starts, 1, 'the accepted task does start the runner');
  } finally {
    await fx.finish();
  }
});

test('R2-03 malformed UTF-8 sequences are refused: truncated multi-byte, lone continuation, overlong', async () => {
  const fx = makeFixture('r2-invalid-utf8');
  try {
    const cases = {
      'truncated-multibyte.md': Buffer.from([0xe4, 0xbd]), // first 2 bytes of 你
      'lone-continuation.md': Buffer.from([0x80, 0x81, 0x0a]),
      'overlong.md': Buffer.from([0xc0, 0xaf, 0x0a]),
      'utf16le.md': Buffer.from('\ufeffhello\n', 'utf16le'),
    };
    for (const [name, bytes] of Object.entries(cases)) {
      const file = path.join(fx.dir, 'tasks', name);
      fs.writeFileSync(file, bytes);
      await expectBridgeError(
        () => fx.manager.submit({ requestId: `bad-${name}`, workspaceId: 'impl', mode: 'implement', taskFile: file }),
        'TASK_FILE_NOT_UTF8',
      );
    }
    assert.equal(fx.control.starts, 0);
    assert.equal(fx.manager.activeJobId, null);
  } finally {
    await fx.finish();
  }
});

test('R2-03 an accepted copy always hashes to the recorded SHA-256 (inline, pointer, BOM, Chinese)', async () => {
  const cases = [
    { name: 'inline', content: 'simple ASCII task\n', chars: null },
    { name: 'chinese', content: '中文任务：修复缺陷。\n', chars: null },
    { name: 'bom', content: '\ufefftask with BOM\n', chars: null },
    { name: 'pointer', content: `${'中文任务内容。'.repeat(4000)}\n`, chars: 64 },
  ];
  for (const entry of cases) {
    const fx = makeFixture(`r2-accepted-${entry.name}`, entry.chars === null ? {} : { limits: { inlineTaskMaxChars: entry.chars } });
    try {
      const file = path.join(fx.dir, 'tasks', `${entry.name}.md`);
      fs.writeFileSync(file, entry.content, 'utf8');
      const original = fs.readFileSync(file);
      const originalSha = createHash('sha256').update(original).digest('hex');
      const ack = await fx.submit({ requestId: `accepted-${entry.name}`, taskFile: file });
      const view = fx.manager.status(ack.jobId);
      assert.equal(view.task.sha256, originalSha, `${entry.name}: the record must describe the accepted bytes`);
      assert.equal(view.task.bytes, original.length, `${entry.name}: recorded byte count must match`);
      const accepted = fs.readFileSync(view.task.acceptedCopy);
      assert.equal(createHash('sha256').update(accepted).digest('hex'), view.task.sha256, `${entry.name}: acceptedCopy hash must match the record`);
      assert.equal(accepted.equals(original), true, `${entry.name}: the accepted copy must be byte-identical to the input`);
      assert.equal(
        view.task.promptKind,
        entry.chars === null || entry.content.length <= entry.chars ? 'inline' : 'pointer',
        `${entry.name}: handoff path must be the expected one`,
      );
      if (view.task.promptKind === 'pointer') {
        assert.equal(view.task.taskArgSha256 !== view.task.sha256, true, 'the pointer arg is not the task itself');
      }
    } finally {
      await fx.finish();
    }
  }
});

test('R2-03 a legal UTF-8 file with a BOM is accepted, never silently re-encoded', async () => {
  const fx = makeFixture('r2-bom-accepted');
  try {
    const file = path.join(fx.dir, 'tasks', 'bom.md');
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('任务\n', 'utf8')]);
    fs.writeFileSync(file, bytes);
    const ack = await fx.submit({ requestId: 'bom-req', taskFile: file });
    const view = fx.manager.status(ack.jobId);
    assert.equal(view.task.bytes, bytes.length, 'the BOM is part of the accepted bytes');
    assert.equal(fs.readFileSync(view.task.acceptedCopy).equals(bytes), true);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), view.task.sha256);
  } finally {
    await fx.finish();
  }
});

// ---------------------------------------------------------------------------
// R2-04
// ---------------------------------------------------------------------------

test('R2-04 a SPAWN_FAILED message keeps its code and context but loses configured values', async () => {
  const fx = makeFixture('r2-error-leak', {
    redaction: { extraLiteralSecrets: [SECRET] },
    failWith: `spawn failed for ${SECRET} (Authorization: Token ${SECRET}) in stage launch`,
  });
  try {
    const ack = await fx.submit();
    await tick();
    await tick();
    const view = fx.manager.status(ack.jobId);
    assert.equal(view.status, 'failed');
    assert.equal(view.error.code, 'SPAWN_FAILED', 'the error code must stay readable');
    assert.equal(view.error.message.includes(SECRET), false, `status leaked the literal: ${view.error.message}`);
    assert.equal(view.error.message.includes('***REDACTED***'), true, 'the message must show the redaction happened');
    assert.match(view.error.message, /stage launch/, 'non-secret context must survive');
    assert.match(view.error.message, /spawn failed for/, 'the reason must survive');

    // The result body and the persisted record agree with the status view.
    const result = fx.manager.result(ack.jobId, { stream: 'combined' });
    assert.equal(JSON.stringify(result).includes(SECRET), false, 'result body leaked the literal');

    const jobFile = path.join(fx.dir, 'state', 'jobs', ack.jobId, 'job.json');
    const record = H.readJson(jobFile);
    assert.equal(record.errorCode, 'SPAWN_FAILED');
    assert.equal(record.errorMessage.includes(SECRET), false, `job.json leaked the literal: ${record.errorMessage}`);

    for (const { file, text } of allStateBytes(path.join(fx.dir, 'state'))) {
      assert.equal(text.includes(SECRET), false, `${file} contains the configured literal`);
    }
  } finally {
    await fx.finish();
  }
});

test('R2-04 a failed audit job redacts findings in the view, the record and the audit report', async () => {
  const fx = makeFixture('r2-audit-findings-leak', { redaction: { extraLiteralSecrets: [SECRET] } });
  try {
    const ack = await fx.submitAudit();
    await tick();
    assert.notEqual(fx.control.events, null);
    // Produce a real finding whose text embeds the configured literal.
    fs.writeFileSync(path.join(fx.dir, 'source', 'code.txt'), `${SECRET}\n`);
    fx.control.events.onStdout(Buffer.from('audit output\n'));
    fx.control.events.onExit(0, null);
    fx.control.alive = false;
    await tick();

    const view = fx.manager.status(ack.jobId);
    assert.equal(view.audit.findings.length > 0, true, 'the audit must report a finding');
    assert.equal(JSON.stringify(view.audit.findings).includes(SECRET), false, 'findings leaked the literal');
    assert.equal(view.error === null || view.error.message.includes(SECRET) === false, true);
    const reportFile = path.join(fx.dir, 'audit-report', `${ack.jobId}.audit.json`);
    assert.equal(fs.existsSync(reportFile), true, 'the audit envelope must exist');
    assert.equal(fs.readFileSync(reportFile, 'utf8').includes(SECRET), false, 'the audit envelope leaked the literal');
  } finally {
    await fx.finish();
  }
});

test('R2-04 the logger redacts nested diagnostic fields, not just top-level strings', async () => {
  const lines = [];
  const { Logger } = await import('../dist/src/logging.js');
  const logger = new Logger('debug', new Redactor({}, { extraLiteralSecrets: [SECRET] }), (line) => lines.push(line));
  logger.error('job finished', {
    jobId: 'job-abcdef0123',
    error: { code: 'SPAWN_FAILED', message: `outer ${SECRET}`, nested: { deeper: [`list ${SECRET}`] } },
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].includes(SECRET), false, `logger leaked the literal: ${lines[0]}`);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.error.code, 'SPAWN_FAILED', 'the nested code must survive');
  assert.match(parsed.error.nested.deeper[0], /\*\*\*REDACTED\*\*\*/);
});

// ---------------------------------------------------------------------------
// R2-05
// ---------------------------------------------------------------------------

test('R2-05 the MCP schema and the server agree on the timeout window', () => {
  const submit = TOOLS.find((tool) => tool.name === 'dsh_submit');
  const schema = submit.inputSchema.properties.timeoutSeconds;
  assert.equal(schema.minimum, TIMEOUT_RANGE_SECONDS.min);
  assert.equal(schema.maximum, TIMEOUT_RANGE_SECONDS.max);
});

test('R2-05 loadConfig refuses a limits block that cannot be expressed inside 1-3600', async () => {
  const env = H.makeEnv('r2-timeout-config');
  const write = (mutate) => {
    const file = H.writeConfig(env, { __name: `limits-${Math.random().toString(16).slice(2)}` });
    const raw = H.readJson(file);
    mutate(raw);
    // writeConfig merges deeply, so mutate the parsed file and rewrite it.
    fs.writeFileSync(file, JSON.stringify(raw, null, 2));
    return file;
  };
  // Accepted: the schema boundaries and the shipped default.
  for (const limits of [
    { minTimeoutSeconds: 1, maxTimeoutSeconds: 3600, defaultTimeoutSeconds: 3600 },
    { minTimeoutSeconds: 1, maxTimeoutSeconds: 3600, defaultTimeoutSeconds: 1 },
    { minTimeoutSeconds: 600, maxTimeoutSeconds: 1200, defaultTimeoutSeconds: 900 },
  ]) {
    const cfg = loadConfig(write((raw) => Object.assign(raw.limits, limits)));
    assert.equal(cfg.limits.minTimeoutSeconds >= 1, true);
    assert.equal(cfg.limits.maxTimeoutSeconds <= 3600, true);
  }
  // Refused: out of range, inconsistent, zero, negative, fractional.
  const refused = [
    (raw) => { raw.limits.maxTimeoutSeconds = 9000; },
    (raw) => { raw.limits.maxTimeoutSeconds = 3601; },
    (raw) => { raw.limits.minTimeoutSeconds = 0; },
    (raw) => { raw.limits.defaultTimeoutSeconds = 0; },
    (raw) => { raw.limits.minTimeoutSeconds = -1; },
    (raw) => { raw.limits.defaultTimeoutSeconds = 1.5; },
    (raw) => { raw.limits.maxTimeoutSeconds = 2.5; },
    (raw) => { raw.limits.minTimeoutSeconds = 5; raw.limits.maxTimeoutSeconds = 60; raw.limits.defaultTimeoutSeconds = 2; },
    (raw) => { raw.limits.minTimeoutSeconds = 120; raw.limits.maxTimeoutSeconds = 60; raw.limits.defaultTimeoutSeconds = 60; },
  ];
  for (const mutate of refused) {
    await expectBridgeError(() => loadConfig(write(mutate)), 'CONFIG_INVALID');
  }
});

test('R2-05 JobManager enforces 1-3600 on the direct path, without starting a runner', async () => {
  const fx = makeFixture('r2-timeout-manager');
  try {
    for (const value of [0, -5, 1.5, 3601, 9000, Number.NaN, '600']) {
      await expectBridgeError(
        () => fx.manager.submit({ requestId: `t-${String(value)}`, workspaceId: 'impl', mode: 'implement', taskFile: fx.taskFile, timeoutSeconds: value }),
        'INVALID_TIMEOUT',
      );
    }
    assert.equal(fx.control.starts, 0, 'a refused timeout must not start the runner');
    assert.equal(fx.manager.activeJobId, null);
    for (const value of [1, 3600]) {
      const ack = await fx.submit({ requestId: `ok-${value}`, timeoutSeconds: value });
      const view = fx.manager.status(ack.jobId);
      assert.equal(view.timeoutSeconds, value);
      // Finish the accepted job before the next submission (one slot only).
      await tick();
      fx.control.events.onExit(0, null);
      fx.control.alive = false;
      await tick();
      assert.equal(fx.manager.activeJobId, null);
    }
    // A hand-built config that bypasses loadConfig cannot widen the window.
    // The fixture's own manager already owns the state directory, so its limits
    // object is the honest way to express "an embedder passed 90000".
    const originalLimits = fx.cfg.limits;
    fx.cfg.limits = { ...originalLimits, minTimeoutSeconds: 1, maxTimeoutSeconds: 90_000, defaultTimeoutSeconds: 1800 };
    try {
      assert.equal(fx.cfg.limits.maxTimeoutSeconds, 90_000);
      await expectBridgeError(
        () => fx.manager.submit({ requestId: 'wide-1', workspaceId: 'impl', mode: 'implement', taskFile: fx.taskFile, timeoutSeconds: 3601 }),
        'INVALID_TIMEOUT',
      );
      await expectBridgeError(
        () => fx.manager.submit({ requestId: 'wide-2', workspaceId: 'impl', mode: 'implement', taskFile: fx.taskFile, timeoutSeconds: 3600 + 1 }),
        'INVALID_TIMEOUT',
      );
      assert.equal(fx.control.starts, 2, 'no runner may be started for an out-of-window timeout');
      assert.equal(fx.manager.activeJobId, null);
    } finally {
      fx.cfg.limits = originalLimits;
    }
  } finally {
    await fx.finish();
  }
});
