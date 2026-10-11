/**
 * FIX-001 R03 (cleanup ordering, slot ownership, elapsed audit evidence) and
 * R04 (state-directory exclusivity), with real Windows fake processes.
 *
 * Real-process coverage: cancel/timeout/disconnect must not release the
 * execution slot, nor freeze audit evidence, before the owned process tree is
 * confirmed stopped. The injected `killBehaviour` modes make a stop slow or a
 * no-op so the "could not confirm" path is exercised with a live child.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { JobManager } from '../dist/src/jobs.js';
import { loadConfig } from '../dist/src/config.js';
import { acquireOwnership, peekOwnership } from '../dist/src/ownership.js';
import { BridgeError } from '../dist/src/errors.js';
import * as H from './helpers/harness.mjs';

function heartbeatPid(file) {
  if (!fs.existsSync(file)) return null;
  const match = /^pid=(\d+)$/.exec(fs.readFileSync(file, 'utf8').split('\n')[0].trim());
  return match === null ? null : Number(match[1]);
}

function alive(pid) {
  if (pid === null || pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function taskkill(pid) {
  if (!alive(pid)) return;
  await new Promise((resolve) => {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('close', () => resolve());
    killer.on('error', () => resolve());
  });
}

async function waitForStatus(client, jobId, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    const view = (await H.callTool(client, 'dsh_status', { jobId })).payload.job;
    last = view;
    if (predicate(view)) return view;
    if (Date.now() > deadline) return last;
    await H.sleep(100);
  }
}

/** Deterministic in-process runner double, mirroring the audit probe contract. */
class ControlledRunner {
  constructor(behaviour = 'deferred') {
    this.type = 'fake';
    this.behaviour = behaviour;
    this.runs = [];
  }

  describe() {
    return { type: 'fake', available: true, diagnostic: null, commandTemplate: '<in-process controlled runner>', details: {} };
  }

  start(spec, events) {
    const run = { spec, events, alive: true, resolveKill: null };
    this.runs.push(run);
    return {
      pid: undefined,
      child: null,
      command: ['<in-process>'],
      kill: () => {
        if (this.behaviour === 'ignored') return Promise.resolve(null);
        return new Promise((resolve) => {
          run.resolveKill = () => {
            run.alive = false;
            events.onExit(null, 'SIGKILL');
            resolve(null);
          };
        });
      },
    };
  }

  finish(index = 0) {
    const run = this.runs[index];
    if (run === undefined) return;
    run.alive = false;
    run.events.onExit(0, null);
  }
}

function requestFor(f, requestId, mode = 'implement') {
  return { requestId, workspaceId: mode === 'audit' ? 'audit' : 'impl', taskFile: f.taskFile, mode };
}

test('R03 the execution slot stays occupied until a real process tree is confirmed stopped', async () => {
  const env = H.makeEnv('r03-real');
  const configPath = H.writeConfig(env, { __name: 'r03real' });
  const heartbeat = path.join(env.dir, 'heartbeat.txt');
  const taskFile = H.writeTask(env, 'tree.md', `FAKE_SPAWN_CHILD=${heartbeat}\nFAKE_SLEEP_MS=60000\n`);
  const bridge = await H.startBridge(configPath, env, { name: 'r03real' });
  const sentinel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  try {
    const submit = await H.callTool(bridge.client, 'dsh_submit', {
      requestId: 'r03-cancel',
      workspaceId: 'impl',
      taskFile,
      mode: 'implement',
    });
    const jobId = submit.payload.jobId;
    await H.waitFor(() => fs.existsSync(heartbeat), 10000);
    const grandchildPid = heartbeatPid(heartbeat);

    const cancel = await H.callTool(bridge.client, 'dsh_cancel', { jobId });
    const view = cancel.payload.job;
    assert.equal(view.terminal, true, 'a fast stop confirms and finalizes within the request');
    assert.equal(view.status, 'cancelled');
    assert.equal(view.cleanup.confirmed, true);
    assert.equal(view.cleanup.method.includes('taskkill'), true, `expected a real termination method, saw ${view.cleanup.method}`);
    assert.equal(view.cleanup.killed, true);
    assert.equal(alive(grandchildPid), false, 'the descendant was terminated with the tree');
    assert.equal(alive(sentinel.pid), true, 'an unrelated process survived');

    const second = await H.callTool(bridge.client, 'dsh_submit', {
      requestId: 'r03-after',
      workspaceId: 'impl',
      taskFile: H.writeTask(env, 'after.md', 'FAKE_EXIT=0\nok\n'),
      mode: 'implement',
    });
    assert.equal(second.isError, false, 'the slot is free again after a confirmed stop');
    await H.waitForTerminal(bridge.client, second.payload.jobId);
  } finally {
    sentinel.kill('SIGKILL');
    await bridge.close();
  }
});

test('R03 an unconfirmed stop keeps the job in stopping and refuses new work', async () => {
  const env = H.makeEnv('r03-noop');
  const configPath = H.writeConfig(env, {
    __name: 'r03noop',
    cleanup: { confirmTimeoutMs: 400, killTimeoutMs: 5000 },
    runner: { fake: { killBehaviour: { mode: 'noop', delayMs: 0 } } },
  });
  const taskFile = H.writeTask(env, 'long.md', 'FAKE_SLEEP_MS=60000\nstill alive\n');
  const bridge = await H.startBridge(configPath, env, { name: 'r03noop' });
  try {
    const submit = await H.callTool(bridge.client, 'dsh_submit', {
      requestId: 'r03-noop',
      workspaceId: 'impl',
      taskFile,
      mode: 'implement',
    });
    const jobId = submit.payload.jobId;
    await H.sleep(500);
    const running = (await H.callTool(bridge.client, 'dsh_status', { jobId })).payload.job;
    assert.equal(running.status, 'running');
    const childPid = running.pid;
    assert.equal(alive(childPid), true);

    const cancel = await H.callTool(bridge.client, 'dsh_cancel', { jobId });
    assert.equal(cancel.payload.job.status, 'stopping');
    assert.equal(cancel.payload.job.terminal, false);
    assert.equal(cancel.payload.job.cleanup.confirmed, false);
    assert.equal(cancel.payload.kill.method, 'unconfirmed');
    assert.equal(alive(childPid), true, 'the injected no-op kill left the child alive');

    const blocked = await H.callToolExpectError(bridge.client, 'dsh_submit', {
      requestId: 'r03-noop-second',
      workspaceId: 'impl',
      taskFile: H.writeTask(env, 'second.md', 'FAKE_EXIT=0\nsecond\n'),
      mode: 'implement',
    });
    assert.equal(blocked.code, 'BUSY');

    const retry = await H.callTool(bridge.client, 'dsh_cancel', { jobId });
    assert.equal(retry.payload.job.status, 'stopping', 'a retry is attempted, still unconfirmed');

    // The child now really stops (the test does what the failed adapter did not).
    // Because the stop was not performed by a verified tree kill, the bridge must
    // report it as unconfirmed (FIX-002 F2-02) while still releasing the slot.
    await taskkill(childPid);
    const finished = await waitForStatus(bridge.client, jobId, (view) => view.terminal, 10000);
    assert.equal(finished.status, 'cancelled');
    assert.equal(finished.cleanup.confirmed, false, 'an external kill is not an attributed tree kill');
    assert.match(String(finished.cleanup.error), /verified tree kill/);

    const after = await H.callTool(bridge.client, 'dsh_submit', {
      requestId: 'r03-noop-after',
      workspaceId: 'impl',
      taskFile: H.writeTask(env, 'after.md', 'FAKE_EXIT=0\nok\n'),
      mode: 'implement',
    });
    assert.equal(after.isError, false, 'the slot is released once the stop is confirmed');
    await H.waitForTerminal(bridge.client, after.payload.jobId);
  } finally {
    await bridge.close();
  }
});

test('R03 a slow stop reports stopping first and finalizes only after confirmation', async () => {
  const env = H.makeEnv('r03-slow');
  const configPath = H.writeConfig(env, {
    __name: 'r03slow',
    cleanup: { confirmTimeoutMs: 300, killTimeoutMs: 5000 },
    runner: { fake: { killBehaviour: { mode: 'normal', delayMs: 1500 } } },
  });
  const taskFile = H.writeTask(env, 'slow.md', 'FAKE_SLEEP_MS=60000\nslow death\n');
  const bridge = await H.startBridge(configPath, env, { name: 'r03slow' });
  try {
    const submit = await H.callTool(bridge.client, 'dsh_submit', {
      requestId: 'r03-slow',
      workspaceId: 'impl',
      taskFile,
      mode: 'implement',
    });
    const jobId = submit.payload.jobId;
    await H.sleep(400);
    const cancel = await H.callTool(bridge.client, 'dsh_cancel', { jobId });
    assert.equal(cancel.payload.job.status, 'stopping');
    assert.equal(cancel.payload.job.cleanup.confirmed, false);

    const blocked = await H.callToolExpectError(bridge.client, 'dsh_submit', {
      requestId: 'r03-slow-second',
      workspaceId: 'impl',
      taskFile,
      mode: 'implement',
    });
    assert.equal(blocked.code, 'BUSY');

    // Attribution can be recorded a moment after the exit (the tree kill was
    // still running when the confirmation window closed), so poll for it.
    let finished = await waitForStatus(bridge.client, jobId, (view) => view.terminal, 15000);
    for (let attempt = 0; attempt < 30 && finished.cleanup.confirmed !== true; attempt += 1) {
      await H.sleep(100);
      finished = (await H.callTool(bridge.client, 'dsh_status', { jobId })).payload.job;
    }
    assert.equal(finished.status, 'cancelled');
    assert.equal(finished.cleanup.confirmed, true, 'the delayed tree kill proves provenance');
    assert.ok(finished.cleanup.attempts >= 1);
  } finally {
    await bridge.close();
  }
});

test('R03 a timeout that cannot be confirmed stays stopping with the slot held', async () => {
  const env = H.makeEnv('r03-timeout');
  const configPath = H.writeConfig(env, {
    __name: 'r03timeout',
    cleanup: { confirmTimeoutMs: 400, killTimeoutMs: 3000 },
    runner: { fake: { killBehaviour: { mode: 'noop', delayMs: 0 } } },
  });
  const taskFile = H.writeTask(env, 'timeout.md', 'FAKE_SLEEP_MS=60000\ntimeout\n');
  const bridge = await H.startBridge(configPath, env, { name: 'r03timeout' });
  try {
    const submit = await H.callTool(bridge.client, 'dsh_submit', {
      requestId: 'r03-timeout',
      workspaceId: 'impl',
      taskFile,
      mode: 'implement',
      timeoutSeconds: 1,
    });
    const jobId = submit.payload.jobId;
    const stopping = await waitForStatus(bridge.client, jobId, (view) => view.status === 'stopping', 10000);
    assert.equal(stopping.timedOut, true);
    assert.equal(stopping.cleanup.reason, 'timeout');
    assert.equal(stopping.cleanup.confirmed, false);

    const blocked = await H.callToolExpectError(bridge.client, 'dsh_submit', {
      requestId: 'r03-timeout-second',
      workspaceId: 'impl',
      taskFile,
      mode: 'implement',
    });
    assert.equal(blocked.code, 'BUSY');

    await taskkill(stopping.pid);
    const finished = await waitForStatus(bridge.client, jobId, (view) => view.terminal, 10000);
    assert.equal(finished.status, 'timed_out');
    assert.equal(finished.cleanup.confirmed, false, 'the unmatched no-op kill means no verified provenance');
  } finally {
    await bridge.close();
  }
});

test('R03 a normal disconnect stops and confirms the owned tree before exiting', async () => {
  const env = H.makeEnv('r03-disconnect');
  const configPath = H.writeConfig(env, { __name: 'r03disconnect' });
  const taskFile = H.writeTask(env, 'disconnect.md', 'FAKE_SLEEP_MS=60000\ndisconnect\n');
  const bridge = await H.startBridge(configPath, env, { name: 'r03disconnect' });
  const submit = await H.callTool(bridge.client, 'dsh_submit', {
    requestId: 'r03-disconnect',
    workspaceId: 'impl',
    taskFile,
    mode: 'implement',
  });
  const jobId = submit.payload.jobId;
  await H.sleep(500);
  const running = (await H.callTool(bridge.client, 'dsh_status', { jobId })).payload.job;
  const childPid = running.pid;
  await bridge.close();
  await H.sleep(1500);
  const record = H.readJson(path.join(env.state, 'jobs', jobId, 'job.json'));
  assert.equal(record.status, 'cancelled');
  assert.equal(record.cleanup.confirmed, true, 'shutdown waits for a verified stop');
  assert.equal(alive(childPid), false);
  const stderr = fs.readFileSync(bridge.stderrLog, 'utf8');
  assert.match(stderr, /cleanup confirmed/);
});

test('R03 in-process contract: deferred and ignored kill never release the slot or freeze audit evidence', async () => {
  const env = H.makeEnv('r03-contract');
  const configPath = H.writeConfig(env, { __name: 'r03contract' });
  const config = loadConfig(configPath);
  const taskFile = H.writeTask(env, 'audit-task.md', 'synthetic audit run\n');

  const deferred = new ControlledRunner('deferred');
  const manager = new JobManager(config, deferred);
  manager.init();
  const first = await manager.submit({ requestId: 'first', workspaceId: 'audit', taskFile, mode: 'audit' });
  await new Promise((resolve) => setImmediate(resolve));
  const cancellation = manager.cancel(first.jobId);
  const early = manager.status(first.jobId);
  assert.equal(early.status, 'stopping');
  assert.notEqual(early.audit.snapshotStable, true, 'audit stability is not frozen before the stop');
  assert.equal(deferred.runs[0].alive, true);

  fs.writeFileSync(path.join(deferred.runs[0].spec.cwd, 'late-write.txt'), 'written while stopping\n');
  let secondAccepted = false;
  try {
    await manager.submit({ requestId: 'second', workspaceId: 'impl', taskFile, mode: 'implement' });
    secondAccepted = true;
  } catch {
    secondAccepted = false;
  }
  assert.equal(secondAccepted, false, 'the slot is still occupied while the stop is pending');
  assert.equal(deferred.runs.filter((run) => run.alive).length, 1);

  deferred.runs[0].resolveKill();
  await cancellation;
  const late = manager.status(first.jobId);
  // The late write landed in the audit snapshot while cleanup was pending; the
  // final comparison must catch it and fail the audit rather than report stable.
  assert.equal(late.terminal, true);
  assert.equal(late.status, 'failed');
  assert.equal(late.error.code, 'AUDIT_SNAPSHOT_MODIFIED');
  assert.equal(late.audit.snapshotStable, false, 'the late write is covered by the final audit comparison');
  manager.releaseOwnership();

  const ignored = new ControlledRunner('ignored');
  const env2 = H.makeEnv('r03-contract-ignored');
  const config2 = loadConfig(H.writeConfig(env2, { __name: 'r03contractignored' }));
  const taskFile2 = H.writeTask(env2, 'task.md', 'synthetic\n');
  const manager2 = new JobManager(config2, ignored);
  manager2.init();
  const first2 = await manager2.submit({ requestId: 'first', workspaceId: 'impl', taskFile: taskFile2, mode: 'implement' });
  await new Promise((resolve) => setImmediate(resolve));
  const result = await manager2.cancel(first2.jobId);
  assert.equal(result.status, 'stopping');
  assert.equal(result.kill.method, 'unconfirmed');
  assert.equal(ignored.runs[0].alive, true);
  let secondAccepted2 = false;
  try {
    await manager2.submit({ requestId: 'second', workspaceId: 'impl', taskFile: taskFile2, mode: 'implement' });
    secondAccepted2 = true;
  } catch {
    secondAccepted2 = false;
  }
  assert.equal(secondAccepted2, false, 'an unconfirmed cleanup continues to occupy the slot');
  ignored.finish(0);
  manager2.releaseOwnership();
});

test('R04 a second real MCP server on the same state directory refuses to start', async () => {
  const env = H.makeEnv('r04-process');
  const configPath = H.writeConfig(env, { __name: 'r04process' });
  const taskFile = H.writeTask(env, 'owner.md', 'FAKE_SLEEP_MS=30000\nowner one\n');
  const first = await H.startBridge(configPath, env, { name: 'owner-one' });
  try {
    const submit = await H.callTool(first.client, 'dsh_submit', {
      requestId: 'owner-one',
      workspaceId: 'impl',
      taskFile,
      mode: 'implement',
    });
    const jobId = submit.payload.jobId;
    await H.sleep(500);
    const before = (await H.callTool(first.client, 'dsh_status', { jobId })).payload.job;
    assert.equal(before.status, 'running');
    const childPid = before.pid;

    const second = spawn(process.execPath, [H.ENTRY, '--config', configPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let secondOut = '';
    let secondErr = '';
    second.stdout.on('data', (chunk) => {
      secondOut += chunk.toString('utf8');
    });
    second.stderr.on('data', (chunk) => {
      secondErr += chunk.toString('utf8');
    });
    const secondExit = await new Promise((resolve) => second.on('close', (code) => resolve(code)));
    assert.equal(secondExit, 2, `second bridge must refuse to start, saw exit ${secondExit}`);
    assert.match(secondErr, /STATE_DIR_BUSY/);
    assert.equal(secondOut.trim(), '', 'the refusing bridge writes nothing to stdout');

    const after = (await H.callTool(first.client, 'dsh_status', { jobId })).payload.job;
    assert.equal(after.status, 'running', 'the owner job was not rewritten by the second bridge');
    assert.equal(after.recovered, false);
    assert.equal(alive(childPid), true);

    const lock = peekOwnership(env.state);
    assert.equal(lock.pid, first.serverPid(), 'the lock names the live owner');
  } finally {
    await first.close();
  }
  await H.sleep(600);
  assert.equal(peekOwnership(env.state), null, 'a clean shutdown releases the lock');
});

test('R04 a second in-process manager is read-only and never rewrites the owner records', async () => {
  const env = H.makeEnv('r04-inprocess');
  const config = loadConfig(H.writeConfig(env, { __name: 'r04inprocess' }));
  const taskFile = H.writeTask(env, 'task.md', 'synthetic\\n');
  const runner = new ControlledRunner('deferred');
  const first = new JobManager(config, runner);
  first.init();
  assert.equal(first.isOwner, true);
  const submit = await first.submit({ requestId: 'owner-one', workspaceId: 'impl', taskFile, mode: 'implement' });
  await new Promise((resolve) => setImmediate(resolve));

  const second = new JobManager(config, runner);
  second.init();
  assert.equal(second.isOwner, false);
  const view = second.status(submit.jobId);
  assert.equal(view.status, 'running', 'the second manager sees the live job, not a takeover');
  await assert.rejects(
    () => second.submit({ requestId: 'owner-two', workspaceId: 'impl', taskFile, mode: 'implement' }),
    (error) => error instanceof BridgeError && error.code === 'STATE_DIR_BUSY',
  );
  assert.equal(runner.runs.filter((run) => run.alive).length, 1, 'no second execution was admitted');
  runner.finish(0);
  first.releaseOwnership();
});

test('R04 stale locks are taken over; a fresh live owner is respected', () => {
  const env = H.makeEnv('r04-lock');
  const stateDir = env.state;
  fs.mkdirSync(stateDir, { recursive: true });
  const lockFile = path.join(stateDir, 'owner.lock');
  const options = { staleHeartbeatMs: 1000, heartbeatMs: 500, bridgeVersion: 'test' };

  // (a) dead pid, old heartbeat
  fs.writeFileSync(
    lockFile,
    JSON.stringify({ schema: 'dsh-codex-bridge/owner-lock/v1', lockId: 'dead', pid: 999999, hostname: 'x', startedAt: new Date(0).toISOString(), heartbeatAt: new Date(0).toISOString(), bridgeVersion: 'test' }),
  );
  const takeoverDead = acquireOwnership(stateDir, options);
  assert.equal(takeoverDead.owned, true);
  assert.equal(takeoverDead.mode, 'acquired-stale');
  takeoverDead.release();

  // (b) live pid (this process) but a stale heartbeat: treated as reusable, not as proof of ownership
  fs.writeFileSync(
    lockFile,
    JSON.stringify({ schema: 'dsh-codex-bridge/owner-lock/v1', lockId: 'stale-live', pid: process.pid, hostname: 'x', startedAt: new Date(0).toISOString(), heartbeatAt: new Date(0).toISOString(), bridgeVersion: 'test' }),
  );
  const takeoverStale = acquireOwnership(stateDir, options);
  assert.equal(takeoverStale.owned, true, 'a reused pid alone must not block recovery');
  takeoverStale.release();

  // (c) live pid with a fresh heartbeat: respect the owner. Freshness lives in
  //     the owner's own heartbeat sidecar, so that is what a healthy owner has.
  fs.writeFileSync(
    lockFile,
    JSON.stringify({ schema: 'dsh-codex-bridge/owner-lock/v1', lockId: 'live', pid: process.pid, hostname: 'x', startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), bridgeVersion: 'test' }),
  );
  fs.writeFileSync(
    path.join(stateDir, 'owner.heartbeat.live'),
    `${JSON.stringify({ schema: 'dsh-codex-bridge/owner-heartbeat/v1', lockId: 'live', pid: process.pid, heartbeatAt: new Date().toISOString() })}\n`,
  );
  const foreign = acquireOwnership(stateDir, options);
  assert.equal(foreign.owned, false);
  assert.equal(foreign.mode, 'foreign');
  assert.match(String(foreign.view().diagnostic), /owned by a live bridge/);
  assert.equal(peekOwnership(stateDir).lockId, 'live', 'the live owner lock was left untouched');

  // (c2) the same fresh-looking lock is takeable once the owner stops: the
  //      heartbeat sidecar is the freshness evidence, not the lock's own copy.
  fs.rmSync(path.join(stateDir, 'owner.heartbeat.live'), { force: true });
  const afterOwnerStopped = acquireOwnership(stateDir, options);
  assert.equal(afterOwnerStopped.owned, true, 'a lock whose owner stopped heartbeating is recoverable');
  afterOwnerStopped.release();

  // (d) unreadable lock with a fresh mtime: a claim in progress is never overwritten
  fs.writeFileSync(lockFile, '{ not json');
  const inProgress = acquireOwnership(stateDir, options);
  assert.equal(inProgress.owned, false, 'a fresh unreadable lock is not taken over');
  assert.equal(inProgress.mode, 'foreign');
  assert.match(String(inProgress.view().diagnostic), /cannot be read and is fresh/);

  // (e) unreadable lock that is also old: arbitrated takeover is allowed
  const old = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(lockFile, old, old);
  const reclaimed = acquireOwnership(stateDir, options);
  assert.equal(reclaimed.owned, true, 'an abandoned unreadable lock can be taken over');
  reclaimed.release();
  assert.equal(fs.existsSync(lockFile), false);
  assert.deepEqual(
    fs.readdirSync(stateDir).filter((name) => name.includes('.tmp-') || name.startsWith('owner.arb')),
    [],
    'no temporary or arbitration leftovers remain after the takeover',
  );
});
