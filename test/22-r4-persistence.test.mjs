/** R4 lifecycle tests. In-memory simulation and native fake children are named separately. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JobManager } from '../dist/src/jobs.js';
import { loadConfig } from '../dist/src/config.js';
import { FakeRunner } from '../dist/src/runners/fake.js';
import { writeFileAtomic } from '../dist/src/atomic.js';
import * as H from './helpers/harness.mjs';

class ControlledRunner {
  type = 'fake'; runs = []; blocked = false;
  describe() { return { type: 'fake', available: true, diagnostic: null, commandTemplate: 'controlled fake', details: {} }; }
  start(spec, events) {
    const run = { alive: true, events, kills: 0 }; this.runs.push(run);
    return { pid: undefined, command: [], kill: async () => {
      run.kills++;
      if (this.blocked) return { method: 'simulated-noop', killed: false, exited: false, detail: 'still alive' };
      run.alive = false; events.onExit(null, 'SIGKILL');
      return { method: 'simulated-tree', killed: true, exited: true, detail: null };
    } };
  }
  finish() { const r = this.runs.at(-1); r.alive = false; r.events.onExit(0, null); }
}
function setup(name, runner = new ControlledRunner(), extra = {}) {
  const env = H.makeEnv('r4-' + name);
  const config = loadConfig(H.writeConfig(env, { server: { logLevel: 'error' }, ...extra }));
  const m = new JobManager(config, runner); m.init();
  const task = H.writeTask(env, 'task.md', 'controlled fake\n');
  const input = { requestId: name, workspaceId: 'impl', mode: 'fix', taskFile: task, timeoutSeconds: 30 };
  return { m, env, config, runner, input };
}
const ioError = () => Object.assign(new Error('injected state EPERM'), { code: 'EPERM' });

test('R4-01 simulated atomic replacement retries transient errors and preserves the old destination on exhaustion', () => {
  const e = H.makeEnv('r4-atomic'); const file = path.join(e.dir, 'atomic.json');
  fs.writeFileSync(file, 'old complete record');
  const rename = fs.renameSync; let calls = 0;
  fs.renameSync = (a, b) => { if (b === file && ++calls <= 2) throw ioError(); return rename(a, b); };
  try { writeFileAtomic(file, 'new complete record'); assert.equal(calls, 3); assert.equal(fs.readFileSync(file, 'utf8'), 'new complete record'); }
  finally { fs.renameSync = rename; }
  calls = 0; fs.renameSync = () => { calls++; throw ioError(); };
  try { assert.throws(() => writeFileAtomic(file, 'must not replace'), /EPERM/); assert.equal(calls, 5); assert.equal(fs.readFileSync(file, 'utf8'), 'new complete record'); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.readdirSync(e.dir).some(x => x.includes('atomic.json.tmp-')), false);
});

test('R4-01 simulated initial acceptance write failure never starts a task', async () => {
  const { m, runner, input } = setup('accept-fail');
  m.store.saveJob = () => { throw ioError(); };
  try {
    await assert.rejects(m.submit(input), e => e.code === 'STATE_WRITE_FAILED');
    await H.sleep(30); assert.equal(runner.runs.length, 0); assert.equal(m.activeJobId, null); assert.equal(m.store.jobIds().length, 0);
  } finally { await m.shutdown(); }
});

test('R4-01 simulated pre-spawn write exhaustion gives a readable failed outcome and no process', async () => {
  const { m, runner, input } = setup('pre-spawn-fail'); const save = m.store.saveJob.bind(m.store);
  m.store.saveJob = r => { if (r.status === 'running') throw ioError(); save(r); };
  try {
    const sub = await m.submit(input); await H.sleep(40);
    const view = m.status(sub.jobId); assert.equal(view.status, 'failed'); assert.equal(view.error.code, 'STATE_WRITE_FAILED');
    assert.equal(runner.runs.length, 0); assert.equal(m.activeJobId, null); assert.equal(view.persistence.durable, true);
  } finally { await m.shutdown(); }
});

test('R4-01 simulated post-spawn write failure keeps the slot and cancel handle until a stop is observed', async () => {
  const { m, runner, input } = setup('post-spawn-fail', new ControlledRunner(), { cleanup: { confirmTimeoutMs: 60 } });
  runner.blocked = true; const save = m.store.saveJob.bind(m.store); let fired = false;
  m.store.saveJob = r => { if (runner.runs.length && !fired) { fired = true; throw ioError(); } save(r); };
  try {
    const sub = await m.submit(input); await H.sleep(100);
    assert.equal(fired, true); assert.equal(runner.runs[0].alive, true); assert.equal(m.status(sub.jobId).status, 'stopping');
    assert.equal(m.activeJobId, sub.jobId);
    await assert.rejects(m.submit({ ...input, requestId: 'new-while-stopping' }), e => e.code === 'BUSY');
    runner.blocked = false; const cancel = await m.cancel(sub.jobId);
    assert.equal(runner.runs[0].alive, false); assert.equal(cancel.status, 'failed'); assert.equal(cancel.error.code, 'STATE_WRITE_FAILED');
    assert.equal(cancel.cleanup.confirmed, true); assert.equal(m.activeJobId, null);
  } finally { runner.blocked = false; await m.shutdown(); }
});

test('R4-01 simulated stopping write exhaustion cannot prevent killing an owned task', async () => {
  const { m, runner, input } = setup('stop-write-fail'); const save = m.store.saveJob.bind(m.store);
  try {
    const sub = await m.submit(input); await H.sleep(30);
    m.store.saveJob = r => { if (r.status === 'stopping') throw ioError(); save(r); };
    const view = await m.cancel(sub.jobId);
    assert.equal(view.status, 'cancelled'); assert.equal(view.cleanup.confirmed, true); assert.equal(runner.runs[0].alive, false);
    assert.equal(view.persistence.durable, true);
  } finally { m.store.saveJob = save; await m.shutdown(); }
});

test('R4-01 simulated terminal write exhaustion exposes debt, blocks admission, then recovers without rerunning', async () => {
  const { m, runner, input, config } = setup('terminal-write-fail'); const save = m.store.saveJob.bind(m.store);
  let broken = true;
  try {
    const sub = await m.submit(input); await H.sleep(30);
    m.store.saveJob = r => { if (broken && r.status === 'completed') throw ioError(); save(r); };
    assert.doesNotThrow(() => runner.finish());
    const view = m.status(sub.jobId); assert.equal(view.status, 'completed'); assert.equal(view.persistence.durable, false);
    assert.equal(m.health().integrity.pendingStateWrites.length, 1); assert.equal(m.activeJobId, null);
    await assert.rejects(m.submit({ ...input, requestId: 'blocked-by-debt' }), e => e.code === 'STATE_WRITE_FAILED');
    broken = false; const retry = await m.submit(input);
    assert.equal(retry.reusedExistingJob, true); assert.equal(retry.jobId, sub.jobId); assert.equal(runner.runs.length, 1);
    assert.equal(m.status(sub.jobId).persistence.durable, true); assert.equal(m.store.loadJob(sub.jobId).status, 'completed');
    m.releaseOwnership(); const restarted = new JobManager(config, runner); restarted.init();
    try { const afterRestart = await restarted.submit(input); assert.equal(afterRestart.jobId, sub.jobId); assert.equal(afterRestart.reusedExistingJob, true); assert.equal(runner.runs.length, 1); }
    finally { await restarted.shutdown(); }
  } finally { m.store.saveJob = save; await m.shutdown(); }
});

test('R4-01 simulated permanent post-spawn write loss retains explicit durability debt and restart refuses an unknown child', async () => {
  const { m, runner, input, config } = setup('permanent-post-spawn'); const save = m.store.saveJob.bind(m.store);
  m.store.saveJob = r => { if (runner.runs.length > 0) throw ioError(); save(r); };
  const sub = await m.submit(input); await H.sleep(100);
  assert.equal(runner.runs[0].alive, false); assert.equal(m.status(sub.jobId).error.code, 'STATE_WRITE_FAILED'); assert.equal(m.status(sub.jobId).persistence.durable, false);
  assert.equal(m.store.loadJob(sub.jobId).spawnPending, true);
  await assert.rejects(m.submit({ ...input, requestId: 'blocked-by-permanent-io' }), e => e.code === 'STATE_WRITE_FAILED');
  m.releaseOwnership(); const next = new JobManager(config, new ControlledRunner()); next.init();
  try { await assert.rejects(next.submit({ ...input, requestId: 'restart-after-lost-proof' }), e => e.code === 'ORPHAN_UNRESOLVED'); assert.deepEqual(next.health().integrity.unresolvedSpawnJobIds, [sub.jobId]); }
  finally { m.store.saveJob = save; await m.shutdown(); await next.shutdown(); }
});

test('R4-01 simulated restart with a durable spawn intent and missing pid conservatively blocks new work', async () => {
  const { m, runner, input, config } = setup('spawn-intent-restart');
  const sub = await m.submit(input); await H.sleep(30); runner.finish();
  const record = m.store.loadJob(sub.jobId); record.status = 'running'; record.endedAt = null; record.pid = null; record.spawnPending = true;
  m.store.saveJob(record); m.releaseOwnership();
  const next = new JobManager(config, new ControlledRunner()); next.init();
  try {
    assert.equal(next.status(sub.jobId).status, 'interrupted');
    assert.deepEqual(next.health().integrity.unresolvedSpawnJobIds, [sub.jobId]);
    await assert.rejects(next.submit({ ...input, requestId: 'cannot-prove-no-child' }), e => e.code === 'ORPHAN_UNRESOLVED');
  } finally { await next.shutdown(); }
});

for (const phase of ['post-spawn', 'terminal']) test(`R4-01 native Windows fake child: ${phase} state failure leaves the bridge alive and the child supervised`, async () => {
  const env = H.makeEnv('r4-native-' + phase);
  const cfg = loadConfig(H.writeConfig(env, { server: { logLevel: 'error' } }));
  const m = new JobManager(cfg, new FakeRunner(cfg.runner.fake)); m.init();
  const save = m.store.saveJob.bind(m.store); let fired = false;
  m.store.saveJob = r => {
    if (!fired && (phase === 'post-spawn' ? r.status === 'running' && r.pid !== null : r.status === 'completed')) { fired = true; throw ioError(); }
    save(r);
  };
  try {
    const task = H.writeTask(env, 'task.md', phase === 'post-spawn' ? 'FAKE_SLEEP_MS=30000\n' : 'FAKE_EXIT=0\n');
    const sub = await m.submit({ requestId: 'native-' + phase, workspaceId: 'impl', mode: 'fix', taskFile: task });
    assert.equal(await H.waitFor(() => m.status(sub.jobId).terminal, 15000), true);
    const view = m.status(sub.jobId); assert.equal(fired, true); assert.equal(m.activeJobId, null); assert.equal(m.health().ok, true);
    if (phase === 'post-spawn') {
      assert.equal(view.status, 'failed'); assert.equal(view.error.code, 'STATE_WRITE_FAILED'); assert.equal(view.cleanup.confirmed, true);
      assert.throws(() => process.kill(view.pid, 0), e => e.code === 'ESRCH');
    } else {
      assert.equal(view.status, 'completed'); assert.equal(view.persistence.durable, false);
      const taskFile = task;
      const retry = await m.submit({ requestId: 'native-' + phase, workspaceId: 'impl', mode: 'fix', taskFile });
      assert.equal(retry.jobId, sub.jobId); assert.equal(retry.reusedExistingJob, true); assert.equal(m.status(sub.jobId).persistence.durable, true);
    }
  } finally { m.store.saveJob = save; await m.shutdown(); }
});
