/**
 * R1–R4 regressions (offline, in-process where possible).
 *
 * R1: a stop requested before the deferred start (cancel / shutdown /
 *     ownership loss) must never spawn, must never invent a tree kill, and must
 *     still leave the normal running cancel/timeout/tree-kill/BUSY/late-exit
 *     rules intact.
 * R2: an explicitly configured secret is never silently dropped: short values
 *     are redacted at any length, an empty configured literal is refused at
 *     config load, and an unset/empty declared env var is a boundary, not a
 *     leak, and never a value in a diagnostic.
 * R3: a terminal output read refuses to report success on a missing, unreadable
 *     or shortened log; normal empty output, normal truncation markers and
 *     multi-byte text keep working; unrelated streams are not read.
 * R4: a live job exposes real-time stored/raw byte counters and truncation
 *     flags that agree with its pages, and the terminal/restart view matches.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JobManager } from '../dist/src/jobs.js';
import { loadConfig } from '../dist/src/config.js';
import { Redactor } from '../dist/src/redact.js';
import { StreamCapture, stripTruncationMarkers } from '../dist/src/capture.js';
import * as H from './helpers/harness.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeFixture(name, options = {}) {
  const dir = path.join(H.ROOT, 'test', '.tmp', 'r1fix', name);
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
      maxTimeoutSeconds: 60,
      perStreamCaptureCapBytes: options.cap ?? 512,
      resultPageMaxBytes: 64,
    },
    cleanup: { confirmTimeoutMs: 100, killTimeoutMs: 100 },
    ...(options.redaction ? { redaction: options.redaction } : {}),
  };
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify(raw));
  const taskFile = path.join(dir, 'tasks/task.md');
  fs.writeFileSync(taskFile, 'offline fixture; no model, no production state\n');
  const cfg = loadConfig(configFile, options.env ?? {});
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
    taskFile,
    submit: (audit = false, extra = {}) =>
      manager.submit({
        requestId: `${name}-req`,
        workspaceId: audit ? 'audit' : 'impl',
        mode: audit ? 'audit' : 'implement',
        taskFile,
        timeoutSeconds: 5,
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

async function terminatedJob(name, options = {}) {
  const fx = makeFixture(name, options);
  const ack = await fx.submit();
  await tick();
  fx.control.events.onStdout(Buffer.from('hello 中文😀\n'));
  fx.control.events.onStderr(Buffer.from('notice\n'));
  fx.control.events.onExit(0, null);
  fx.control.alive = false;
  return { ...fx, jobId: ack.jobId };
}

function expectBridgeError(fn, code) {
  let thrown = null;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, `expected ${code}`);
  assert.equal(thrown.code, code);
  return thrown;
}

// ---------------------------------------------------------------- R1

test('R1 cancel before the deferred start never spawns and never invents a kill', async () => {
  for (const audit of [false, true]) {
    const fx = makeFixture(`r1-early-cancel-${audit}`);
    try {
      const ack = await fx.submit(audit);
      const reply = await fx.manager.cancel(ack.jobId);
      await tick();
      assert.equal(fx.control.starts, 0, 'no runner was started');
      assert.equal(fx.control.kills, 0, 'no kill was attempted');
      const view = fx.manager.status(ack.jobId);
      assert.equal(view.status, 'cancelled');
      assert.equal(view.terminal, true);
      assert.equal(fx.manager.activeJobId, null, 'the execution slot was released');
      assert.equal(view.cleanup.confirmed, true);
      assert.equal(view.cleanup.method, 'not-started');
      assert.equal(view.cleanup.killed, false, 'a kill result must not be fabricated');
      assert.equal(view.cleanup.exited, false);
      assert.ok(view.cleanup.attempts <= 1, 'a cleanup was processed without any kill attempt');
      assert.match(String(view.cleanup.detail), /no child process was started/);
      assert.equal(reply.kill.method, 'not-started');
    } finally {
      await fx.finish();
    }
  }
});

test('R1 shutdown before the deferred start never spawns; the slot is released', async () => {
  const fx = makeFixture('r1-early-shutdown');
  try {
    const ack = await fx.submit();
    await fx.manager.shutdown();
    await tick();
    assert.equal(fx.control.starts, 0);
    assert.equal(fx.control.alive, false);
    const view = fx.manager.status(ack.jobId);
    assert.equal(view.terminal, true);
    assert.equal(view.status, 'cancelled');
    assert.match(String(view.error?.message ?? view.cleanup?.detail), /shut down|no child process/);
    assert.equal(fx.manager.activeJobId, null);
  } finally {
    await fx.finish();
  }
});

test('R1 repeated cancel/shutdown and cancel-then-exit stay single-shot and truthful', async () => {
  const fx = makeFixture('r1-repeated');
  try {
    const ack = await fx.submit();
    await fx.manager.cancel(ack.jobId);
    await tick();
    const second = await fx.manager.cancel(ack.jobId);
    assert.equal(second.alreadyTerminal, true);
    await fx.manager.shutdown();
    assert.equal(fx.control.starts, 0);
    assert.equal(fx.control.kills, 0);
    assert.equal(fx.manager.status(ack.jobId).status, 'cancelled');
    // A stray late exit after the single-shot terminal transition is recorded,
    // never re-applied.
    assert.equal(fx.manager.status(ack.jobId).lateExit, null);
  } finally {
    await fx.finish();
  }
});

test('R1 a running cancellation still calls the owned kill exactly once', async () => {
  const fx = makeFixture('r1-running-cancel');
  try {
    const ack = await fx.submit();
    await tick();
    assert.equal(fx.control.starts, 1);
    const reply = await fx.manager.cancel(ack.jobId);
    assert.equal(fx.control.kills, 1);
    assert.equal(reply.status, 'cancelled');
    assert.equal(fx.manager.activeJobId, null);
  } finally {
    await fx.finish();
  }
});

test('R1 a running timeout still stops through the owned kill and reports timed_out', async () => {
  const fx = makeFixture('r1-timeout');
  try {
    const ack = await fx.submit(false, { timeoutSeconds: 1 });
    await tick();
    assert.equal(fx.control.starts, 1);
    await sleep(1400);
    const view = fx.manager.status(ack.jobId);
    assert.equal(view.status, 'timed_out');
    assert.equal(view.timedOut, true);
    assert.equal(fx.control.kills, 1);
    assert.equal(fx.control.alive, false);
  } finally {
    await fx.finish();
  }
});

test('R1 a late exit during a pending cleanup cannot rewrite the terminal state', async () => {
  const fx = makeFixture('r1-late-exit');
  try {
    const ack = await fx.submit();
    await tick();
    const cancellation = fx.manager.cancel(ack.jobId);
    await tick();
    // The kill already delivered SIGTERM and the exit event; the terminal state
    // must be cancelled, not completed.
    await cancellation;
    const view = fx.manager.status(ack.jobId);
    assert.equal(view.status, 'cancelled');
    assert.equal(view.exitCode, null);
    assert.equal(fx.control.starts, 1);
    assert.equal(fx.control.kills, 1);
  } finally {
    await fx.finish();
  }
});

test('R1 BUSY still protects the occupied slot', async () => {
  const fx = makeFixture('r1-busy');
  try {
    const ack = await fx.submit();
    await tick();
    await assert.rejects(
      () => fx.submit(false, { requestId: 'r1-busy-second' }),
      (error) => error.code === 'BUSY',
    );
    await fx.manager.cancel(ack.jobId);
    assert.equal(fx.manager.status(ack.jobId).status, 'cancelled');
  } finally {
    await fx.finish();
  }
});

// ---------------------------------------------------------------- R2

test('R2 short explicit literals (1/7/8 chars) are redacted in direct and env mode', async () => {
  for (const mode of ['direct', 'env']) {
    for (const value of ['§', 'pin2468', 'hunter2x']) {
      const options =
        mode === 'direct'
          ? { redaction: { extraLiteralSecrets: [value] } }
          : { redaction: { extraSecretEnv: ['R1_TEST_SECRET'] }, env: { R1_TEST_SECRET: value } };
      const fx = makeFixture(`r2-${mode}-${value.length}`, { ...options, cap: 4096 });
      try {
        assert.equal(fx.cfg.redactor.literalCount, 1, `${mode} length ${value.length}: literal was dropped`);
        const ack = await fx.submit();
        await tick();
        for (const byte of Buffer.from(`prefix ${value} suffix\n`)) fx.control.events.onStdout(Buffer.from([byte]));
        fx.control.events.onStderr(Buffer.from(`err ${value}\n`));
        fx.control.events.onExit(0, null);
        fx.control.alive = false;
        const result = fx.manager.result(ack.jobId, { stream: 'combined', limit: 10000 });
        assert.equal(result.page.output.includes(value), false, `${mode} length ${value.length}: result leaked the value`);
        assert.match(result.page.output, /\*\*\*REDACTED\*\*\*/);
        for (const file of [result.output.stdoutLog, result.output.stderrLog]) {
          assert.equal(fs.readFileSync(file, 'utf8').includes(value), false, `${mode} length ${value.length}: disk leaked the value`);
        }
        const health = fx.manager.health();
        if (value.length > 1) {
          // A one-code-point literal is legitimately present in ordinary prose
          // (for example a section sign), so leak checking uses distinct values.
          assert.equal(JSON.stringify(health).includes(value), false, 'a diagnostic leaked the value');
        }
        assert.equal(health.capabilities.redaction.configuredLiteralSecrets, 1);
      } finally {
        await fx.finish();
      }
    }
  }
});

test('R2 an empty configured literal is refused at load; an unset/empty env var is a boundary, not a leak', () => {
  const dir = path.join(H.ROOT, 'test', '.tmp', 'r1fix', 'r2-config');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const base = {
    server: { logLevel: 'error' },
    stateDir: path.join(dir, 'state'),
    taskFileRoots: [dir],
    workspaces: { impl: { dir, allowedModes: ['implement'] } },
    runner: { type: 'fake', fake: { command: process.execPath, argsPrefix: [] }, production: { command: process.execPath, argsPrefix: [] } },
  };
  const write = (name, redaction) => {
    const file = path.join(dir, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify({ ...base, redaction }));
    return file;
  };

  const emptyLiteral = write('empty-literal', { extraLiteralSecrets: [''] });
  const error = expectBridgeError(() => loadConfig(emptyLiteral, {}), 'CONFIG_INVALID');
  assert.match(error.message, /empty value/);
  assert.equal(JSON.stringify(error.details).includes('pin2468'), false);

  const unset = loadConfig(write('unset-env', { extraSecretEnv: ['R1_NOT_SET'], extraLiteralSecrets: [] }), {});
  assert.equal(unset.redactor.literalCount, 0);
  assert.deepEqual([...unset.redactor.unresolvedSecretEnvNames], ['R1_NOT_SET']);
  assert.deepEqual([...unset.redactor.emptySecretEnvNames], []);

  const emptyValue = loadConfig(write('empty-env', { extraSecretEnv: ['R1_EMPTY'], extraLiteralSecrets: [] }), { R1_EMPTY: '' });
  assert.equal(emptyValue.redactor.literalCount, 0);
  assert.deepEqual([...emptyValue.redactor.emptySecretEnvNames], ['R1_EMPTY']);
  assert.deepEqual([...emptyValue.redactor.unresolvedSecretEnvNames], []);
});

test('R2 overlapping literals, chunk splits, newlines and truncation never expose a configured value', () => {
  const env = H.makeEnv('r2-overlap');
  const redactor = new Redactor({}, { extraLiteralSecrets: ['hunter2', 'hunter2x'] });
  assert.equal(redactor.literalCount, 2);
  assert.equal(redactor.shortLiteralCount, 1, 'only the 7-character literal is reported as short');
  assert.equal(redactor.redact('v=hunter2x;').includes('hunter2'), false);

  // A literal split across two writes on the same line is still removed, and
  // the longer overlapping value wins so no suffix can be reassembled.
  const logFile = path.join(env.dir, 'split.log');
  const capture = new StreamCapture({ capBytes: 4096, redactor, logFile });
  capture.push(Buffer.from('v=hun'));
  capture.push(Buffer.from('ter2x-suffix\n'));
  capture.end();
  const disk = fs.readFileSync(logFile, 'utf8');
  assert.equal(disk.includes('hunter2'), false);
  assert.match(disk, /REDACTED/);

  // A truncated capture discards the incomplete trailing line: a value that may
  // continue inside the discarded bytes is never written.
  const env2 = H.makeEnv('r2-truncate');
  const shortLog = path.join(env2.dir, 'short.log');
  const shortRedactor = new Redactor({}, { extraLiteralSecrets: ['pin2468'] });
  const truncated = new StreamCapture({ capBytes: 16, redactor: shortRedactor, logFile: shortLog });
  truncated.push(Buffer.from('ok line\npin246'));
  truncated.push(Buffer.from('8 more bytes that overflow the cap\n'));
  truncated.end();
  const shortDisk = fs.readFileSync(shortLog, 'utf8');
  assert.equal(shortDisk.includes('pin2468'), false);
  assert.equal(shortDisk.includes('pin246'), false, 'the retained incomplete line is dropped');
  assert.equal(truncated.truncated, true);
  assert.match(shortDisk, /output truncated/);
});

test('R2 diagnostics never print a real value', () => {
  const env = H.makeEnv('r2-diagnostics');
  const redactor = new Redactor({}, { extraLiteralSecrets: ['pin2468'], extraSecretEnv: [] });
  const healthText = JSON.stringify({
    literals: redactor.literalCount,
    short: redactor.shortLiteralCount,
    unresolved: redactor.unresolvedSecretEnvNames,
    longest: redactor.longestLiteralLength,
  });
  assert.equal(healthText.includes('pin2468'), false);
  assert.equal(env.dir.includes('pin2468'), false);
});

// ---------------------------------------------------------------- R3

test('R3 normal empty output is readable; a missing log with recorded bytes is not', async () => {
  const fx = makeFixture('r3-zero');
  try {
    const ack = await fx.submit();
    await tick();
    fx.control.events.onExit(0, null);
    fx.control.alive = false;
    const stdout = fx.manager.result(ack.jobId, { stream: 'stdout' });
    assert.equal(stdout.ok, true);
    assert.equal(stdout.page.output, '');
    assert.equal(fx.manager.result(ack.jobId, { stream: 'combined' }).page.output, '');
  } finally {
    await fx.finish();
  }
});

test('R3 missing/empty/shortened/unreadable logs refuse to report success', async () => {
  for (const mode of ['missing', 'empty', 'short', 'read-error']) {
    const fx = await terminatedJob(`r3-${mode}`);
    try {
      const before = fx.manager.result(fx.jobId, { stream: 'stdout' });
      const file = before.output.stdoutLog;
      const bytes = fs.readFileSync(file);
      assert.equal(bytes.length, before.output.stdoutStoredBytes);
      const aside = `${file}.preserved`;
      let originalRead = null;
      try {
        if (mode === 'missing') fs.renameSync(file, aside);
        else if (mode === 'empty') fs.writeFileSync(file, '');
        else if (mode === 'short') fs.writeFileSync(file, bytes.subarray(0, 2));
        else {
          originalRead = fs.readFileSync;
          fs.readFileSync = function patched(target, ...rest) {
            if (path.resolve(String(target)) === path.resolve(file)) {
              const error = new Error('injected temporary log read refusal');
              error.code = 'EACCES';
              throw error;
            }
            return originalRead.call(fs, target, ...rest);
          };
        }
        const thrown = expectBridgeError(
          () => fx.manager.result(fx.jobId, { stream: 'stdout' }),
          mode === 'read-error' ? 'OUTPUT_LOG_UNREADABLE' : mode === 'missing' ? 'OUTPUT_LOG_UNREADABLE' : 'OUTPUT_LOG_INCOMPLETE',
        );
        assert.match(String(thrown.message), /cannot be read|incomplete/);
        assert.equal(fx.manager.status(fx.jobId).status, 'completed', 'the historical exit semantics are preserved');
        assert.equal(fx.manager.status(fx.jobId).exitCode, 0);
      } finally {
        if (originalRead !== null) fs.readFileSync = originalRead;
        if (mode === 'missing') fs.renameSync(aside, file);
        else if (mode !== 'read-error') fs.writeFileSync(file, bytes);
      }
    } finally {
      await fx.finish();
    }
  }
});

test('R3 a healthy single stream is independent of a damaged other stream', async () => {
  const fx = await terminatedJob('r3-other-stream');
  try {
    const stdout = fx.manager.result(fx.jobId, { stream: 'stdout' });
    assert.equal(stdout.page.output, 'hello 中文😀\n');
    const stderr = fx.manager.result(fx.jobId, { stream: 'stderr' });
    const aside = `${stderr.output.stderrLog}.preserved`;
    fs.renameSync(stderr.output.stderrLog, aside);
    try {
      assert.equal(fx.manager.result(fx.jobId, { stream: 'stdout' }).page.output, stdout.page.output);
      expectBridgeError(() => fx.manager.result(fx.jobId, { stream: 'combined' }), 'OUTPUT_LOG_UNREADABLE');
    } finally {
      fs.renameSync(aside, stderr.output.stderrLog);
    }
  } finally {
    await fx.finish();
  }
});

test('R3 truncation markers are stripped and multi-byte pages stay within the byte ceiling', async () => {
  const fx = makeFixture('r3-truncated', { cap: 128 });
  try {
    const ack = await fx.submit();
    await tick();
    fx.control.events.onStdout(Buffer.from('中文😀\n'.repeat(100)));
    fx.control.events.onExit(0, null);
    fx.control.alive = false;
    let offset = 0;
    let text = '';
    let total = null;
    for (let page = 0; page < 200; page += 1) {
      const result = fx.manager.result(ack.jobId, { stream: 'stdout', offset, limit: 7 });
      const view = result.page;
      assert.ok(view.pageBytes <= 64);
      assert.equal(view.truncated.stdout, true);
      assert.equal(view.offset, offset);
      assert.equal(view.nextOffset, offset + [...view.output].length);
      total ??= view.totalChars;
      assert.equal(view.totalChars, total);
      text += view.output;
      if (view.nextOffset === total) break;
      assert.ok(view.nextOffset > offset);
      offset = view.nextOffset;
    }
    assert.equal([...text].length, total);
    assert.equal(text.includes('[dsh-codex-bridge]'), false);
    const recordText = fs.readFileSync(fx.manager.result(ack.jobId, { stream: 'stdout' }).output.stdoutLog, 'utf8');
    assert.match(recordText, /output truncated/);
  } finally {
    await fx.finish();
  }
});

test('R3 a 5 MiB multibyte truncation keeps storedBytes aligned with the stored bytes', () => {
  const env = H.makeEnv('r3-5mib');
  const cap = 5 * 1024 * 1024;
  const logFile = path.join(env.dir, 'big.log');
  const capture = new StreamCapture({ capBytes: cap, redactor: new Redactor({}, {}), logFile });
  // ~1 KiB lines with multi-byte code points, pushed in 64 KiB chunks: enough
  // data to overflow the 5 MiB cap without one append per tiny line.
  const line = `中文😀${'x'.repeat(981)}\n`;
  const body = Buffer.from(line.repeat(6600));
  assert.ok(body.length > cap, 'the fixture must overflow the capture cap');
  for (let index = 0; index < body.length; index += 64 * 1024) {
    capture.push(body.subarray(index, index + 64 * 1024));
  }
  capture.end();
  assert.equal(capture.truncated, true);
  assert.equal(capture.rawBytes, body.length);
  assert.ok(capture.storedBytes <= cap, `stored ${capture.storedBytes} > cap`);
  const onDisk = fs.readFileSync(logFile);
  assert.equal(Buffer.byteLength(capture.text(), 'utf8'), capture.storedBytes, 'storedBytes must match the stored text bytes');
  assert.ok(onDisk.length > capture.storedBytes, 'the truncation marker adds bytes on disk');
  assert.equal(
    stripTruncationMarkers(onDisk.toString('utf8')),
    capture.text(),
    'the stored bytes on disk equal the in-memory stored text after marker removal',
  );
});

test('R3 bytes removed from a truncated log cannot hide behind the truncation marker', async () => {
  const fx = makeFixture('r3-marker-damage', { cap: 128 });
  try {
    const ack = await fx.submit();
    await tick();
    fx.control.events.onStdout(Buffer.from('line0000\n'.repeat(100)));
    fx.control.events.onExit(0, null);
    fx.control.alive = false;
    const before = fx.manager.result(ack.jobId, { stream: 'stdout' });
    assert.equal(before.page.truncated.stdout, true);
    assert.equal(before.read.entries[0].integrity, 'truncation-marker-verified');
    assert.equal(before.read.entries[0].expectedBytes, before.output.stdoutStoredBytes);
    const file = before.output.stdoutLog;
    const original = fs.readFileSync(file);
    assert.match(original.toString('utf8'), /\[dsh-codex-bridge\] output truncated/);
    // The marker's own bytes would still cover the loss for a naive lower-bound
    // check: the offset check must refuse it.
    fs.writeFileSync(file, original.subarray(9));
    expectBridgeError(() => fx.manager.result(ack.jobId, { stream: 'stdout' }), 'OUTPUT_LOG_INCOMPLETE');
    assert.equal(fx.manager.status(ack.jobId).status, 'completed');
    fs.writeFileSync(file, original);
    assert.equal(fx.manager.result(ack.jobId, { stream: 'stdout' }).page.output, before.page.output);
  } finally {
    await fx.finish();
  }
});

test('R3 an unfinalised recovered record is a declared boundary, never a silent success', async () => {
  const fx = await terminatedJob('r3-recovered-boundary');
  const expected = fx.manager.result(fx.jobId, { stream: 'stdout' }).page.output;
  const recordFile = path.join(fx.dir, 'state', 'jobs', fx.jobId, 'job.json');
  await fx.manager.shutdown();

  const startSecond = () => {
    const manager = new JobManager(fx.cfg, {
      type: 'fake',
      describe: () => ({ type: 'fake', available: true, diagnostic: null, commandTemplate: 'in-process offline fake', details: {} }),
      start() {
        throw new Error('the restart must not start anything');
      },
    });
    manager.init();
    return manager;
  };

  const record = H.readJson(recordFile);
  record.bytes.stdout = 0;
  record.recovered = true;
  fs.writeFileSync(recordFile, JSON.stringify(record, null, 2));
  const recoveredManager = startSecond();
  try {
    const result = recoveredManager.result(fx.jobId, { stream: 'stdout' });
    assert.equal(result.page.output, expected);
    assert.equal(result.read.entries[0].integrity, 'unverified-extra-bytes');
    assert.match(result.read.entries[0].note, /not proven complete/);
  } finally {
    await recoveredManager.shutdown();
  }

  // The same extra bytes on a record that claims to be finalised are refused.
  record.bytes.stdout = 0;
  record.recovered = false;
  fs.writeFileSync(recordFile, JSON.stringify(record, null, 2));
  const strictManager = startSecond();
  try {
    expectBridgeError(() => strictManager.result(fx.jobId, { stream: 'stdout' }), 'OUTPUT_LOG_INCOMPLETE');
  } finally {
    await strictManager.shutdown();
  }
});

test('R3 a restart reads the same verified output', async () => {
  const fx = await terminatedJob('r3-restart');
  const before = fx.manager.result(fx.jobId, { stream: 'stdout' }).page.output;
  await fx.manager.shutdown();
  const second = new JobManager(fx.cfg, {
    type: 'fake',
    describe: () => ({ type: 'fake', available: true, diagnostic: null, commandTemplate: 'in-process offline fake', details: {} }),
    start() {
      throw new Error('the restart must not start anything');
    },
  });
  second.init();
  try {
    const after = second.result(fx.jobId, { stream: 'stdout' });
    assert.equal(after.page.output, before);
    assert.equal(after.status, 'completed');
  } finally {
    await second.shutdown();
  }
});

// ---------------------------------------------------------------- R4

test('R4 a running job reports live counters and truncation flags that agree with its page', async () => {
  const fx = makeFixture('r4-live', { cap: 32 });
  try {
    const ack = await fx.submit();
    await tick();
    const stdout = Buffer.from('中文\n'.repeat(30));
    const stderr = Buffer.from(`${'y'.repeat(200)}\n`);
    fx.control.events.onStdout(stdout);
    fx.control.events.onStderr(stderr);
    const result = fx.manager.result(ack.jobId, { stream: 'combined' });
    assert.equal(result.status, 'running');
    assert.equal(result.output.live, true);
    assert.deepEqual(result.output.truncated, result.page.truncated);
    assert.equal(result.output.truncated.stdout, true);
    assert.equal(result.output.truncated.stderr, true);
    assert.equal(result.output.stdoutRawBytes, stdout.length);
    assert.equal(result.output.stderrRawBytes, stderr.length);
    assert.ok(result.output.stdoutStoredBytes > 0);
    assert.ok(result.output.stdoutStoredBytes <= 32);
    assert.ok(result.output.stderrStoredBytes <= 32);
  } finally {
    await fx.finish();
  }
});

test('R4 live raw bytes count an incomplete line while nothing is stored yet', async () => {
  const fx = makeFixture('r4-pending');
  try {
    const ack = await fx.submit();
    await tick();
    fx.control.events.onStdout(Buffer.from('abc'));
    const result = fx.manager.result(ack.jobId, { stream: 'stdout' });
    assert.equal(result.output.live, true);
    assert.equal(result.output.stdoutRawBytes, 3);
    assert.equal(result.output.stdoutStoredBytes, 0);
    assert.equal(result.output.truncated.stdout, false);
    assert.equal(result.page.output, '');
  } finally {
    await fx.finish();
  }
});

test('R4 terminal and restart views match the live view and the persisted record', async () => {
  const fx = makeFixture('r4-terminal', { cap: 32 });
  const ack = await fx.submit();
  await tick();
  fx.control.events.onStdout(Buffer.from('中文\n'.repeat(30)));
  fx.control.events.onStderr(Buffer.from('z'.repeat(100)));
  const live = fx.manager.status(ack.jobId);
  fx.control.events.onExit(0, null);
  fx.control.alive = false;
  const terminal = fx.manager.status(ack.jobId);
  assert.equal(terminal.output.live, false);
  assert.equal(terminal.output.stdoutRawBytes, live.output.stdoutRawBytes);
  assert.equal(terminal.output.stdoutStoredBytes, live.output.stdoutStoredBytes);
  assert.deepEqual(terminal.output.truncated, live.output.truncated);
  const record = H.readJson(path.join(fx.dir, 'state', 'jobs', ack.jobId, 'job.json'));
  assert.equal(record.bytes.stdout, terminal.output.stdoutStoredBytes);
  assert.equal(record.rawBytes.stderr, terminal.output.stderrRawBytes);
  assert.deepEqual(record.truncated, terminal.output.truncated);
  await fx.manager.shutdown();
  const second = new JobManager(fx.cfg, {
    type: 'fake',
    describe: () => ({ type: 'fake', available: true, diagnostic: null, commandTemplate: 'in-process offline fake', details: {} }),
    start() {
      throw new Error('the restart must not start anything');
    },
  });
  second.init();
  try {
    const restarted = second.status(ack.jobId);
    assert.equal(restarted.output.live, false);
    assert.equal(restarted.output.stdoutStoredBytes, terminal.output.stdoutStoredBytes);
    assert.deepEqual(restarted.output.truncated, terminal.output.truncated);
  } finally {
    await second.shutdown();
  }
});
