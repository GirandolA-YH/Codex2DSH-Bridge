/**
 * FIX-004 F4-01 regressions: every lock mutation is covered by one effective
 * arbitration, so an old operation can never displace, revoke or delete a newer
 * winner.
 *
 * Layout under test:
 *   owner.lock                  immutable owner identity for this generation
 *   owner.heartbeat.<lockId>    freshness for exactly that generation
 *   owner.arb/guard.json        arbitration guard (holder pid)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireOwnership, peekOwnership, peekHeartbeat } from '../dist/src/ownership.js';
import * as H from './helpers/harness.mjs';

const OPTIONS = { staleHeartbeatMs: 250, heartbeatMs: 600000, bridgeVersion: 'test' };

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ageHeartbeat(state, lockId) {
  fs.writeFileSync(
    path.join(state, `owner.heartbeat.${lockId}`),
    `${JSON.stringify({ schema: 'dsh-codex-bridge/owner-heartbeat/v1', lockId, pid: process.pid, heartbeatAt: new Date(0).toISOString() }, null, 2)}\n`,
  );
}

/** Run `body` with a hook installed on a specific fs call site. */
function withHook(target, name, hook, body) {
  const original = target[name];
  target[name] = function patched(...args) {
    hook(...args);
    return original.apply(this, args);
  };
  try {
    return body();
  } finally {
    target[name] = original;
  }
}

test('F4-01 a heartbeat that resumes after a takeover cannot resurrect its owner', () => {
  const env = H.makeEnv('f4-heartbeat');
  const state = env.state;
  const a = acquireOwnership(state, OPTIONS);
  assert.equal(a.owned, true);
  ageHeartbeat(state, a.lockId);
  const sidecar = path.join(state, `owner.heartbeat.${a.lockId}`);
  let b = null;
  let injected = false;
  try {
    withHook(
      fs,
      'renameSync',
      (from, to) => {
        if (!injected && path.resolve(String(to)) === path.resolve(sidecar)) {
          injected = true;
          b = acquireOwnership(state, OPTIONS); // the winner takes over during the pause
        }
      },
      () => a.heartbeat(),
    );
    assert.equal(injected, true, 'the heartbeat pause point must have been exercised');
    assert.equal(b.owned, true, 'a stale owner can legitimately be taken over');
    const current = peekOwnership(state);
    assert.equal(current.lockId, b.lockId, 'the resumed heartbeat did not overwrite the winner lock');
    assert.equal(a.owned, false, 'the old owner has no rights after the takeover');
    assert.equal(a.view().mode, 'lost');
    assert.notEqual(peekHeartbeat(state, b.lockId), null, "the winner's heartbeat is intact");
  } finally {
    a.release();
    b?.release();
  }
});

test('F4-01 a release can neither delete a winner lock nor outlive its own ownership', () => {
  const env = H.makeEnv('f4-release');
  const state = env.state;
  const a = acquireOwnership(state, OPTIONS);
  ageHeartbeat(state, a.lockId);
  const b = acquireOwnership(state, OPTIONS);
  assert.equal(b.owned, true, 'B takes over the stale owner');

  // A no longer owns anything: its release must leave B untouched.
  a.release();
  assert.equal(fs.existsSync(path.join(state, 'owner.lock')), true, "the winner's lock survives the old release");
  assert.equal(peekOwnership(state).lockId, b.lockId);
  assert.notEqual(peekHeartbeat(state, b.lockId), null);
  assert.equal(b.owned, true);

  // And with a pause inside the delete of its own lock, a competing claim is
  // refused while the arbitration lock is held by the releasing owner.
  b.release();
  const c = acquireOwnership(state, OPTIONS);
  assert.equal(c.owned, true, 'the released lock is claimable again');
  const lockFile = path.join(state, 'owner.lock');
  let contender = null;
  withHook(
    fs,
    'rmSync',
    (target) => {
      if (contender === null && path.resolve(String(target)) === path.resolve(lockFile)) {
        contender = acquireOwnership(state, OPTIONS);
      }
    },
    () => c.release(),
  );
  assert.notEqual(contender, null, 'the release pause point must have been exercised');
  assert.equal(contender.owned, false, 'a claim during another handle’s critical section is refused');
  assert.equal(fs.existsSync(lockFile), false, 'the owner that still held the lock removed it');
  contender.release();
});

test('F4-01 a refresh visible before the swap aborts the takeover', () => {
  const env = H.makeEnv('f4-takeover-recheck');
  const state = env.state;
  const a = acquireOwnership(state, OPTIONS);
  ageHeartbeat(state, a.lockId);
  let refreshed = false;
  let b = null;
  try {
    // The owner refreshes just before the contender enters its critical section:
    // the contender must read the fresh heartbeat and refuse.
    withHook(
      fs,
      'mkdirSync',
      (target) => {
        if (!refreshed && String(target).endsWith('owner.arb')) {
          refreshed = true;
          a.heartbeat();
        }
      },
      () => {
        b = acquireOwnership(state, OPTIONS);
      },
    );
    assert.equal(refreshed, true, 'the refresh injection must have been exercised');
    assert.equal(b.owned, false, 'a fresh heartbeat makes the lock foreign, not takeable');
    assert.equal(peekOwnership(state).lockId, a.lockId, 'the owner lock is untouched');
    assert.equal(a.owned, true, 'the owner keeps its rights');

    // Control: once the refresh ages out again the takeover succeeds.
    ageHeartbeat(state, a.lockId);
    const takeover = acquireOwnership(state, OPTIONS);
    assert.equal(takeover.owned, true, 'a genuinely stale owner is still recoverable');
    takeover.release();
  } finally {
    a.release();
    b?.release();
  }
});

test('F4-01 a live arbitration holder is never reclaimed by age; a dead one is', () => {
  const env = H.makeEnv('f4-arbitration');
  const state = env.state;
  const guard = path.join(state, 'owner.arb', 'guard.json');
  const arb = path.join(state, 'owner.arb');

  // (a) A stale lock must be taken over, but another process is inside its
  //     critical section: the guard records a live pid, so ageing the guard file
  //     and the directory must not let this starter steal it.
  const staleLock = {
    schema: 'dsh-codex-bridge/owner-lock/v1',
    lockId: 'stale-owner',
    pid: 999998,
    hostname: 'x',
    startedAt: new Date(0).toISOString(),
    heartbeatAt: new Date(0).toISOString(),
    bridgeVersion: 'test',
  };
  fs.writeFileSync(path.join(state, 'owner.lock'), `${JSON.stringify(staleLock, null, 2)}\n`);
  fs.mkdirSync(arb);
  fs.writeFileSync(
    guard,
    `${JSON.stringify({ schema: 'dsh-codex-bridge/arb-guard/v1', lockId: 'live-holder', pid: process.pid, heartbeatAt: new Date(0).toISOString() }, null, 2)}\n`,
  );
  const old = new Date(Date.now() - OPTIONS.staleHeartbeatMs - 60000);
  fs.utimesSync(arb, old, old);
  fs.utimesSync(guard, old, old);
  const refused = acquireOwnership(state, OPTIONS);
  assert.equal(refused.owned, false, 'an aged but live arbitration guard is never stolen');
  assert.match(String(refused.view().diagnostic), /cannot be proven stopped|arbitration/);

  // (b) A guard whose recorded holder is dead is reclaimable, and the starter
  //     can then take the stale lock over.
  fs.writeFileSync(
    guard,
    `${JSON.stringify({ schema: 'dsh-codex-bridge/arb-guard/v1', lockId: 'dead-holder', pid: 999999, heartbeatAt: new Date(0).toISOString() }, null, 2)}\n`,
  );
  const afterDeadHolder = acquireOwnership(state, OPTIONS);
  assert.equal(afterDeadHolder.owned, true, 'a guard whose holder is dead can be reclaimed');
  assert.equal(afterDeadHolder.mode, 'acquired-stale');
  afterDeadHolder.release();
  refused.release();
});

test('F4-01 real dual bridge: a paused heartbeat cannot steal back a healthy winner', async () => {
  const env = H.makeEnv('f4-real-heartbeat');
  const configPath = H.writeConfig(env, {
    __name: 'f4real',
    server: { logLevel: 'info' },
    ownership: { heartbeatMs: 300, staleHeartbeatMs: 1200 },
  });
  const lock = path.join(env.state, 'owner.lock');
  const ready = path.join(env.dir, 'a-heartbeat-paused.txt');
  const gate = path.join(env.dir, 'resume-heartbeat.txt');
  const wrapper = path.join(env.dir, 'paused-heartbeat-entry.mjs');
  fs.writeFileSync(
    wrapper,
    `import fs from 'node:fs';\nimport path from 'node:path';\nimport { pathToFileURL } from 'node:url';\n` +
      `const ready = process.env.F4_READY, gate = process.env.F4_GATE, entry = process.env.F4_ENTRY;\n` +
      `const rename = fs.renameSync;\nlet paused = false;\n` +
      `fs.renameSync = function (from, to) {\n` +
      `  try {\n` +
      `      if (!paused && String(to).includes('owner.heartbeat.') && fs.existsSync(to)) {\n` +
      `      paused = true; fs.writeFileSync(ready, String(Date.now()));\n` +
      `      const until = Date.now() + 30000;\n` +
      `      while (!fs.existsSync(gate)) {\n` +
      `        if (Date.now() > until) throw new Error('gate timed out');\n` +
      `        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);\n` +
      `      }\n` +
      `    }\n` +
      `  } catch { /* never break the heartbeat */ }\n` +
      `  return rename.call(fs, from, to);\n};\n` +
      `await import(pathToFileURL(entry).href);\n`,
  );

  const a = spawn(process.execPath, [wrapper, '--config', configPath], {
    cwd: env.dir,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, F4_READY: ready, F4_GATE: gate, F4_ENTRY: H.ENTRY, F4_ARB: path.join(env.state, 'owner.arb') },
  });
  let aErr = '';
  a.stdout.on('data', () => {});
  a.stderr.on('data', (chunk) => {
    aErr += chunk.toString('utf8');
  });
  a.stdin.on('error', () => {});
  let owner = null;
  let childPid = null;
  try {
    assert.equal(await H.waitFor(() => fs.existsSync(ready), 15000, 50), true, 'A must pause inside a heartbeat write');
    const ownerBefore = H.readJson(lock);
    assert.equal(ownerBefore.pid, a.pid, 'A owns the lock before the staleness window elapses');

    // Real elapsed time: A's heartbeat cannot advance while it is paused.
    await H.sleep(1600);
    owner = await H.startBridge(configPath, env, { name: 'f4-real-b' });
    const taskFile = H.writeTask(env, 'task.md', 'FAKE_SLEEP_MS=60000\n');
    const ack = await H.callTool(owner.client, 'dsh_submit', {
      requestId: 'f4-real-b',
      workspaceId: 'impl',
      taskFile,
      mode: 'implement',
    });
    await H.sleep(500);
    const running = (await H.callTool(owner.client, 'dsh_status', { jobId: ack.payload.jobId })).payload.job;
    assert.equal(running.status, 'running');
    childPid = running.pid;
    const winner = H.readJson(lock);
    assert.equal(winner.pid, owner.serverPid(), 'the healthy winner holds the lock');

    // Resume the old owner's heartbeat: it must not be able to reclaim anything.
    fs.writeFileSync(gate, 'resume');
    await H.sleep(1200);

    const after = H.readJson(lock);
    assert.equal(after.lockId, winner.lockId, 'the lock still names the winner');
    assert.equal(after.pid, winner.pid);
    assert.equal(alive(a.pid), true, 'A is still running, it simply has no rights');
    const stillRunning = (await H.callTool(owner.client, 'dsh_status', { jobId: ack.payload.jobId })).payload.job;
    assert.equal(stillRunning.status, 'running', "the winner's task was not disturbed");
    assert.equal(alive(childPid), true, "the winner's child process is untouched");
    assert.equal(peekHeartbeat(env.state, winner.lockId) !== null, true, "the winner's heartbeat sidecar survives");
    assert.doesNotMatch(aErr, /FATAL unhandled rejection/);
  } finally {
    fs.writeFileSync(gate, 'resume');
    if (owner !== null) await owner.close();
    if (alive(a.pid)) a.kill('SIGKILL');
    if (childPid !== null && alive(childPid)) await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(childPid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('close', () => resolve());
      killer.on('error', () => resolve());
    });
  }
});
