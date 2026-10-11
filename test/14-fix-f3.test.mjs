/**
 * FIX-003 regressions.
 *
 * F3-01 exclusive claiming: a delayed first starter must refuse a healthy owner
 *        and must not touch its lock, task record or child process.
 * F3-02 identity proof: an exact OS creation-time match plus path and command
 *        digest; any difference or malformed field is "not proven".
 * F3-03 legacy records without a childIdentity field stay diagnosable instead of
 *        crashing the service.
 * F3-04 the delivered source manifest matches the delivered files exactly.
 *
 * Real Windows processes are created by this test only and cleaned up here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { JobManager } from '../dist/src/jobs.js';
import { loadConfig } from '../dist/src/config.js';
import { compareIdentity, normalizeChildIdentity, commandLineDigest, probeProcessIdentity } from '../dist/src/process-identity.js';
import { BridgeError } from '../dist/src/errors.js';
import * as H from './helpers/harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readUntil(file, timeoutMs, label) {
  const ok = await H.waitFor(() => fs.existsSync(file), timeoutMs, 50);
  assert.equal(ok, true, `${label} was not observed within ${timeoutMs} ms`);
}

test('F3-01 a delayed first starter refuses a healthy owner without touching it', async () => {
  const env = H.makeEnv('f3-01-first-claim');
  const configPath = H.writeConfig(env, {
    __name: 'f301',
    server: { logLevel: 'info' },
    ownership: { heartbeatMs: 10000, staleHeartbeatMs: 30000 },
  });
  const lock = path.join(env.state, 'owner.lock');
  const ready = path.join(env.dir, 'a-paused.txt');
  const gate = path.join(env.dir, 'resume-a.txt');
  const wrapper = path.join(env.dir, 'paused-entry.mjs');
  fs.writeFileSync(
    wrapper,
    `import fs from 'node:fs';\nimport path from 'node:path';\nimport { pathToFileURL } from 'node:url';\n` +
      `const lock = process.env.F3_LOCK, ready = process.env.F3_READY, gate = process.env.F3_GATE, entry = process.env.F3_ENTRY;\n` +
      `const open = fs.openSync;\nlet paused = false;\n` +
      `fs.openSync = function (p, flags, ...rest) {\n` +
      `  try {\n` +
      `    if (!paused && flags === 'wx' && path.resolve(String(p)) === path.resolve(lock) && !fs.existsSync(lock)) {\n` +
      `      paused = true; fs.writeFileSync(ready, 'ready');\n` +
      `      const until = Date.now() + 20000;\n` +
      `      while (!fs.existsSync(gate)) {\n` +
      `        if (Date.now() > until) throw new Error('gate timed out');\n` +
      `        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);\n` +
      `      }\n` +
      `    }\n` +
      `  } catch { /* never break the claim */ }\n` +
      `  return open.call(fs, p, flags, ...rest);\n};\n` +
      `await import(pathToFileURL(entry).href);\n`,
  );

  let owner = null;
  let paused = null;
  try {
    // The delayed starter parks *before* any lock exists.
    paused = spawn(process.execPath, [wrapper, '--config', configPath], {
      cwd: env.dir,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, F3_LOCK: lock, F3_ARB: path.join(env.state, 'owner.arb'), F3_READY: ready, F3_GATE: gate, F3_ENTRY: H.ENTRY },
    });
    let pausedErr = '';
    let pausedOut = '';
    paused.stdout.on('data', (chunk) => {
      pausedOut += chunk.toString('utf8');
    });
    paused.stderr.on('data', (chunk) => {
      pausedErr += chunk.toString('utf8');
    });
    await readUntil(ready, 15000, 'the delayed starter pausing before its exclusive claim');

    // Only now does a healthy owner start; it claims the (still missing) lock.
    owner = await H.startBridge(configPath, env, { name: 'f301-owner' });
    const taskFile = H.writeTask(env, 'owner-task.md', 'FAKE_SLEEP_MS=60000\nhold the lock\n');
    const submitted = await H.callTool(owner.client, 'dsh_submit', {
      requestId: 'f301-owner',
      workspaceId: 'impl',
      taskFile,
      mode: 'implement',
    });
    const jobId = submitted.payload.jobId;
    await H.sleep(600);
    const running = (await H.callTool(owner.client, 'dsh_status', { jobId })).payload.job;
    assert.equal(running.status, 'running');
    const childPid = running.pid;
    const lockBefore = H.readJson(lock);
    assert.equal(lockBefore.pid, owner.serverPid(), 'the healthy owner holds the lock');

    fs.writeFileSync(gate, 'resume');
    const exitCode = await new Promise((resolve) => paused.on('close', (code) => resolve(code)));

    assert.equal(exitCode, 2, `the delayed starter must refuse to start, saw exit ${exitCode} (stderr: ${pausedErr.slice(-300)})`);
    assert.match(pausedErr, /STATE_DIR_BUSY/);
    assert.equal(pausedOut.trim(), '', 'the refusing starter never speaks the protocol');

    const lockAfter = H.readJson(lock);
    assert.equal(lockAfter.lockId, lockBefore.lockId, "the healthy owner's lock identity is unchanged");
    assert.equal(lockAfter.pid, lockBefore.pid, "the healthy owner's pid is unchanged");

    const stillRunning = (await H.callTool(owner.client, 'dsh_status', { jobId })).payload.job;
    assert.equal(stillRunning.status, 'running', "the healthy owner's task record was not rewritten");
    assert.equal(stillRunning.recovered, false);
    const onDisk = H.readJson(path.join(env.state, 'jobs', jobId, 'job.json'));
    assert.equal(onDisk.status, 'running');
    assert.equal(alive(childPid), true, "the healthy owner's child process is untouched");
  } finally {
    if (owner !== null) await owner.close();
    if (paused !== null && alive(paused.pid)) paused.kill('SIGKILL');
  }
});

test('F3-02 identity comparison requires an exact, complete OS identity', () => {
  const env = H.makeEnv('f3-02-matrix');
  void env;
  const expected = {
    pid: 4321,
    creationTimeMs: 1700000000000,
    executablePath: process.execPath,
    commandLineDigest: commandLineDigest('node fake-runner.mjs task'),
  };
  const ok = (identity) => ({ status: 'ok', identity });

  assert.equal(compareIdentity(expected, ok({ ...expected })).proven, true, 'exact match is the control');

  for (const delta of [1, -1, 1000, -1000, 4999, 5000, 5001]) {
    const comparison = compareIdentity(expected, ok({ ...expected, creationTimeMs: expected.creationTimeMs + delta }));
    assert.equal(comparison.proven, false, `a ${delta} ms creation-time difference must not be proven`);
  }
  assert.equal(compareIdentity({ ...expected, pid: 999 }, ok({ ...expected })).proven, false, 'pid mismatch');
  assert.equal(compareIdentity(expected, ok({ ...expected, executablePath: 'C:\\other\\node.exe' })).proven, false, 'path mismatch');
  assert.equal(compareIdentity(expected, ok({ ...expected, commandLineDigest: commandLineDigest('other') })).proven, false, 'command mismatch');

  // Malformed or incomplete input on either side must never be proven, and must
  // never throw.
  const broken = [
    undefined,
    null,
    {},
    { ...expected, creationTimeMs: undefined },
    { ...expected, creationTimeMs: Number.NaN },
    { ...expected, creationTimeMs: Number.POSITIVE_INFINITY },
    { ...expected, creationTimeMs: '1700000000000' },
    { ...expected, pid: undefined },
    { ...expected, pid: 0 },
    { ...expected, pid: 1.5 },
    { ...expected, executablePath: '' },
    { ...expected, commandLineDigest: 'not-a-digest' },
    { ...expected, commandLineDigest: '' },
  ];
  for (const value of broken) {
    const comparison = compareIdentity(value, ok({ ...expected }));
    assert.equal(comparison.proven, false, `expected ${JSON.stringify(value)} to be not proven`);
    assert.equal(typeof comparison.reason, 'string');
    assert.equal(normalizeChildIdentity(value), null);
  }
  for (const observed of [
    undefined,
    null,
    { status: 'unavailable', reason: 'probe failed' },
    { status: 'not-found', reason: 'gone' },
    { status: 'ok' },
    ok({ ...expected, creationTimeMs: Number.NaN }),
    ok({ ...expected, commandLineDigest: undefined }),
    ok({ ...expected, executablePath: '' }),
  ]) {
    const comparison = compareIdentity(expected, observed);
    assert.equal(comparison.proven, false, `observed ${JSON.stringify(observed)} must not be proven`);
  }
  assert.equal(normalizeChildIdentity(expected) !== null, true, 'a complete identity normalizes');
});

test('F3-02 an incomplete CIM response is unavailable, not a proven identity', () => {
  const realExec = childProcess.execFileSync;
  try {
    childProcess.execFileSync = () =>
      JSON.stringify({ ProcessId: 1234, CreationDate: '/Date(1700000000000)/', ExecutablePath: process.execPath, CommandLine: null });
    syncBuiltinESMExports();
    const missingCommand = probeProcessIdentity(1234);
    assert.notEqual(missingCommand.status, 'ok', 'a null CommandLine is incomplete evidence');

    childProcess.execFileSync = () =>
      JSON.stringify({ ProcessId: 1234, CreationDate: null, ExecutablePath: process.execPath, CommandLine: 'node x.mjs' });
    syncBuiltinESMExports();
    assert.notEqual(probeProcessIdentity(1234).status, 'ok', 'a missing CreationDate is incomplete evidence');

    childProcess.execFileSync = () => {
      throw new Error('CIM unavailable');
    };
    syncBuiltinESMExports();
    const failed = probeProcessIdentity(1234);
    assert.equal(failed.status, 'unavailable');
    assert.equal(compareIdentity({ pid: 1234, creationTimeMs: 1, executablePath: 'x', commandLineDigest: 'a'.repeat(64) }, failed).proven, false);
  } finally {
    childProcess.execFileSync = realExec;
    syncBuiltinESMExports();
  }
});

test('F3-02 a real sentinel with a near-miss identity is neither killed nor treated as resolved', async () => {
  const env = H.makeEnv('f3-02-sentinel');
  const seedConfig = H.writeConfig(env, { __name: 'f302seed' });
  const taskFile = H.writeTask(env, 'task.md', 'FAKE_EXIT=0\n');
  const seed = await H.startBridge(seedConfig, env, { name: 'f302-seed' });
  const submitted = await H.callTool(seed.client, 'dsh_submit', {
    requestId: 'f302-seed',
    workspaceId: 'impl',
    taskFile,
    mode: 'implement',
  });
  const jobId = submitted.payload.jobId;
  await H.waitForTerminal(seed.client, jobId);
  await seed.close();
  await H.sleep(300);

  const sentinel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  try {
    const probe = probeProcessIdentity(sentinel.pid);
    assert.equal(probe.status, 'ok', 'the host probe must work for this test');
    const jobFile = path.join(env.state, 'jobs', jobId, 'job.json');
    const record = H.readJson(jobFile);
    record.status = 'running';
    record.endedAt = null;
    record.pid = sentinel.pid;
    record.recovered = false;
    record.cleanup = null;
    // Same pid, same path, same command digest — only the creation time differs.
    record.childIdentity = { ...probe.identity, creationTimeMs: probe.identity.creationTimeMs - 1000 };
    fs.writeFileSync(jobFile, JSON.stringify(record, null, 2));

    const bridge = await H.startBridge(
      H.writeConfig(env, { __name: 'f302verify', recovery: { killOrphanedChildrenOnStart: true } }),
      env,
      { name: 'f302-verify' },
    );
    try {
      const health = await H.callTool(bridge.client, 'dsh_health');
      assert.equal(health.payload.orphanBlock.pids.includes(sentinel.pid), true, 'a 1 s creation-time difference is not proof');
      assert.equal(alive(sentinel.pid), true, 'the sentinel must survive');
      const error = await H.callToolExpectError(bridge.client, 'dsh_submit', {
        requestId: 'f302-after',
        workspaceId: 'impl',
        taskFile,
        mode: 'implement',
      });
      assert.equal(error.code, 'ORPHAN_UNRESOLVED');
      const job = (await H.callTool(bridge.client, 'dsh_status', { jobId })).payload.job;
      assert.notEqual(job.cleanup?.confirmed, true, 'no unverified cleanup may be reported as confirmed');
    } finally {
      await bridge.close();
    }
  } finally {
    if (alive(sentinel.pid)) sentinel.kill('SIGKILL');
  }
});

test('F3-03 legacy records without childIdentity stay diagnosable in both configurations', async () => {
  for (const killOrphaned of [false, true]) {
    const env = H.makeEnv(`f3-03-legacy-${killOrphaned}`);
    const seedConfig = H.writeConfig(env, { __name: `f303seed${killOrphaned}` });
    const taskFile = H.writeTask(env, 'task.md', 'FAKE_EXIT=0\n');
    const seed = await H.startBridge(seedConfig, env, { name: `f303-seed-${killOrphaned}` });
    const submitted = await H.callTool(seed.client, 'dsh_submit', {
      requestId: 'f303-legacy',
      workspaceId: 'impl',
      taskFile,
      mode: 'implement',
    });
    const jobId = submitted.payload.jobId;
    await H.waitForTerminal(seed.client, jobId);
    await seed.close();
    await H.sleep(300);

    const sentinel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    try {
      const jobFile = path.join(env.state, 'jobs', jobId, 'job.json');
      const record = H.readJson(jobFile);
      record.status = 'running';
      record.endedAt = null;
      record.pid = sentinel.pid;
      record.recovered = false;
      record.cleanup = null;
      delete record.childIdentity; // legacy format: the field does not exist
      fs.writeFileSync(jobFile, JSON.stringify(record, null, 2));

      const bridge = await H.startBridge(
        H.writeConfig(env, { __name: `f303run${killOrphaned}`, recovery: { killOrphanedChildrenOnStart: killOrphaned } }),
        env,
        { name: `f303-run-${killOrphaned}` },
      );
      try {
        const health = await H.callTool(bridge.client, 'dsh_health');
        assert.equal(alive(bridge.serverPid()), true, 'the service must stay alive for a legacy record');
        assert.equal(health.payload.orphanBlock.pids.includes(sentinel.pid), true, 'legacy identity is unverifiable, so it blocks');
        assert.equal(alive(sentinel.pid), true, 'a legacy record never authorizes a kill');
        const error = await H.callToolExpectError(bridge.client, 'dsh_submit', {
          requestId: 'f303-blocked',
          workspaceId: 'impl',
          taskFile,
          mode: 'implement',
        });
        assert.equal(error.code, 'ORPHAN_UNRESOLVED');
        assert.match(String(error.message), /cannot prove/);
        assert.match(String(error.message), /Inspect the pid yourself/);
        const job = (await H.callTool(bridge.client, 'dsh_status', { jobId })).payload.job;
        assert.equal(job.status, 'interrupted');
      } finally {
        await bridge.close();
      }
      const stderr = fs.readFileSync(path.join(env.logs, `f303-run-${killOrphaned}.stderr.log`), 'utf8');
      assert.doesNotMatch(stderr, /FATAL unhandled rejection/, 'no unhandled rejection may escape');
    } finally {
      if (alive(sentinel.pid)) sentinel.kill('SIGKILL');
    }
  }
});

test('F3-04 the delivered source manifest matches the delivered files exactly', () => {
  const manifestFile = path.join(ROOT, 'reports', 'source-manifest.json');
  assert.equal(fs.existsSync(manifestFile), true, 'run tools/source-manifest.mjs first');
  const manifest = H.readJson(manifestFile);
  const listed = new Set(manifest.files.map((entry) => entry.path));

  const includeFiles = ['README.md', 'package.json', 'package-lock.json', 'tsconfig.json', '.gitignore', '.gitattributes'];
  const includeDirs = ['src', 'test', 'fixtures', 'config', 'tools', 'audits', 'reports'];
  const excludeDirs = new Set(['node_modules', 'dist', 'state', '.tmp', 'logs', '.git']);
  const excludePrefixes = ['probe-fixtures-', 'host-fixtures-', 'boundary-fixtures-', 'process-fixtures-', 'new-host-fixtures-', 'ownership-fixtures-', 'heartbeat-host-fixtures-', 'guard-fixtures-', 'pid-query-fixtures-', 'denied-release-host-fixtures-'];
  const excludeNames = new Set(['source-manifest.json', 'junit.xml', 'last-run.json', 'clean-checkout-verification.json', 'r4-exit-order.json', 'r4-spawn-window.json']);

  const onDisk = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const parts = rel.split('/');
      if (parts.some((part) => excludeDirs.has(part))) continue;
      if (parts.some((part) => excludePrefixes.some((p) => part.startsWith(p)))) continue;
      if (excludeNames.has(entry.name) || entry.name.endsWith('.log')) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile()) onDisk.push(rel);
    }
  };
  for (const file of includeFiles) if (fs.existsSync(path.join(ROOT, file))) onDisk.push(file);
  for (const dir of includeDirs) if (fs.existsSync(path.join(ROOT, dir))) walk(path.join(ROOT, dir), dir);

  const missingFromManifest = onDisk.filter((rel) => !listed.has(rel)).sort();
  const missingOnDisk = [...listed].filter((rel) => !fs.existsSync(path.join(ROOT, rel))).sort();
  assert.deepEqual(missingFromManifest, [], 'every delivered file must be listed in the manifest');
  assert.deepEqual(missingOnDisk, [], 'every manifest entry must exist on disk');
  assert.equal(
    manifest.files.some((entry) => entry.path.endsWith('.log')),
    false,
    'transient run logs must not be part of the delivered manifest',
  );
  void BridgeError;
  void JobManager;
  void loadConfig;
  void assert;
});
