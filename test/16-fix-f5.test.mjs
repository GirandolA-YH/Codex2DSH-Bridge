/**
 * FIX-005 F5-01 regressions.
 *
 * 1. A denied/uncertain arbitration must never enter the shared delete: the
 *    owner lock is left alone and the refusal is diagnosable.
 * 2. A missing, unreadable, unparsable or structurally invalid guard is "holder
 *    state unknown", never "holder is dead" — no reclaim, no ownership.
 * 3. Reclaim is generational: it renames the observed guard to a unique name,
 *    verifies it is still that very guard, and restores anything newer it may
 *    have moved, so an old reclaimer cannot delete a newer live guard.
 * 4. Real Windows dual bridge behind a denied release keeps the winner's lock,
 *    task and child intact.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { acquireOwnership, peekOwnership } from '../dist/src/ownership.js';
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

function guardWith(state, holderPid, lockId = 'live-holder') {
  const dir = path.join(state, 'owner.arb');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'guard.json'),
    `${JSON.stringify({ schema: 'dsh-codex-bridge/arb-guard/v1', lockId, pid: holderPid, heartbeatAt: new Date().toISOString() }, null, 2)}\n`,
  );
  return path.join(dir, 'guard.json');
}

test('F5-01 a denied arbitration never enters the shared delete', () => {
  for (const kind of ['live-holder', 'unreadable-guard', 'directory-replaced-by-file']) {
    const env = H.makeEnv(`f5-denied-${kind}`);
    const state = env.state;
    const lockFile = path.join(state, 'owner.lock');
    const a = acquireOwnership(state, OPTIONS);
    ageHeartbeat(state, a.lockId);
    if (kind === 'live-holder') guardWith(state, process.pid);
    else if (kind === 'unreadable-guard') {
      const dir = path.join(state, 'owner.arb');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'guard.json'), '{ not json');
    } else {
      fs.writeFileSync(path.join(state, 'owner.arb'), 'a regular file where the arbitration directory should be');
    }

    let enteredSharedDelete = false;
    const realRm = fs.rmSync;
    fs.rmSync = function patched(target, ...rest) {
      if (path.resolve(String(target)) === path.resolve(lockFile)) enteredSharedDelete = true;
      return realRm.call(fs, target, ...rest);
    };
    try {
      a.release();
    } finally {
      fs.rmSync = realRm;
    }
    assert.equal(enteredSharedDelete, false, `${kind}: release must not touch the shared lock when arbitration is denied`);
    assert.equal(fs.existsSync(lockFile), true, `${kind}: the owner lock is left in place`);
    assert.match(String(a.view().diagnostic), /refusing to remove the shared owner lock/);
    a.release();
    if (kind !== 'directory-replaced-by-file') fs.writeFileSync(path.join(state, 'owner.arb', 'guard.json'), '{}');
  }
});

test('F5-01 an invalid or unreadable guard is never treated as a dead holder', () => {
  const malformed = [
    undefined, // no guard file at all
    '{ not json',
    '{}',
    JSON.stringify({ lockId: 'x' }),
    JSON.stringify({ pid: process.pid }),
    JSON.stringify({ lockId: 'x', pid: 'not-a-pid', heartbeatAt: new Date().toISOString() }),
    JSON.stringify({ lockId: 'x', pid: 0, heartbeatAt: new Date().toISOString() }),
    JSON.stringify({ lockId: 'x', pid: -7, heartbeatAt: new Date().toISOString() }),
    JSON.stringify({ lockId: 'x', pid: 1.5, heartbeatAt: new Date().toISOString() }),
    JSON.stringify({ lockId: '', pid: 999999, heartbeatAt: new Date().toISOString() }),
    JSON.stringify({ lockId: 'x', pid: 999999 }),
    JSON.stringify({ lockId: 'x', pid: 999999, heartbeatAt: '' }),
  ];
  for (const [index, raw] of malformed.entries()) {
    const env = H.makeEnv(`f5-guard-${index}`);
    const state = env.state;
    const a = acquireOwnership(state, OPTIONS);
    ageHeartbeat(state, a.lockId);
    const dir = path.join(state, 'owner.arb');
    fs.mkdirSync(dir, { recursive: true });
    if (raw !== undefined) fs.writeFileSync(path.join(dir, 'guard.json'), raw);

    const contender = acquireOwnership(state, OPTIONS);
    assert.equal(contender.owned, false, `guard ${index} (${String(raw)}) must not authorize a takeover`);
    assert.equal(fs.existsSync(dir), true, `guard ${index}: the arbitration directory is preserved`);
    if (raw !== undefined) assert.equal(fs.existsSync(path.join(dir, 'guard.json')), true, `guard ${index}: the guard file is preserved`);
    else assert.equal(fs.readdirSync(dir).length, 0, 'an empty arbitration directory stays empty');
    a.release();
    contender.release();
  }

  // Control: a fully valid guard whose holder is provably dead is reclaimable.
  const env = H.makeEnv('f5-guard-control');
  const state = env.state;
  const a = acquireOwnership(state, OPTIONS);
  ageHeartbeat(state, a.lockId);
  const guard = guardWith(state, 999999, 'dead-holder');
  const reclaimer = acquireOwnership(state, OPTIONS);
  assert.equal(reclaimer.owned, true, 'a provably dead holder is still recoverable');
  assert.equal(reclaimer.mode, 'acquired-stale');
  reclaimer.release();
  a.release();
  void guard;
});

test('F5-01 an old reclaimer cannot delete a newer live guard', () => {
  const env = H.makeEnv('f5-reclaim-generation');
  const state = env.state;
  const a = acquireOwnership(state, OPTIONS);
  ageHeartbeat(state, a.lockId);
  const dir = path.join(state, 'owner.arb');
  const guard = guardWith(state, 999999, 'dead-generation');

  let injected = false;
  let liveGuardBeforeResume = false;
  let claimant = null;
  const realRename = fs.renameSync;
  fs.renameSync = function patched(from, to, ...rest) {
    if (!injected && path.resolve(String(from)) === path.resolve(guard)) {
      injected = true;
      // Another reclaimer finishes first: old generation removed, fresh live
      // generation established at the canonical path.
      realRename.call(fs, guard, `${guard}.other`);
      fs.rmSync(`${guard}.other`, { force: true });
      fs.rmdirSync(dir);
      fs.mkdirSync(dir);
      fs.writeFileSync(guard, `${JSON.stringify({ schema: 'dsh-codex-bridge/arb-guard/v1', lockId: 'new-live-holder', pid: process.pid, heartbeatAt: new Date().toISOString() })}\n`);
      liveGuardBeforeResume = true;
    }
    return realRename.call(fs, from, to, ...rest);
  };
  try {
    claimant = acquireOwnership(state, OPTIONS);
  } finally {
    fs.renameSync = realRename;
  }
  assert.equal(injected, true, 'the reclaim pause point must have been exercised');
  assert.equal(liveGuardBeforeResume, true);
  const after = fs.existsSync(guard) ? H.readJson(guard) : null;
  assert.equal(after?.lockId, 'new-live-holder', "the newer live guard must survive the old reclaimer");
  assert.equal(claimant.owned, false, 'the old reclaimer must refuse once a live generation is present');
  a.release();
  claimant.release();
});

test('F5-01 real dual bridge: a denied release cannot stop the winner', async () => {
  const env = H.makeEnv('f5-real-denied');
  const configPath = H.writeConfig(env, {
    __name: 'f5real',
    ownership: { heartbeatMs: 300, staleHeartbeatMs: 1200 },
  });
  const lock = path.join(env.state, 'owner.lock');
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  let a = null;
  let b = null;
  let childPid = null;
  try {
    a = await H.startBridge(configPath, env, { name: 'f5-real-a' });
    const aOwner = H.readJson(lock);
    guardWith(env.state, holder.pid, 'self-created-holder');
    // A's clean shutdown must refuse to remove the shared lock while the holder lives.
    await a.close();
    a = null;
    assert.equal(fs.existsSync(lock), true, "A's denied release leaves the shared lock in place");
    assert.equal(peekOwnership(env.state).lockId, aOwner.lockId);

    // The holder stops: B may legitimately take the abandoned lock over.
    holder.kill('SIGKILL');
    await H.sleep(300);
    b = await H.startBridge(configPath, env, { name: 'f5-real-b' });
    const taskFile = H.writeTask(env, 'task.md', 'FAKE_SLEEP_MS=60000\n');
    const ack = await H.callTool(b.client, 'dsh_submit', {
      requestId: 'f5-real-b',
      workspaceId: 'impl',
      taskFile,
      mode: 'implement',
    });
    await H.sleep(500);
    const running = (await H.callTool(b.client, 'dsh_status', { jobId: ack.payload.jobId })).payload.job;
    assert.equal(running.status, 'running');
    childPid = running.pid;
    const winner = H.readJson(lock);
    assert.equal(winner.pid, b.serverPid(), 'the healthy winner owns the lock');
    assert.equal(alive(childPid), true);
    const health = await H.callTool(b.client, 'dsh_health');
    assert.equal(health.payload.ownership.owned, true);
    assert.equal(peekOwnership(env.state).lockId, winner.lockId, 'nothing deleted the winner lock');
  } finally {
    if (holder.pid !== undefined && alive(holder.pid)) holder.kill('SIGKILL');
    if (b !== null) await b.close();
    if (a !== null) await a.close();
    if (childPid !== null && alive(childPid)) {
      await new Promise((resolve) => {
        const killer = spawn('taskkill', ['/PID', String(childPid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('close', () => resolve());
        killer.on('error', () => resolve());
      });
    }
  }
});
