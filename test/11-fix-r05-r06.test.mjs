/**
 * FIX-001 R05 (an unusable idempotency index must never cause a second run) and
 * R06 (filesystem-safe request ids and transactional submission).
 *
 * Runner: an in-process controlled double, so a "second run" is directly
 * observable as `runner.runs.length`. No OS child, no model call.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JobManager } from '../dist/src/jobs.js';
import { JobStore } from '../dist/src/store.js';
import { loadConfig } from '../dist/src/config.js';
import { BridgeError } from '../dist/src/errors.js';
import * as H from './helpers/harness.mjs';

class CountingRunner {
  constructor() {
    this.type = 'fake';
    this.runs = [];
  }

  describe() {
    return { type: 'fake', available: true, diagnostic: null, commandTemplate: '<counting runner>', details: {} };
  }

  start(spec, events) {
    const run = { spec, events, alive: true };
    this.runs.push(run);
    return {
      pid: undefined,
      child: null,
      command: ['<counting>'],
      kill: () => {
        run.alive = false;
        events.onExit(null, 'SIGKILL');
        return Promise.resolve({ method: 'double', killed: true, exited: true, detail: null });
      },
    };
  }

  finish(index) {
    const run = this.runs[index];
    if (run === undefined || !run.alive) return;
    run.alive = false;
    run.events.onExit(0, null);
  }
}

async function setup(name) {
  const env = H.makeEnv(name);
  const config = loadConfig(H.writeConfig(env, { __name: name }));
  const taskFile = H.writeTask(env, 'task.md', 'synthetic task body\n');
  const runner = new CountingRunner();
  const manager = new JobManager(config, runner);
  manager.init();
  return { env, config, taskFile, runner, manager, store: new JobStore(config.stateDir) };
}

async function submitAndFinish(manager, runner, input) {
  const ack = await manager.submit(input);
  await new Promise((resolve) => setImmediate(resolve));
  runner.finish(runner.runs.length - 1);
  await new Promise((resolve) => setImmediate(resolve));
  return ack;
}

test('R05 a corrupt request index never starts a second run', async () => {
  const { env, taskFile, runner, manager, store } = await setup('r05-corrupt');
  const input = { requestId: 'stable-retry', workspaceId: 'impl', taskFile, mode: 'implement' };
  const first = await submitAndFinish(manager, runner, input);
  assert.equal(runner.runs.length, 1);

  fs.writeFileSync(store.requestFile('stable-retry'), '{malformed synthetic index');
  const duplicate = await manager.submit(input);
  assert.equal(duplicate.jobId, first.jobId, 'the original job is reused');
  assert.equal(duplicate.reusedExistingJob, true);
  assert.equal(runner.runs.length, 1, 'no second execution was started');

  const rebuilt = store.loadRequestStrict('stable-retry');
  assert.equal(rebuilt.status, 'ok', 'the index was rebuilt from the surviving job record');
  assert.equal(rebuilt.record.jobId, first.jobId);
  manager.releaseOwnership();
  void env;
});

test('R05 a missing index, an index pointing nowhere and a stray legacy file all reuse the original job', async () => {
  const { taskFile, runner, manager, store } = await setup('r05-missing');
  const input = { requestId: 'retry-two', workspaceId: 'impl', taskFile, mode: 'implement' };
  const first = await submitAndFinish(manager, runner, input);

  // (a) index deleted entirely
  fs.rmSync(store.requestFile('retry-two'), { force: true });
  const afterDelete = await manager.submit(input);
  assert.equal(afterDelete.jobId, first.jobId);
  assert.equal(runner.runs.length, 1);

  // (b) index points at a job that does not exist
  fs.writeFileSync(
    store.requestFile('retry-two'),
    JSON.stringify({ schema: 'dsh-codex-bridge/request-index/v2', requestId: 'retry-two', requestHash: 'x', jobId: 'job-0000000000000000', createdAt: new Date().toISOString() }),
  );
  const afterDangling = await manager.submit(input);
  assert.equal(afterDangling.jobId, first.jobId, 'a dangling index does not create a new job');
  assert.equal(runner.runs.length, 1);

  // (c) legacy/plain-text index naming left over from the audited version
  fs.writeFileSync(path.join(store.stateDir, 'requests', 'retry-two.json'), '{not even json');
  const afterLegacy = await manager.submit(input);
  assert.equal(afterLegacy.jobId, first.jobId);
  assert.equal(runner.runs.length, 1);
  manager.releaseOwnership();
});

test('R05 an unreadable index with no surviving evidence refuses instead of running', async () => {
  const { env, taskFile, runner, manager, store } = await setup('r05-unreadable');
  assert.equal(runner.runs.length, 0);
  const input = { requestId: 'never-submitted', workspaceId: 'impl', taskFile, mode: 'implement' };
  fs.mkdirSync(store.requestFile('never-submitted'), { recursive: true });
  await assert.rejects(
    () => manager.submit(input),
    (error) => error instanceof BridgeError && error.code === 'REQUEST_INDEX_UNREADABLE',
  );
  assert.equal(runner.runs.length, 0, 'an unprovable request never starts a run');
  fs.rmSync(store.requestFile('never-submitted'), { recursive: true, force: true });
  const accepted = await manager.submit(input);
  assert.equal(accepted.reusedExistingJob, false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runner.runs.length, 1);
  manager.releaseOwnership();
  void env;
});

test('R05 a different hash under the same requestId is still a conflict', async () => {
  const { env, taskFile, runner, manager, store } = await setup('r05-conflict');
  const input = { requestId: 'conflict-id', workspaceId: 'impl', taskFile, mode: 'implement' };
  await submitAndFinish(manager, runner, input);
  const other = H.writeTask(env, 'other.md', 'different body\n');

  // (a) a valid index for content A, then content B under the same id
  await assert.rejects(
    () => manager.submit({ requestId: 'conflict-id', workspaceId: 'impl', taskFile: other, mode: 'implement' }),
    (error) => error instanceof BridgeError && error.code === 'REQUEST_CONFLICT',
  );

  // (b) the index is corrupted to a different hash and points nowhere; the only
  //     surviving job carries content A, so content B must still conflict.
  fs.writeFileSync(
    store.requestFile('conflict-id'),
    JSON.stringify({ schema: 'dsh-codex-bridge/request-index/v2', requestId: 'conflict-id', requestHash: 'different-hash', jobId: 'job-0000000000000000', createdAt: new Date().toISOString() }),
  );
  await assert.rejects(
    () => manager.submit({ requestId: 'conflict-id', workspaceId: 'impl', taskFile: other, mode: 'implement' }),
    (error) => error instanceof BridgeError && error.code === 'REQUEST_CONFLICT',
  );

  // (c) the same content still reuses the original job through recovery.
  const reused = await manager.submit(input);
  assert.equal(reused.jobId, (await manager.status(reused.jobId)).jobId);
  assert.equal(reused.reusedExistingJob, true);
  assert.equal(runner.runs.length, 1, 'no extra run was ever started');
  manager.releaseOwnership();
});

test('R06 legal request ids persist under hashed, Windows-safe file names', async () => {
  const { env, taskFile, runner, manager, store } = await setup('r06-ids');
  const ids = ['round:one', 'CON', 'NUL', 'COM1', '.', '-', 'a'.repeat(128), 'CaseSensitive', 'casesensitive'];
  for (const requestId of ids) {
    const ack = await submitAndFinish(manager, runner, { requestId, workspaceId: 'impl', taskFile, mode: 'implement' });
    assert.equal(ack.reusedExistingJob, false, `${requestId} should be accepted`);
  }
  assert.equal(runner.runs.length, ids.length);

  const indexFiles = fs.readdirSync(path.join(store.stateDir, 'requests')).sort();
  assert.equal(indexFiles.length, ids.length, 'one index file per request id');
  for (const name of indexFiles) {
    assert.match(name, /^[0-9a-f]{64}\.json$/, `index file name must be a plain hash, saw ${name}`);
    assert.equal(name.includes(':'), false);
    assert.equal(/^(con|nul|com\d|lpt\d)($|\.)/i.test(name), false, 'no reserved device names');
  }

  const preserved = new Set();
  for (const name of indexFiles) {
    const record = JSON.parse(fs.readFileSync(path.join(store.stateDir, 'requests', name), 'utf8'));
    preserved.add(record.requestId);
    assert.equal(record.schema, 'dsh-codex-bridge/request-index/v2');
    assert.match(record.jobId, /^job-[0-9a-f]{16}$/);
  }
  assert.deepEqual([...preserved].sort(), [...ids].sort(), 'the original ids are preserved inside the JSON');

  // Case-differing ids must be distinct entries.
  assert.notEqual(store.requestFile('CaseSensitive'), store.requestFile('casesensitive'));
  manager.releaseOwnership();
  void env;
});

test('R06 a persistence failure rolls the submission back and never starts a run', async () => {
  // Two injected failures, both after validation and before any process start:
  // the job write fails, and separately the request-index write fails.
  for (const [fault, code] of [
    [{ failJobWriteOnce: true }, 'STATE_WRITE_FAILED'],
    [{ failRequestWriteOnce: true }, 'STATE_WRITE_FAILED'],
  ]) {
    const env = H.makeEnv(`r06-rollback-${Object.keys(fault)[0]}`);
    const config = loadConfig(H.writeConfig(env, { __name: `r06rollback${Object.keys(fault)[0]}`, faults: fault }));
    const taskFile = H.writeTask(env, 'task.md', 'synthetic task body\n');
    const runner = new CountingRunner();
    const manager = new JobManager(config, runner);
    manager.init();
    const store = new JobStore(config.stateDir);

    await assert.rejects(
      () => manager.submit({ requestId: 'rollback-id', workspaceId: 'impl', taskFile, mode: 'implement' }),
      (error) => error instanceof BridgeError && error.code === code,
    );
    assert.equal(runner.runs.length, 0, 'nothing was started');
    assert.deepEqual(store.jobIds(), [], 'the partially written job was rolled back');
    assert.equal(manager.health().activeJob, null);
    const indexFiles = fs.existsSync(path.join(store.stateDir, 'requests')) ? fs.readdirSync(path.join(store.stateDir, 'requests')) : [];
    assert.deepEqual(indexFiles, [], 'no index entry survived the rolled-back submission');

    // The same id can be submitted again once the injected fault is used up.
    const ok = await manager.submit({ requestId: 'rollback-id', workspaceId: 'impl', taskFile, mode: 'implement' });
    assert.equal(ok.reusedExistingJob, false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runner.runs.length, 1, 'a retry after the fault works normally');
    assert.equal(store.jobIds().length, 1);
    manager.releaseOwnership();
  }
});

test('R06 a directory occupying the index path is refused before any persistence', async () => {
  const { taskFile, runner, manager, store } = await setup('r06-obstructed');
  fs.mkdirSync(store.requestFile('obstructed-id'), { recursive: true });
  await assert.rejects(
    () => manager.submit({ requestId: 'obstructed-id', workspaceId: 'impl', taskFile, mode: 'implement' }),
    (error) => error instanceof BridgeError && error.code === 'REQUEST_INDEX_UNREADABLE',
  );
  assert.equal(runner.runs.length, 0);
  assert.deepEqual(store.jobIds(), [], 'nothing was persisted');
  manager.releaseOwnership();
});
