/**
 * R1-05 regression: a legal truncated log is `retained bytes + one note`.
 *
 * The release before this fix emitted the truncation note the moment data was
 * discarded — *before* the last retained fragment was appended. Redaction can
 * expand text past the remaining budget (`***REDACTED***` is longer than the
 * literal it replaces), so that path is reachable with legal output, and the
 * strict reader rejected it as `OUTPUT_LOG_INCOMPLETE`.
 *
 * Covered here: the writer always places the note after every retained byte; the
 * reader accepts that canonical layout *and* an unambiguous pre-R1-05 interleaved
 * note; a body line that merely looks like a note is never removed; and an
 * ambiguous or damaged log is refused instead of guessed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JobManager } from '../dist/src/jobs.js';
import { loadConfig } from '../dist/src/config.js';
import { Redactor } from '../dist/src/redact.js';
import { StreamCapture, isTruncationMarker, locateTruncationNote, truncationMarker } from '../dist/src/capture.js';
import * as H from './helpers/harness.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));
/** A 2-byte literal redacted to the 14-byte placeholder: legal 7x expansion. */
const EXPANDING_LITERAL = 'ZZ';
const CAP = 256;

function localFixture(name, options = {}) {
  const dir = path.join(H.ROOT, 'test', '.tmp', 'r105', name);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const part of ['state', 'tasks', 'impl']) fs.mkdirSync(path.join(dir, part), { recursive: true });
  const raw = {
    server: { logLevel: 'error' },
    stateDir: path.join(dir, 'state'),
    taskFileRoots: [path.join(dir, 'tasks')],
    workspaces: { impl: { dir: path.join(dir, 'impl'), allowedModes: ['implement'] } },
    runner: {
      type: 'fake',
      fake: { command: process.execPath, argsPrefix: [] },
      production: { command: process.execPath, argsPrefix: [], profile: 'headless' },
    },
    limits: {
      defaultTimeoutSeconds: 5,
      minTimeoutSeconds: 1,
      maxTimeoutSeconds: 60,
      perStreamCaptureCapBytes: options.cap ?? CAP,
      resultPageMaxBytes: options.pageBytes ?? 64,
    },
    cleanup: { confirmTimeoutMs: 100, killTimeoutMs: 100 },
    ...(options.redaction ? { redaction: options.redaction } : {}),
  };
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify(raw));
  const taskFile = path.join(dir, 'tasks', 'task.md');
  fs.writeFileSync(taskFile, 'offline R1-05 fixture; no model, no production state\n');
  const cfg = loadConfig(configFile);
  const control = { starts: 0, kills: 0, events: null, alive: false };
  const runner = {
    type: 'fake',
    describe: () => ({ type: 'fake', available: true, diagnostic: null, commandTemplate: 'in-process offline fake', details: {} }),
    start(spec, events) {
      control.starts += 1;
      control.events = events;
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
    async run(stdoutBytes) {
      const ack = await manager.submit({
        requestId: `${name}-req`,
        workspaceId: 'impl',
        mode: 'implement',
        taskFile,
        timeoutSeconds: 5,
      });
      await tick();
      control.events.onStdout(stdoutBytes);
      control.events.onExit(0, null);
      control.alive = false;
      return ack.jobId;
    },
    async finish() {
      if (control.alive) {
        control.alive = false;
        control.events.onExit(0, null);
      }
      await manager.shutdown();
    },
  };
}

/** Read the whole served text of one stream, one page at a time. */
function readAll(manager, jobId, stream, limit = 1_000_000_000) {
  const first = manager.result(jobId, { stream, offset: 0, limit });
  let offset = 0;
  let text = '';
  for (let page = 0; page < 100000; page += 1) {
    const view = manager.result(jobId, { stream, offset, limit }).page;
    assert.ok(view.pageBytes <= view.maxPageBytes, 'a page exceeded the hard byte ceiling');
    text += view.output;
    if (view.nextOffset === view.totalChars) break;
    assert.ok(view.nextOffset > offset, 'pagination did not advance');
    offset = view.nextOffset;
  }
  return { first, text };
}

function expectIncomplete(fn) {
  let thrown = null;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, 'a damaged truncated log was served as if it were complete');
  assert.equal(thrown.code, 'OUTPUT_LOG_INCOMPLETE');
  return thrown;
}

test('R1-05 an overflow caused by redaction expansion keeps the note after every retained byte', () => {
  const env = H.makeEnv('r105-expansion');
  const logFile = path.join(env.dir, 'expansion.log');
  const redactor = new Redactor({}, { extraLiteralSecrets: [EXPANDING_LITERAL] });
  const capture = new StreamCapture({ capBytes: CAP, redactor, logFile });
  // Line one fits. Line two is 81 raw bytes that redact to 561 bytes, so the
  // retained piece is written *after* truncation was already detected.
  capture.push(Buffer.from(`${EXPANDING_LITERAL}\n`));
  capture.push(Buffer.from(`${EXPANDING_LITERAL.repeat(40)}\n`));
  capture.end();

  assert.equal(capture.truncated, true, 'the fixture must truncate');
  assert.equal(capture.storedBytes, CAP, 'the cap is filled exactly by the retained piece');
  assert.equal(Buffer.byteLength(capture.text(), 'utf8'), capture.storedBytes);

  const disk = fs.readFileSync(logFile);
  assert.equal(
    disk.subarray(0, capture.storedBytes).equals(Buffer.from(capture.text(), 'utf8')),
    true,
    'the note must not split the retained bytes: they come first on disk',
  );
  const noteText = disk.subarray(capture.storedBytes).toString('utf8');
  assert.equal(isTruncationMarker(noteText, CAP), true, 'the trailing bytes are exactly one well-formed note');
  const located = locateTruncationNote(disk, capture.storedBytes, CAP);
  assert.deepEqual(located, { start: capture.storedBytes, bytes: disk.length - capture.storedBytes, trailing: true });
  assert.match(noteText, /output truncated/);
  assert.equal(capture.droppedBytes > 0, true, 'the discarded bytes are counted');
  assert.match(noteText, new RegExp(`${capture.droppedBytes} bytes discarded`), 'the note reports the final loss');
});

test('R1-05 every chunk shape and UTF-8 boundary keeps the canonical layout', () => {
  const env = H.makeEnv('r105-chunks');
  const payload = Buffer.from('中文😀\n'.repeat(400));
  for (const chunk of [payload.length, 7, 3, 1]) {
    const logFile = path.join(env.dir, `chunk-${chunk}.log`);
    const capture = new StreamCapture({ capBytes: 100, redactor: new Redactor({}, {}), logFile });
    for (let index = 0; index < payload.length; index += chunk) {
      capture.push(payload.subarray(index, index + chunk));
    }
    capture.end();
    assert.equal(capture.truncated, true, `chunk ${chunk} must truncate`);
    assert.ok(capture.storedBytes > 0 && capture.storedBytes <= 100, `chunk ${chunk}: stored ${capture.storedBytes}`);
    const text = Buffer.from(capture.text(), 'utf8');
    assert.equal(text.toString('utf8'), capture.text(), `chunk ${chunk}: the retained text stays valid UTF-8`);
    const disk = fs.readFileSync(logFile);
    assert.equal(disk.subarray(0, capture.storedBytes).equals(text), true, `chunk ${chunk}: retained bytes come first`);
    const located = locateTruncationNote(disk, capture.storedBytes, 100);
    assert.notEqual(located, null, `chunk ${chunk}: the trailing note is locatable`);
    assert.equal(located.trailing, true, `chunk ${chunk}: the note is the file suffix`);
    assert.equal(isTruncationMarker(disk.subarray(capture.storedBytes).toString('utf8'), 100), true, `chunk ${chunk}: note shape`);
  }
});

test('R1-05 a truncated job result equals the retained bytes on disk, page by page', async () => {
  const fx = localFixture('r105-result', {
    cap: 4096,
    pageBytes: 1024,
    redaction: { extraLiteralSecrets: [EXPANDING_LITERAL] },
  });
  try {
    const line = `${EXPANDING_LITERAL.repeat(50)}\n`;
    const jobId = await fx.run(Buffer.from(line.repeat(2000)));
    const { first, text } = readAll(fx.manager, jobId, 'stdout');
    assert.equal(first.page.truncated.stdout, true);
    assert.equal(first.read.entries[0].integrity, 'truncation-marker-verified');
    assert.equal(first.read.entries[0].expectedBytes, first.output.stdoutStoredBytes);

    const stored = first.output.stdoutStoredBytes;
    assert.ok(stored > 0 && stored <= 4096, `stored ${stored}`);
    assert.equal(first.page.totalChars, [...text].length);
    assert.equal(Buffer.byteLength(text, 'utf8'), stored, 'the served text is exactly the retained byte count');
    assert.equal(text.includes('[dsh-codex-bridge]'), false, 'the note is never part of the served output');

    const disk = fs.readFileSync(first.output.stdoutLog);
    assert.equal(disk.subarray(0, stored).toString('utf8'), text, 'disk retained bytes equal the served text');
    const noteText = disk.subarray(stored).toString('utf8');
    assert.equal(isTruncationMarker(noteText, 4096), true, 'the log ends with exactly one truncation note');
    assert.equal(locateTruncationNote(disk, stored, 4096).trailing, true);
  } finally {
    await fx.finish();
  }
});

test('R1-05 a body line that looks exactly like a note is preserved in a non-truncated log', async () => {
  const cap = 4096;
  const fx = localFixture('r105-marker-body', { cap, pageBytes: 1024 });
  try {
    // Built from the real note template, so only the truncated-flag protects it.
    const decoy = truncationMarker(cap, 5).slice(1);
    const payload = `first line\n${decoy}last line\n`;
    const jobId = await fx.run(Buffer.from(payload));
    const { first, text } = readAll(fx.manager, jobId, 'stdout');
    assert.equal(first.page.truncated.stdout, false);
    assert.equal(first.read.entries[0].integrity, 'exact');
    assert.equal(text, payload, 'a body line resembling the note is served byte for byte');
    assert.ok(text.includes('[dsh-codex-bridge] output truncated:'), 'the decoy survived');
  } finally {
    await fx.finish();
  }
});

test('R1-05 a pre-R1-05 interleaved note is accepted without stripping body text', async () => {
  const cap = 256;
  const fx = localFixture('r105-legacy', { cap, pageBytes: 1024 });
  try {
    // The retained region itself contains a line that looks like a note (a
    // different cap, so it is not a valid note for this capture).
    const decoy = truncationMarker(999, 1).slice(1);
    const unit = `header\n${decoy}${'a'.repeat(60)}\n`;
    const jobId = await fx.run(Buffer.from(unit.repeat(30)));

    const before = fx.manager.result(jobId, { stream: 'stdout' });
    const stored = before.output.stdoutStoredBytes;
    assert.ok(stored > unit.length, `the retained bytes must hold the decoy line, got ${stored}`);
    const disk = fs.readFileSync(before.output.stdoutLog);
    const retained = disk.subarray(0, stored);
    const note = disk.subarray(stored);
    assert.equal(isTruncationMarker(note.toString('utf8'), cap), true);
    assert.ok(retained.toString('utf8').includes('[dsh-codex-bridge] output truncated: cap 999'), 'decoy retained');

    // Rewrite the log in the pre-R1-05 shape: the note sits before the last
    // retained fragment, exactly as the old writer produced it.
    const cut = 40;
    const legacy = Buffer.concat([retained.subarray(0, cut), note, retained.subarray(cut)]);
    fs.writeFileSync(before.output.stdoutLog, legacy);

    const after = fx.manager.result(jobId, { stream: 'stdout' });
    assert.equal(after.read.entries[0].integrity, 'truncation-marker-verified');
    assert.match(after.read.entries[0].note, /pre-R1-05 log/);
    const { text } = readAll(fx.manager, jobId, 'stdout');
    assert.equal(text, retained.toString('utf8'), 'removing the one verified note yields exactly the retained bytes');
    assert.equal(Buffer.byteLength(text, 'utf8'), stored);
    assert.ok(text.includes('[dsh-codex-bridge] output truncated: cap 999'), 'the body decoy was not stripped');
    assert.equal(fx.manager.status(jobId).status, 'completed');
  } finally {
    await fx.finish();
  }
});

test('R1-05 the note locator refuses ambiguous or damaged layouts', () => {
  const cap = 256;
  const note = Buffer.from(truncationMarker(cap, 7), 'utf8');
  const body = Buffer.from('z'.repeat(64), 'utf8');

  // Canonical: retained bytes, then the note.
  const canonical = Buffer.concat([body, note]);
  assert.deepEqual(locateTruncationNote(canonical, body.length, cap), { start: body.length, bytes: note.length, trailing: true });

  // Pre-R1-05: the note is inside the retained bytes.
  const cut = 20;
  const interleaved = Buffer.concat([body.subarray(0, cut), note, body.subarray(cut)]);
  const located = locateTruncationNote(interleaved, body.length, cap);
  assert.equal(located.trailing, false);
  assert.equal(located.start, cut);

  // A note of the wrong length: bytes were removed from the retained output and
  // the note's own bytes now cover the gap.
  assert.equal(locateTruncationNote(canonical, body.length - 9, cap), null);
  // Two byte-identical notes: a pre-R1-05 log cannot be disambiguated.
  const doubled = Buffer.concat([body.subarray(0, 10), note, body.subarray(10, 30), note, body.subarray(30)]);
  assert.equal(locateTruncationNote(doubled, doubled.length - note.length, cap), null);
  // Trailing junk, no note at all, and a truncated file.
  assert.equal(locateTruncationNote(Buffer.concat([canonical, Buffer.from('junk')]), body.length, cap), null);
  assert.equal(locateTruncationNote(body, body.length, cap), null);
  assert.equal(locateTruncationNote(note, note.length, cap), null);
  assert.equal(locateTruncationNote(canonical, canonical.length, cap), null);
  // A note for a different cap is not a note for this capture.
  assert.equal(locateTruncationNote(Buffer.concat([body, Buffer.from(truncationMarker(cap + 1, 7), 'utf8')]), body.length, cap), null);
});

test('R1-05 damaged truncated logs are refused and never rewrite the job status', async () => {
  const cap = 256;
  const fx = localFixture('r105-damage', { cap, pageBytes: 1024 });
  try {
    const jobId = await fx.run(Buffer.from(`${'c'.repeat(800)}\n`));
    const before = fx.manager.result(jobId, { stream: 'stdout' });
    const original = fs.readFileSync(before.output.stdoutLog);
    const stored = before.output.stdoutStoredBytes;

    const cases = {
      'bytes removed from the head': original.subarray(9),
      'bytes removed from the retained middle': Buffer.concat([original.subarray(0, 10), original.subarray(20)]),
      'trailing bytes after the note': Buffer.concat([original, Buffer.from('extra')]),
      'emptied log': Buffer.alloc(0),
    };
    for (const [label, damaged] of Object.entries(cases)) {
      fs.writeFileSync(before.output.stdoutLog, damaged);
      expectIncomplete(() => fx.manager.result(jobId, { stream: 'stdout' }));
      assert.equal(fx.manager.status(jobId).status, 'completed', `${label}: the historical status is untouched`);
    }

    // A missing log is a different, equally explicit failure.
    const aside = `${before.output.stdoutLog}.preserved`;
    fs.renameSync(before.output.stdoutLog, aside);
    try {
      let thrown = null;
      try {
        fx.manager.result(jobId, { stream: 'stdout' });
      } catch (error) {
        thrown = error;
      }
      assert.equal(thrown?.code, 'OUTPUT_LOG_UNREADABLE');
    } finally {
      fs.renameSync(aside, before.output.stdoutLog);
    }

    // The undamaged log still serves the same verified bytes.
    fs.writeFileSync(before.output.stdoutLog, original);
    const restored = fx.manager.result(jobId, { stream: 'stdout' });
    assert.equal(restored.page.output, before.page.output);
    assert.equal(Buffer.byteLength(readAll(fx.manager, jobId, 'stdout').text, 'utf8'), stored);
  } finally {
    await fx.finish();
  }
});
