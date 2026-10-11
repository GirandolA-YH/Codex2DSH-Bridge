/** Focused evidence for V-01/V-02; fixed fake processes only, never real DSH. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JobManager } from '../dist/src/jobs.js';
import { loadConfig } from '../dist/src/config.js';
import { FakeRunner } from '../dist/src/runners/fake.js';
import { queryProcessLiveness } from '../dist/src/proctree.js';
import * as H from './helpers/harness.mjs';

test('R4 V-01 simulated exit before deadline completes; an exit0 after timeout stays timed_out with an ordered timeline', async () => {
  const traces = [];
  for (const delay of [100, 1200]) {
    const env = H.makeEnv('r4-exit-order-' + delay); const cfg = loadConfig(H.writeConfig(env, { server: { logLevel: 'error' } }));
    const trace = { delay, origin: performance.now() }; let timer;
    const runner = { type: 'fake', describe: () => ({ type: 'fake', available: true, diagnostic: null, commandTemplate: 'in-process timed fake', details: {} }), start(spec, events) {
      trace.started = performance.now();
      timer = setTimeout(() => { trace.exitEvent = performance.now(); events.onExit(0, null); }, delay);
      return { pid: undefined, command: [], kill: async () => { trace.timeoutStop = performance.now(); return { method: 'simulated-noop', killed: false, exited: false, detail: null }; } };
    } };
    const m = new JobManager(cfg, runner); m.init();
    try {
      const sub = await m.submit({ requestId: 'order-' + delay, workspaceId: 'impl', mode: 'fix', taskFile: H.writeTask(env, 'task.md', 'fake\n'), timeoutSeconds: 1 });
      assert.equal(await H.waitFor(() => m.status(sub.jobId).terminal, 5000), true);
      const view = m.status(sub.jobId); trace.status = view.status; trace.exitCode = view.exitCode;
      assert.equal(view.exitCode, 0);
      if (delay === 100) { assert.equal(view.status, 'completed'); assert.equal(trace.timeoutStop, undefined); }
      else { assert.equal(view.status, 'timed_out'); assert.ok(trace.timeoutStop < trace.exitEvent); assert.ok(trace.exitEvent - trace.started >= 1000); }
      traces.push(trace);
    } finally { clearTimeout(timer); await m.shutdown(); }
  }
  fs.writeFileSync(path.join(H.ROOT, 'reports/r4-exit-order.json'), JSON.stringify({ scope: 'in-process events, not a timestamp of the DSH original OS exit', traces }, null, 2));
});

test('R4 V-02 native spawn-before-pid stale-lease takeover refuses a second task while the first fake child is alive', async () => {
  const env = H.makeEnv('r4-spawn-window'); const cfg = loadConfig(H.writeConfig(env, { server: { logLevel: 'error' } }));
  const task = H.writeTask(env, 'task.md', 'FAKE_SLEEP_MS=30000\n');
  const real = new FakeRunner(cfg.runner.fake); let first, next, ownedHandle, childWasAlive = false, secondAttempt;
  const wrapper = { type: 'fake', describe: () => real.describe(), start(spec, events) {
    ownedHandle = real.start(spec, events);
    childWasAlive = queryProcessLiveness(ownedHandle.pid) === 'alive';
    const owner = first.health().ownership;
    const agedAt = new Date(Date.now() - 60000).toISOString();
    fs.writeFileSync(path.join(env.state, 'owner.heartbeat.' + owner.lockId), JSON.stringify({ schema: 'dsh-codex-bridge/owner-heartbeat/v1', lockId: owner.lockId, pid: process.pid, heartbeatAt: agedAt }));
    next = new JobManager(cfg, real); next.init();
    // Capture the refusal immediately; avoid a transient unhandled rejection.
    secondAttempt = next.submit({ requestId: 'second-in-window', workspaceId: 'impl', mode: 'fix', taskFile: task }).then(
      value => ({ accepted: true, value }), error => ({ accepted: false, code: error.code }),
    );
    return ownedHandle;
  } };
  first = new JobManager(cfg, wrapper); first.init();
  try {
    const sub = await first.submit({ requestId: 'first-in-window', workspaceId: 'impl', mode: 'fix', taskFile: task });
    assert.equal(await H.waitFor(() => secondAttempt !== undefined, 5000), true);
    const result = await secondAttempt; assert.equal(childWasAlive, true); assert.equal(next.isOwner, true);
    assert.deepEqual(result, { accepted: false, code: 'ORPHAN_UNRESOLVED' }); assert.equal(next.store.jobIds().length, 1);
    assert.deepEqual(next.health().integrity.unresolvedSpawnJobIds, [sub.jobId]);
    fs.writeFileSync(path.join(H.ROOT, 'reports/r4-spawn-window.json'), JSON.stringify({ scope: 'native Windows fake child + injected stale heartbeat + reentrant runner-start hook', childWasAliveAtTakeover: childWasAlive, firstJobId: sub.jobId, secondAttempt: result, noSecondJob: next.store.jobIds().length === 1, limitation: 'covers new R4 durable spawn-intent records; does not prove every possible legacy interleaving' }, null, 2));
  } finally {
    if (ownedHandle) await ownedHandle.kill(); // Only the exact child this test created.
    await first.shutdown(); if (next) await next.shutdown();
  }
});
