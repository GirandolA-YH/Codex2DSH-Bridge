/**
 * FIX-001 R01 / R02 / R07 — offline, in-process regressions.
 *
 * R01: no known literal or supported credential pattern may reach the disk
 *      consumer, at any chunk split, for either stream.
 * R02: snapshot copy and snapshot manifest share one policy; denied material is
 *      never copied; every copied file is covered by change detection.
 * R07: incremental UTF-8 decoding and code-point pagination.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Redactor } from '../dist/src/redact.js';
import { StreamCapture, paginate } from '../dist/src/capture.js';
import { refreshSnapshot, checkStability, manifestOf } from '../dist/src/audit.js';
import { loadConfig } from '../dist/src/config.js';
import { BridgeError } from '../dist/src/errors.js';
import * as H from './helpers/harness.mjs';

const SECRET = 'FAKE-LITERAL-SECRET-0123456789ABCDEF';

function captureWith(env, redactor, name, capBytes = 1024 * 1024) {
  const logFile = path.join(env.dir, `${name}.log`);
  return { logFile, capture: new StreamCapture({ capBytes, redactor, logFile }) };
}

function windowsOf(text, size) {
  const windows = [];
  for (let index = 0; index + size <= text.length; index += 1) windows.push(text.slice(index, index + size));
  return windows;
}

test('R01 a configured literal can never be reassembled on disk at any split point', () => {
  const env = H.makeEnv('r01-splits');
  const payload = `prefix-${SECRET}-suffix`;
  const offsets = [1, 2, 7, 10, 15, 20, 24, 25, 26, payload.length - 1];
  for (const splitAt of offsets) {
    const { capture, logFile } = captureWith(env, new Redactor({}, { extraLiteralSecrets: [SECRET] }), `split-${splitAt}`);
    capture.push(Buffer.from(payload.slice(0, splitAt), 'utf8'));
    capture.push(Buffer.from(payload.slice(splitAt), 'utf8'));
    capture.end();
    const log = fs.readFileSync(logFile, 'utf8');
    assert.equal(log.includes(SECRET), false, `split ${splitAt} leaked the literal to disk`);
    for (const window of windowsOf(SECRET, 16)) {
      assert.equal(log.includes(window), false, `split ${splitAt} left a recoverable fragment ${window}`);
    }
    assert.equal(capture.text().includes(SECRET), false);
    assert.equal(capture.text(), log, 'in-memory text equals what was written');
  }
});

test('R01 one big chunk, many short chunks, stdout-style text and pattern keys', () => {
  const env = H.makeEnv('r01-shapes');
  const redactor = new Redactor(
    { PILOT_KEY: 'envSecretValue0123456789' },
    { extraSecretEnv: ['PILOT_KEY'], extraLiteralSecrets: [SECRET] },
  );

  const oneBig = captureWith(env, redactor, 'big');
  oneBig.capture.push(Buffer.from(`x`.repeat(8192) + SECRET + `y`.repeat(64), 'utf8'));
  oneBig.capture.end();
  const bigLog = fs.readFileSync(oneBig.logFile, 'utf8');
  assert.equal(bigLog.includes(SECRET), false);

  const manyShort = captureWith(env, redactor, 'short');
  for (const char of `start ${SECRET} end\n`) manyShort.capture.push(Buffer.from(char, 'utf8'));
  manyShort.capture.end();
  const shortLog = fs.readFileSync(manyShort.logFile, 'utf8');
  assert.equal(shortLog.includes(SECRET), false);
  assert.match(shortLog, /start \*\*\*REDACTED\*\*\* end/);

  const patterns = captureWith(env, redactor, 'patterns');
  patterns.capture.push(Buffer.from('api_key=sk-liveFAKE0123456789ABCDEF\n', 'utf8'));
  patterns.capture.push(Buffer.from('Authorization: Bearer FAKEBearerToken0123456789\n', 'utf8'));
  patterns.capture.push(Buffer.from('PILOT_KEY=envSecretValue0123456789\n', 'utf8'));
  patterns.capture.end();
  const patternLog = fs.readFileSync(patterns.logFile, 'utf8');
  for (const needle of [/sk-liveFAKE0123456789/, /FAKEBearerToken0123456789/, /envSecretValue0123456789/]) {
    assert.doesNotMatch(patternLog, needle);
  }
  assert.equal(patterns.capture.text(), patternLog);
});

test('R01 an unterminated line is buffered, not partially emitted, and flushes redacted', () => {
  const env = H.makeEnv('r01-pending');
  const redactor = new Redactor({}, { extraLiteralSecrets: [SECRET] });
  const { capture, logFile } = captureWith(env, redactor, 'pending');
  capture.push(Buffer.from(`no newline yet ${SECRET.slice(0, 12)}`, 'utf8'));
  assert.equal(fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').includes(SECRET.slice(0, 12)) : false, false);
  capture.push(Buffer.from(`${SECRET.slice(12)} still no newline`, 'utf8'));
  capture.end();
  const log = fs.readFileSync(logFile, 'utf8');
  assert.equal(log.includes(SECRET), false);
  assert.equal(log.includes(SECRET.slice(0, 12)), false, 'no partial prefix was emitted before the line closed');
});

test('R02 snapshot policy: copy and manifest share one rule set', () => {
  const env = H.makeEnv('r02-policy');
  const source = path.join(env.dir, 'source');
  const snapshot = path.join(env.dir, 'snapshot');
  for (const [rel, body] of [
    ['module.js', 'export const value = 1;\n'],
    ['src/deep/nested.js', 'export const deep = 2;\n'],
    ['.env', 'DEMO_VALUE=FAKE_ENV_CREDENTIAL_12345\n'],
    ['.dsh/sessions/old.json', '{"previousImplementation":"synthetic"}\n'],
    ['reports/codex-audit.md', 'Previous reviewer conclusions.\n'],
    ['config/bridge.config.real.json', '{"value":"FAKE_REAL_CONFIG"}\n'],
    ['notes.log', 'Synthetic old log.\n'],
    ['auth.json', '{"token":"synthetic"}\n'],
    ['certs/server.pem', '-----BEGIN CERTIFICATE-----\n'],
    ['node_modules/dep/index.js', 'module.exports = {};\n'],
  ]) {
    const file = path.join(source, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }

  const config = loadConfig(H.writeConfig(env, { __name: 'r02' }));
  const limits = { exclude: config.audit.exclude, include: config.audit.include, maxFiles: 1000, maxBytes: 1024 * 1024 };
  const result = refreshSnapshot(source, snapshot, limits);

  for (const forbidden of ['.env', '.dsh/sessions/old.json', 'reports/codex-audit.md', 'config/bridge.config.real.json', 'notes.log', 'auth.json', 'certs/server.pem', 'node_modules']) {
    assert.equal(fs.existsSync(path.join(snapshot, forbidden)), false, `${forbidden} reached the audit snapshot`);
  }
  assert.equal(fs.existsSync(path.join(snapshot, 'module.js')), true);
  assert.equal(fs.existsSync(path.join(snapshot, 'src/deep/nested.js')), true);

  const copied = new Set(result.copiedPaths);
  const hashed = new Set(result.manifest.files.map((file) => file.path));
  assert.deepEqual([...copied].sort(), [...hashed].sort(), 'copy set and manifest set are identical');
  assert.equal(result.policy.mode, 'deny-list');
  assert.ok(result.excludedByRule >= 8, `expected denied entries to be counted, saw ${result.excludedByRule}`);
});

test('R02 change detection covers every copied file (modify, add, delete)', () => {
  const env = H.makeEnv('r02-stability');
  const source = path.join(env.dir, 'source');
  const snapshot = path.join(env.dir, 'snapshot');
  fs.mkdirSync(path.join(source, 'src'), { recursive: true });
  fs.writeFileSync(path.join(source, 'module.js'), 'export const v = 1;\n');
  fs.writeFileSync(path.join(source, 'src', 'a.js'), 'export const a = 1;\n');
  const config = loadConfig(H.writeConfig(env, { __name: 'r02stability' }));
  const limits = { exclude: config.audit.exclude, include: config.audit.include, maxFiles: 1000, maxBytes: 1024 * 1024 };
  const before = refreshSnapshot(source, snapshot, limits).manifest;

  fs.writeFileSync(path.join(snapshot, 'module.js'), 'export const v = 2;\n');
  assert.equal(checkStability(before, snapshot, limits).diff.changed.includes('module.js'), true);

  fs.writeFileSync(path.join(snapshot, 'added.js'), 'export const added = 1;\n');
  assert.equal(checkStability(before, snapshot, limits).diff.added.includes('added.js'), true);

  fs.rmSync(path.join(snapshot, 'src', 'a.js'));
  assert.equal(checkStability(before, snapshot, limits).diff.removed.includes('src/a.js'), true);
  assert.equal(checkStability(before, snapshot, limits).stable, false);
});

test('R02 an explicit glob deny rule works in copy and manifest, and an empty policy is refused', () => {
  const env = H.makeEnv('r02-glob');
  const source = path.join(env.dir, 'source');
  const snapshot = path.join(env.dir, 'snapshot');
  fs.mkdirSync(path.join(source, 'keep'), { recursive: true });
  fs.mkdirSync(path.join(source, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(source, 'keep', 'a.js'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(source, 'reports', 'old.md'), 'old conclusions\n');
  fs.writeFileSync(path.join(source, 'trace.log'), 'log line\n');

  const limits = { exclude: ['**/reports/**', '*.log'], maxFiles: 100, maxBytes: 1024 * 1024 };
  const result = refreshSnapshot(source, snapshot, limits);
  assert.equal(fs.existsSync(path.join(snapshot, 'reports', 'old.md')), false);
  assert.equal(fs.existsSync(path.join(snapshot, 'trace.log')), false);
  assert.equal(fs.existsSync(path.join(snapshot, 'keep', 'a.js')), true);
  assert.deepEqual(result.copiedPaths, ['keep/a.js']);

  assert.throws(
    () => refreshSnapshot(source, path.join(env.dir, 'empty-snapshot'), { exclude: ['**/*'], maxFiles: 100, maxBytes: 1024 }),
    (error) => error instanceof BridgeError && error.code === 'SNAPSHOT_FAILED',
  );
});

test('R02 reparse points are skipped and reported, never followed', () => {
  const env = H.makeEnv('r02-reparse');
  const source = path.join(env.dir, 'source');
  const outside = path.join(env.dir, 'outside');
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(source, 'module.js'), 'export const v = 1;\n');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside\n');
  fs.symlinkSync(outside, path.join(source, 'escape'), 'junction');

  const result = refreshSnapshot(source, path.join(env.dir, 'snapshot'), { exclude: [], maxFiles: 100, maxBytes: 1024 * 1024 });
  assert.equal(result.skippedReparsePoints, 1);
  assert.equal(fs.existsSync(path.join(env.dir, 'snapshot', 'escape')), false);
  assert.deepEqual(result.copiedPaths, ['module.js']);
});

test('R07 incremental decoding keeps multi-byte characters intact at every byte boundary', () => {
  const env = H.makeEnv('r07-decode');
  const samples = ['中', '😀', 'é', '🀄'];
  for (const sample of samples) {
    const bytes = Buffer.from(sample, 'utf8');
    for (let split = 1; split < bytes.length; split += 1) {
      const { capture } = captureWith(env, new Redactor({}), `dec-${sample.codePointAt(0)}-${split}`);
      capture.push(bytes.subarray(0, split));
      capture.push(bytes.subarray(split));
      capture.end();
      assert.equal(capture.text(), sample, `${sample} broke at byte split ${split}`);
    }
    const { capture: chunked } = captureWith(env, new Redactor({}), `dec-chunk-${sample.codePointAt(0)}`);
    for (const byte of bytes) chunked.push(Buffer.from([byte]));
    chunked.end();
    assert.equal(chunked.text(), sample, `${sample} broke when fed byte by byte`);
  }

  const { capture: multi, logFile } = captureWith(env, new Redactor({}), 'dec-multi');
  const text = `A中😀B🀄C\n`;
  const bytes = Buffer.from(text, 'utf8');
  for (let index = 0; index < bytes.length; index += 3) multi.push(bytes.subarray(index, index + 3));
  multi.end();
  assert.equal(multi.text(), text);
  assert.equal(fs.readFileSync(logFile, 'utf8'), text);
});

test('R07 pagination never splits a code point and always advances', () => {
  const text = 'A😀B中C🀄D';
  const truncated = { stdout: false, stderr: false };
  const total = [...text].length;
  assert.equal(total, 7);

  for (const limit of [1, 2, 3, 4, 100]) {
    let offset = 0;
    let collected = '';
    for (let guard = 0; guard < 50; guard += 1) {
      const page = paginate(text, { stream: 'stdout', offset, limit }, 65536, truncated);
      assert.equal(page.output.isWellFormed(), true, `page produced an unpaired surrogate at offset ${offset}`);
      assert.ok(page.nextOffset > offset || offset === page.totalChars, 'pagination must advance');
      collected += page.output;
      offset = page.nextOffset;
      if (offset >= page.totalChars) break;
    }
    assert.equal(collected, text, `limit=${limit} lost or duplicated characters`);
  }

  const surrogateBoundary = paginate(text, { stream: 'stdout', offset: 1, limit: 1 }, 65536, truncated);
  assert.equal(surrogateBoundary.output, '😀');
  assert.equal(surrogateBoundary.nextOffset, 2);
  assert.equal(surrogateBoundary.offsetUnit, 'code-point');

  const byteCapped = paginate('中'.repeat(100), { stream: 'stdout', offset: 0, limit: 100 }, 7, truncated);
  assert.equal(byteCapped.pageBytes <= 7, true);
  assert.equal(byteCapped.output.isWellFormed(), true);

  const tooSmallBudget = [1, 2, 3];
  for (const budget of tooSmallBudget) {
    assert.throws(
      () => paginate('😀x', { stream: 'stdout', offset: 0, limit: 10 }, budget, truncated),
      (error) => error.code === 'INVALID_ARGUMENT',
      `budget ${budget} must be rejected instead of silently exceeded`,
    );
  }
  const minBudget = paginate('😀x', { stream: 'stdout', offset: 0, limit: 10 }, 4, truncated);
  assert.equal(minBudget.output, '😀');
  assert.equal(minBudget.pageBytes, 4);
  assert.equal(minBudget.pageBytes <= minBudget.maxPageBytes, true, 'the hard byte ceiling is never exceeded');
  assert.equal(minBudget.nextOffset, 1, 'one code point still advances the cursor');

  const tail = paginate(text, { stream: 'stdout', offset: total - 2, limit: 10 }, 65536, truncated);
  assert.equal(tail.output, '🀄D', 'last page is the exact remainder');
});

test('R07 invalid UTF-8 is replaced, never silently dropped', () => {
  const env = H.makeEnv('r07-invalid');
  const { capture } = captureWith(env, new Redactor({}), 'invalid');
  capture.push(Buffer.from([0x41, 0xff, 0xfe, 0x42]));
  capture.end();
  const text = capture.text();
  assert.match(text, /^A/);
  assert.match(text, /B$/);
  assert.equal(text.includes('\uFFFD'), true, 'invalid bytes are decoded as U+FFFD');
});

test('R02 manifests stay deterministic and a bare name rule is not a literal file name', () => {
  const env = H.makeEnv('r02-manifest');
  const dir = path.join(env.dir, 'tree');
  fs.mkdirSync(path.join(dir, 'nested', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.js'), 'a\n');
  fs.writeFileSync(path.join(dir, 'nested', 'logs', 'x.log'), 'log\n');
  fs.writeFileSync(path.join(dir, 'nested', 'keep.js'), 'keep\n');
  const options = { exclude: ['*.log', 'node_modules'] };
  const first = manifestOf(dir, { ...options, maxFiles: 100, maxBytes: 1024 * 1024 });
  const second = manifestOf(dir, { ...options, maxFiles: 100, maxBytes: 1024 * 1024 });
  assert.equal(first.digest, second.digest);
  assert.deepEqual(first.files.map((file) => file.path), ['a.js', 'nested/keep.js']);
});
