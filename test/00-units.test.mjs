/**
 * Unit layer: pure modules, no child processes. Runs in-process
 * (`node test/00-units.test.mjs`) and also under `npm test`.
 *
 * Covers the pieces that do not need a live MCP session: path containment,
 * redaction, manifest hashing, output capture limits and config validation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { assertWithinRoots, canonicalizeForCheck, isWithin } from '../dist/src/paths.js';
import { Redactor, REDACTION_PLACEHOLDER } from '../dist/src/redact.js';
import { buildManifest, diffManifests, sha256Hex } from '../dist/src/hashing.js';
import { StreamCapture, paginate, sliceUtf8 } from '../dist/src/capture.js';
import { loadConfig } from '../dist/src/config.js';
import { BridgeError } from '../dist/src/errors.js';
import * as H from './helpers/harness.mjs';

function expectCode(fn, code) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof BridgeError, `expected BridgeError, got ${String(error)}`);
    assert.equal(error.code, code);
    return error;
  }
  throw new Error(`expected ${code}`);
}

test('A08 path containment rejects traversal, prefix confusion and reparse escapes', () => {
  const env = H.makeEnv('unit-paths');
  const allowed = path.join(env.dir, 'roots', 'allowed');
  const allowedEvil = path.join(env.dir, 'roots', 'allowed-evil');
  fs.mkdirSync(allowed, { recursive: true });
  fs.mkdirSync(allowedEvil, { recursive: true });
  fs.writeFileSync(path.join(allowedEvil, 'x.txt'), 'evil\n');

  const roots = [allowed];
  const ok = assertWithinRoots(roots, path.join(allowed, 'nested', 'new.txt'), { label: 'taskFile' });
  assert.equal(path.basename(ok.path), 'new.txt');

  expectCode(() => assertWithinRoots(roots, path.join(allowed, '..', '..', 'outside', 'secret.txt'), { label: 'taskFile' }), 'PATH_NOT_ALLOWED');
  expectCode(() => assertWithinRoots(roots, path.join(allowedEvil, 'x.txt'), { label: 'taskFile' }), 'PATH_NOT_ALLOWED');
  expectCode(() => assertWithinRoots(roots, env.outside, { label: 'taskFile' }), 'PATH_NOT_ALLOWED');

  const link = path.join(allowed, 'escape-link');
  fs.symlinkSync(env.outside, link, 'junction');
  expectCode(() => assertWithinRoots(roots, path.join(link, 'secret.txt'), { label: 'taskFile' }), 'PATH_NOT_ALLOWED');

  assert.equal(isWithin('C:\\root', 'C:\\root-evil'), false);
  assert.equal(isWithin('C:\\root', 'C:\\root\\child'), true);
  assert.equal(isWithin('C:\\root', 'C:\\root'), true);

  const canonical = canonicalizeForCheck(path.join(allowed, 'nested', 'new.txt'));
  assert.equal(canonical.includes('..'), false);
});

test('A13 redaction removes keys, bearer tokens, assignments and configured literals', () => {
  const env = { PILOT_SECRET: 'literalSecretValue123' };
  const redactor = new Redactor(env, { extraSecretEnv: ['PILOT_SECRET'] });
  const text = [
    'api_key=sk-FAKEsecretVALUE0123456789',
    'Authorization: Bearer FAKEBearerTokenVALUE0123456789',
    'password: FAKEPasswordVALUE0123456789',
    'token = "FAKEQuotedTokenValue12345"',
    'https://user:FAKEBasicPass@example.invalid/x',
    'literalSecretValue123',
  ].join('\n');
  const redacted = redactor.redact(text);
  assert.doesNotMatch(redacted, /sk-FAKEsecretVALUE/);
  assert.doesNotMatch(redacted, /FAKEBearerTokenVALUE/);
  assert.doesNotMatch(redacted, /FAKEPasswordVALUE/);
  assert.doesNotMatch(redacted, /FAKEQuotedTokenValue/);
  assert.doesNotMatch(redacted, /FAKEBasicPass/);
  assert.doesNotMatch(redacted, /literalSecretValue123/);
  assert.match(redacted, new RegExp(REDACTION_PLACEHOLDER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  // A secret split across two stream writes must still be removed.
  let captured = '';
  const stream = redactor.createStream((chunk) => {
    captured += chunk;
  }, 64);
  stream.push('prefix sk-FAKEsec');
  stream.push('retVALUE0123456789 suffix');
  stream.flush();
  assert.doesNotMatch(captured, /sk-FAKEsecretVALUE0123456789/);
});

test('manifests are deterministic and diffs classify change/add/remove', () => {
  const env = H.makeEnv('unit-manifest');
  const dir = path.join(env.dir, 'tree');
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'b\n');
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'ignored.txt'), 'ignored\n');

  const options = { exclude: ['node_modules'] };
  const first = buildManifest(dir, options);
  const second = buildManifest(dir, options);
  assert.equal(first.digest, second.digest);
  assert.equal(first.fileCount, 2);
  assert.deepEqual(first.files.map((file) => file.path), ['a.txt', 'sub/b.txt']);

  fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
  fs.writeFileSync(path.join(dir, 'c.txt'), 'c\n');
  fs.rmSync(path.join(dir, 'sub', 'b.txt'));
  const third = buildManifest(dir, options);
  const diff = diffManifests(first, third);
  assert.equal(diff.same, false);
  assert.deepEqual(diff.changed, ['a.txt']);
  assert.deepEqual(diff.added, ['c.txt']);
  assert.deepEqual(diff.removed, ['sub/b.txt']);
  assert.equal(sha256Hex('abc').length, 64);
});

test('A12 capture caps stored bytes, keeps draining and paginates by characters', () => {
  const env = H.makeEnv('unit-capture');
  const logFile = path.join(env.dir, 'stdout.log');
  const cap = 1024;
  const redactor = new Redactor({}, {});
  const capture = new StreamCapture({ capBytes: cap, redactor, logFile });
  const chunk = Buffer.from('中'.repeat(4096), 'utf8');
  for (let index = 0; index < 8; index += 1) capture.push(chunk);
  capture.end();
  assert.equal(capture.rawBytes, chunk.length * 8);
  assert.ok(capture.storedBytes <= cap, `stored ${capture.storedBytes} > cap ${cap}`);
  assert.equal(capture.truncated, true);
  const stored = fs.readFileSync(logFile, 'utf8');
  assert.match(stored, /output truncated/);

  const text = 'x'.repeat(200000);
  const page = paginate(text, { stream: 'combined', offset: 0, limit: 4096 }, 65536, { stdout: false, stderr: false });
  assert.equal(page.pageBytes <= 65536, true);
  assert.equal(page.nextOffset, 4096);
  const tail = paginate(text, { stream: 'combined', offset: 199000, limit: 4096 }, 65536, { stdout: false, stderr: false });
  assert.equal(tail.output.length, 1000);

  const multibyte = '中'.repeat(100);
  const sliced = sliceUtf8(multibyte, 7);
  assert.equal(Buffer.byteLength(sliced, 'utf8') <= 7, true);
  assert.equal(sliced, '中中');
  const multibytePage = paginate(multibyte, { stream: 'stdout', offset: 1, limit: 10 }, 7, { stdout: false, stderr: false });
  assert.equal(multibytePage.pageBytes <= 7, true);
});

test('config validation rejects unsafe or unsupported shapes', () => {
  const env = H.makeEnv('unit-config');
  const base = () => JSON.parse(fs.readFileSync(H.writeConfig(env, { __name: 'unit' }), 'utf8'));
  const write = (mutate) => {
    const config = base();
    mutate(config);
    const file = path.join(env.dir, `bridge.config.${Math.random().toString(16).slice(2)}.json`);
    fs.writeFileSync(file, JSON.stringify(config, null, 2));
    return file;
  };

  expectCode(() => loadConfig(write((config) => delete config.workspaces)), 'CONFIG_INVALID');
  expectCode(
    () =>
      loadConfig(
        write((config) => {
          config.workspaces.audit.dir = config.workspaces.impl.dir;
        }),
      ),
    'CONFIG_INVALID',
  );
  expectCode(
    () =>
      loadConfig(
        write((config) => {
          config.workspaces.impl.allowedModes = ['audit'];
        }),
      ),
    'CONFIG_INVALID',
  );
  expectCode(
    () =>
      loadConfig(
        write((config) => {
          config.concurrency = { maxActiveJobs: 2 };
        }),
      ),
    'CONFIG_INVALID',
  );
  expectCode(
    () =>
      loadConfig(
        write((config) => {
          config.limits.maxTimeoutSeconds = 0;
        }),
      ),
    'CONFIG_INVALID',
  );
  expectCode(() => loadConfig(path.join(env.dir, 'missing.json')), 'CONFIG_INVALID');

  const loaded = loadConfig(write((config) => {}));
  assert.equal(loaded.runner.type, 'fake');
  assert.equal(loaded.workspaces.get('impl').allowedModes.includes('implement'), true);
  assert.equal(loaded.workspaces.get('audit').audit.sourceWorkspaceId, 'impl');
});
