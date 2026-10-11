/**
 * FIX-002 F2-01 (safe truncation) and F2-05 (hard byte budget) regressions.
 *
 * F2-01: once stream data has been discarded, the retained *incomplete* line can
 * no longer be proven free of a known literal, so it is never written. Only
 * complete lines that were flushed before the cap reach the log, plus one
 * standalone truncation note.
 *
 * F2-05: the per-page byte ceiling is hard. Budgets below the largest UTF-8 code
 * point (4 bytes) are rejected at configuration load and by `paginate`, so
 * forward progress never has to be bought with an over-budget page.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Redactor } from '../dist/src/redact.js';
import { StreamCapture, paginate, truncationMarker, stripTruncationMarkers, MAX_CODE_POINT_BYTES } from '../dist/src/capture.js';
import { loadConfig } from '../dist/src/config.js';
import { BridgeError } from '../dist/src/errors.js';
import * as H from './helpers/harness.mjs';

const SECRET = 'SYNTHETIC-KNOWN-CREDENTIAL-0123456789';

function newCapture(env, name, capBytes, redactor = new Redactor({}, { extraLiteralSecrets: [SECRET] })) {
  const logFile = path.join(env.dir, `${name}.log`);
  return { logFile, capture: new StreamCapture({ capBytes, logFile, redactor }) };
}

function assertNoFragment(text, label) {
  assert.equal(text.includes(SECRET), false, `${label}: the full literal reached the log`);
  for (let index = 0; index + 12 <= SECRET.length; index += 1) {
    const window = SECRET.slice(index, index + 12);
    assert.equal(text.includes(window), false, `${label}: recoverable fragment ${window} reached the log`);
  }
}

test('F2-01 a credential prefix retained at the cap is never written', () => {
  const env = H.makeEnv('f2-01-cap');
  const prefix = SECRET.slice(0, 20);
  const capBytes = 128;
  const { capture, logFile } = newCapture(env, 'cap', capBytes);
  capture.push(Buffer.from('x'.repeat(capBytes - prefix.length) + prefix));
  capture.push(Buffer.from(SECRET.slice(prefix.length) + '\n'));
  capture.end();
  const disk = fs.readFileSync(logFile, 'utf8');
  assertNoFragment(disk, 'truncated log');
  assert.equal(capture.text().includes(prefix), false, 'the retained prefix is not in the captured text either');
  assert.equal(capture.truncated, true);
  assert.equal(capture.droppedBytes > 0, true, 'discarded bytes are counted');
  assert.match(disk, /output truncated/, 'a standalone truncation note explains the loss');
  assert.equal(stripTruncationMarkers(disk).includes(prefix), false);
});

test('F2-01 every cap-crossing offset and chunk shape stays safe', () => {
  const env = H.makeEnv('f2-01-offsets');
  const capBytes = 96;
  for (const secretAt of [0, 1, 7, 20, 60, 90, 95, 120]) {
    for (const mode of ['single', 'split-at-secret', 'byte-by-byte']) {
      const payload = `${'p'.repeat(secretAt)}${SECRET}${'s'.repeat(40)}\n`;
      const { capture, logFile } = newCapture(env, `off-${secretAt}-${mode}`, capBytes);
      if (mode === 'single') {
        capture.push(Buffer.from(payload));
      } else if (mode === 'split-at-secret') {
        const cut = secretAt + 7;
        capture.push(Buffer.from(payload.slice(0, cut)));
        capture.push(Buffer.from(payload.slice(cut)));
      } else {
        for (const byte of Buffer.from(payload)) capture.push(Buffer.from([byte]));
      }
      capture.end();
      assertNoFragment(fs.readFileSync(logFile, 'utf8'), `offset ${secretAt}/${mode}`);
      assertNoFragment(capture.text(), `captured text ${secretAt}/${mode}`);
    }
  }
});

test('F2-01 a newline inside the discarded region cannot expose the retained prefix', () => {
  const env = H.makeEnv('f2-01-dropped-newline');
  const capBytes = 64;
  const prefix = SECRET.slice(0, 24);
  const { capture, logFile } = newCapture(env, 'dropped', capBytes);
  capture.push(Buffer.from('a'.repeat(capBytes - prefix.length) + prefix));
  capture.push(Buffer.from(`${SECRET.slice(prefix.length)}\nmore lines after the cap\n`));
  capture.end();
  const disk = fs.readFileSync(logFile, 'utf8');
  assertNoFragment(disk, 'log with newline in the dropped region');
  assert.equal(capture.truncated, true);
  assert.equal(disk.includes('more lines after the cap'), false, 'data after the cap is never written');
});

test('F2-01 complete lines before the cap are kept, and one huge chunk is bounded', () => {
  const env = H.makeEnv('f2-01-bounded');
  const capBytes = 256;
  const { capture, logFile } = newCapture(env, 'lines', capBytes);
  capture.push(Buffer.from('kept line one\nkept line two\n'));
  // A single chunk far larger than the cap must be bounded, not decoded whole.
  const huge = Buffer.from(`${SECRET}${'z'.repeat(5 * 1024 * 1024)}\n`);
  capture.push(huge);
  capture.end();
  const disk = fs.readFileSync(logFile, 'utf8');
  assert.match(disk, /kept line one/, 'complete lines before the cap are retained');
  assertNoFragment(disk, 'log after a huge chunk');
  assert.equal(capture.storedBytes <= capBytes, true, `stored ${capture.storedBytes} exceeded cap ${capBytes}`);
  assert.equal(capture.truncated, true);
  assert.equal(capture.rawBytes, huge.length + 'kept line one\nkept line two\n'.length);
});

test('F2-01 a stream with no line break keeps nothing, and normal EOF still flushes', () => {
  const env = H.makeEnv('f2-01-eof');
  const noNewline = newCapture(env, 'nonewline', 128, new Redactor({}, {}));
  noNewline.capture.push(Buffer.from('x'.repeat(4096)));
  noNewline.capture.end();
  const disk = fs.readFileSync(noNewline.logFile, 'utf8');
  assert.equal(noNewline.capture.storedBytes, 0, 'an unterminated, truncated line is discarded entirely');
  assert.match(disk, /output truncated/);

  const eof = newCapture(env, 'eof', 4096, new Redactor({}, {}));
  eof.capture.push(Buffer.from('line one\nlast line without newline'));
  eof.capture.end();
  assert.equal(eof.capture.text(), 'line one\nlast line without newline');
  assert.equal(eof.capture.truncated, false);

  const unterminated = newCapture(env, 'unterminated', 4096);
  unterminated.capture.push(Buffer.from(`ok\n${SECRET}`));
  unterminated.capture.end();
  const eofLog = fs.readFileSync(unterminated.logFile, 'utf8');
  assert.equal(eofLog.includes(SECRET), false, 'EOF flushes the final line redacted');
  assert.match(eofLog, /\*\*\*REDACTED\*\*\*/);
  assert.equal(unterminated.capture.truncated, false, 'nothing was discarded, so nothing is truncated');
});

test('F2-01 stdout and stderr are captured independently under the same rules', () => {
  const env = H.makeEnv('f2-01-streams');
  const redactor = new Redactor({}, { extraLiteralSecrets: [SECRET] });
  const out = newCapture(env, 'out', 64, redactor);
  const err = newCapture(env, 'err', 64, redactor);
  out.capture.push(Buffer.from('o'.repeat(50) + SECRET.slice(0, 20)));
  out.capture.push(Buffer.from(SECRET.slice(20) + '\n'));
  err.capture.push(Buffer.from('e'.repeat(50) + SECRET.slice(0, 20)));
  err.capture.push(Buffer.from(SECRET.slice(20) + '\n'));
  out.capture.end();
  err.capture.end();
  assertNoFragment(fs.readFileSync(out.logFile, 'utf8'), 'stdout log');
  assertNoFragment(fs.readFileSync(err.logFile, 'utf8'), 'stderr log');
  assert.equal(truncationMarker(64, 1).includes('output truncated'), true);
});

test('F2-05 budgets below the largest code point are rejected at load', () => {
  const env = H.makeEnv('f2-05-config');
  const write = (budget) => {
    const config = JSON.parse(fs.readFileSync(H.writeConfig(env, { __name: `f205-${budget}` }), 'utf8'));
    config.limits = { ...config.limits, resultPageMaxBytes: budget };
    const file = path.join(env.dir, `config-${budget}.json`);
    fs.writeFileSync(file, JSON.stringify(config, null, 2));
    return file;
  };
  for (const budget of [1, 2, 3]) {
    assert.throws(
      () => loadConfig(write(budget)),
      (error) => error instanceof BridgeError && error.code === 'CONFIG_INVALID',
      `budget ${budget} must be rejected at load`,
    );
  }
  const accepted = loadConfig(write(MAX_CODE_POINT_BYTES));
  assert.equal(accepted.limits.resultPageMaxBytes, MAX_CODE_POINT_BYTES);
});

test('F2-05 every successful page respects the hard byte ceiling', () => {
  const env = H.makeEnv('f2-05-pages');
  void env;
  const truncated = { stdout: false, stderr: false };
  const text = `中😀abc${'漢'.repeat(50)}🀄z`;
  for (const budget of [4, 5, 6, 7, 16, 64 * 1024]) {
    let offset = 0;
    let collected = '';
    let pages = 0;
    for (;;) {
      const page = paginate(text, { stream: 'stdout', offset, limit: 1000 }, budget, truncated);
      assert.equal(page.pageBytes <= budget, true, `budget ${budget} page exceeded the ceiling (${page.pageBytes})`);
      assert.equal(page.output.isWellFormed(), true, 'pages stay legal Unicode');
      assert.equal(page.nextOffset > offset || offset === page.totalChars, true, 'a page always advances');
      collected += page.output;
      offset = page.nextOffset;
      pages += 1;
      if (offset >= page.totalChars) break;
      assert.ok(pages < 1000, 'pagination must terminate');
    }
    assert.equal(collected, text, `budget ${budget} lost or duplicated code points`);
  }
  const huge = '😀'.repeat(30000);
  const lastPage = paginate(huge, { stream: 'stdout', offset: 29999, limit: 10 }, 64 * 1024, truncated);
  assert.equal(lastPage.output, '😀');
  assert.equal(lastPage.nextOffset, 30000);
});
