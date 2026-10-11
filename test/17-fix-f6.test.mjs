/**
 * FIX-006 F6-01 regressions: an unproven PID query is never death evidence.
 *
 * Only a successful query, EPERM (protected but present) or ESRCH (absent) say
 * something about a pid. Invalid/out-of-range pids and every other error code
 * are `unknown`, and `unknown` must never authorize reclaiming a guard, deleting
 * an owner lock or confirming a cleanup.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { queryProcessLiveness, isProcessAlive, isProcessProvenDead, MAX_QUERYABLE_PID } from '../dist/src/proctree.js';
import { acquireOwnership, peekOwnership } from '../dist/src/ownership.js';
import * as H from './helpers/harness.mjs';

const OPTIONS = { staleHeartbeatMs: 30000, heartbeatMs: 600000, bridgeVersion: 'test' };

function ageHeartbeat(state, lockId) {
  fs.writeFileSync(
    path.join(state, `owner.heartbeat.${lockId}`),
    `${JSON.stringify({ schema: 'dsh-codex-bridge/owner-heartbeat/v1', lockId, pid: process.pid, heartbeatAt: new Date(0).toISOString() })}\n`,
  );
}

function writeGuard(state, pid) {
  const dir = path.join(state, 'owner.arb');
  fs.mkdirSync(dir, { recursive: true });
  const raw = `${JSON.stringify({ schema: 'dsh-codex-bridge/arb-guard/v1', lockId: 'observed-holder', pid, heartbeatAt: new Date().toISOString() })}\n`;
  fs.writeFileSync(path.join(dir, 'guard.json'), raw);
  return { dir, guard: path.join(dir, 'guard.json'), raw };
}

function withInjectedKill(pid, error, body) {
  const realKill = process.kill;
  process.kill = function patched(target, signal) {
    if (target === pid && signal === 0) {
      if (error === null) {
        try {
          return realKill.call(process, target, signal);
        } catch (thrown) {
          throw thrown;
        }
      }
      throw Object.assign(new Error('injected query failure'), error.code === undefined ? {} : { code: error.code });
    }
    return realKill.call(process, target, signal);
  };
  try {
    return body();
  } finally {
    process.kill = realKill;
  }
}

test('F6-01 the liveness query is tri-state and only ESRCH proves death', () => {
  assert.equal(queryProcessLiveness(process.pid), 'alive');
  assert.equal(queryProcessLiveness(987654), 'dead', 'a definitively absent pid is the only death evidence');
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessProvenDead(987654), true);

  for (const bad of [0, -1, 1.5, Number.NaN, MAX_QUERYABLE_PID + 1, 2147483648, Number.MAX_SAFE_INTEGER]) {
    assert.equal(queryProcessLiveness(bad), 'unknown', `${bad} is not a queryable pid`);
    assert.equal(isProcessProvenDead(bad), false);
    assert.equal(isProcessAlive(bad), false);
  }
  assert.equal(MAX_QUERYABLE_PID, 2147483647);

  for (const code of ['EIO', 'EINVAL', 'ENOSYS', 'ERR_INVALID_ARG_TYPE', 'EACCES', 'UNKNOWN', undefined]) {
    withInjectedKill(process.pid, { code }, () => {
      assert.equal(queryProcessLiveness(process.pid), 'unknown', `code ${String(code)} must be unknown`);
      assert.equal(isProcessProvenDead(process.pid), false, `code ${String(code)} must not prove death`);
    });
  }
  withInjectedKill(process.pid, { code: 'EPERM' }, () => {
    assert.equal(queryProcessLiveness(process.pid), 'alive', 'EPERM means present but protected');
  });
  withInjectedKill(987654, { code: 'ESRCH' }, () => {
    assert.equal(queryProcessLiveness(987654), 'dead');
  });
});

test('F6-01 an unproven query never authorizes reclaiming a live guard', () => {
  const cases = [
    { id: 'EIO', pid: process.pid, error: { code: 'EIO' }, acquire: false },
    { id: 'EINVAL', pid: process.pid, error: { code: 'EINVAL' }, acquire: false },
    { id: 'unknown-code', pid: process.pid, error: { code: 'EWHATEVER' }, acquire: false },
    { id: 'no-code', pid: process.pid, error: {}, acquire: false },
    { id: 'EPERM', pid: process.pid, error: { code: 'EPERM' }, acquire: false },
    { id: 'invalid-range', pid: 2147483648, error: null, acquire: false },
    { id: 'real-dead', pid: 987654, error: null, acquire: true },
  ];
  for (const item of cases) {
    const env = H.makeEnv(`f6-${item.id}`);
    const state = env.state;
    const a = acquireOwnership(state, OPTIONS);
    ageHeartbeat(state, a.lockId);
    const { dir, guard, raw } = writeGuard(state, item.pid);

    let enteredSharedDelete = false;
    const lockFile = path.join(state, 'owner.lock');
    const realRm = fs.rmSync;
    fs.rmSync = function patched(target, ...rest) {
      if (path.resolve(String(target)) === path.resolve(lockFile)) enteredSharedDelete = true;
      return realRm.call(fs, target, ...rest);
    };
    let contender;
    try {
      contender = item.error === null
        ? acquireOwnership(state, OPTIONS)
        : withInjectedKill(item.pid, item.error, () => acquireOwnership(state, OPTIONS));
    } finally {
      fs.rmSync = realRm;
    }
    assert.equal(contender.owned, item.acquire, `${item.id}: expected acquire=${item.acquire}`);
    if (!item.acquire) {
      assert.equal(fs.existsSync(guard), true, `${item.id}: the observed guard is preserved`);
      assert.equal(fs.readFileSync(guard, 'utf8'), raw, `${item.id}: the guard is byte-identical`);
      assert.equal(fs.existsSync(dir), true, `${item.id}: the arbitration directory is preserved`);
      assert.match(String(contender.view().diagnostic), /cannot be proven stopped|not proven/i);
      assert.equal(enteredSharedDelete, false, `${item.id}: no shared lock deletion`);
      assert.equal(peekOwnership(state).lockId, a.lockId, `${item.id}: the owner lock is untouched`);
    }
    contender.release();
    a.release();
  }
});

test('F6-01 release stays conservative when the guard pid cannot be queried', () => {
  const env = H.makeEnv('f6-release-unknown');
  const state = env.state;
  const a = acquireOwnership(state, OPTIONS);
  ageHeartbeat(state, a.lockId);
  const holderPid = process.pid;
  writeGuard(state, holderPid);
  const lockFile = path.join(state, 'owner.lock');

  let enteredSharedDelete = false;
  const realRm = fs.rmSync;
  fs.rmSync = function patched(target, ...rest) {
    if (path.resolve(String(target)) === path.resolve(lockFile)) enteredSharedDelete = true;
    return realRm.call(fs, target, ...rest);
  };
  try {
    withInjectedKill(holderPid, { code: 'EIO' }, () => a.release());
  } finally {
    fs.rmSync = realRm;
  }
  assert.equal(enteredSharedDelete, false, 'an unknown holder state must not reach the shared delete');
  assert.equal(fs.existsSync(lockFile), true);
  assert.match(String(a.view().diagnostic), /refusing to remove the shared owner lock/);
});

test('F6-01 unknown liveness never becomes confirmed cleanup or a released block', () => {
  // Call-site contract: the helpers used by cleanup attribution and orphan
  // blocking treat "unknown" as not-dead, so nothing is confirmed or released.
  for (const code of ['EIO', 'EINVAL', undefined]) {
    withInjectedKill(4242, { code }, () => {
      assert.equal(isProcessProvenDead(4242), false, `cleanup must not be confirmed for code ${String(code)}`);
      assert.notEqual(queryProcessLiveness(4242), 'dead');
    });
  }
  assert.equal(isProcessProvenDead(2147483648), false, 'an out-of-range pid is never proven dead');
});
