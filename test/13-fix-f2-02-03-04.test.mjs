/**
 * FIX-002 F2-02 (identity-proven orphan handling), F2-03 (atomic claim and
 * dynamic ownership) and F2-04 (unreadable evidence) regressions.
 *
 * Real Windows processes are used where identity matters; every process is
 * created by this test and cleaned up here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JobManager } from '../dist/src/jobs.js';
import { JobStore, isValidJobRecord } from '../dist/src/store.js';
import { loadConfig } from '../dist/src/config.js';
import { acquireOwnership, peekOwnership } from '../dist/src/ownership.js';
import { probeProcessIdentity, commandLineDigest } from '../dist/src/process-identity.js';
import { BridgeError } from '../dist/src/errors.js';
import * as H from './helpers/harness.mjs';

const IMPL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

class AliveRunner {
  constructor() {
    this.type = 'fake';
    this.runs = [];
  }

  describe() {
    return { type: 'fake', available: true, diagnostic: null, commandTemplate: '<alive runner>', details: {} };
  }

  start(spec, events) {
    const run = { spec, events, alive: true };
    this.runs.push(run);
    return {
      pid: undefined,
      child: null,
      command: ['<alive>'],
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

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function killTree(pid) {
  if (!alive(pid)) return;
  await new Promise((resolve) => {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('close', () => resolve());
    killer.on('error', () => resolve());
  });
}

function managerFor(config, runner) {
  const manager = new JobManager(config, runner);
  manager.init();
  return manager;
}

test('F2-02 an identity that does not match the recorded child is never terminated', async () => {
  const env = H.makeEnv('f2-02-mismatch');
  const config = loadConfig(H.writeConfig(env, { __name: 'f202mismatch', recovery: { killOrphanedChildrenOnStart: true } }));
  const taskFile = H.writeTask(env, 'task.md', 'FAKE_EXIT=0\n');
  const first = await H.startBridge(H.writeConfig(env, { __name: 'f202seed' }), env, { name: 'f202-seed' });
  const submitted = await H.callTool(first.client, 'dsh_submit', {
    requestId: 'f2-02-seed',
    workspaceId: 'impl',
    taskFile,
    mode: 'implement',
  });
  const jobId = submitted.payload.jobId;
  await H.waitForTerminal(first.client, jobId);
  await first.close();
  await H.sleep(300);

  const sentinel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  try {
    const probe = probeProcessIdentity(sentinel.pid);
    assert.equal(probe.status, 'ok', 'the host interface must be able to identify a process for this test');
    const jobFile = path.join(env.state, 'jobs', jobId, 'job.json');
    const record = H.readJson(jobFile);
    record.status = 'running';
    record.endedAt = null;
    record.pid = sentinel.pid;
    record.recovered = false;
    record.cleanup = null;
    // Identity that cannot be this process: wrong creation time and command line.
    record.childIdentity = {
      pid: sentinel.pid,
      creationTimeMs: probe.identity.creationTimeMs - 600000,
      executablePath: 'C:\\definitely\\not\\this\\process.exe',
      commandLineDigest: commandLineDigest('some other command line entirely'),
    };
    fs.writeFileSync(jobFile, JSON.stringify(record, null, 2));

    const bridge = await H.startBridge(H.writeConfig(env, { __name: 'f202mismatch', recovery: { killOrphanedChildrenOnStart: true } }), env, { name: 'f202-check' });
    try {
      const health = await H.callTool(bridge.client, 'dsh_health');
      assert.equal(health.payload.orphanBlock.pids.includes(sentinel.pid), true, 'a mismatched identity keeps the block');
      assert.equal(alive(sentinel.pid), true, 'a pid whose identity is not proven must never be terminated');
      const error = await H.callToolExpectError(bridge.client, 'dsh_submit', {
        requestId: 'f2-02-after',
        workspaceId: 'impl',
        taskFile,
        mode: 'implement',
      });
      assert.equal(error.code, 'ORPHAN_UNRESOLVED');
      const view = await H.callTool(bridge.client, 'dsh_status', { jobId });
      assert.equal(view.payload.job.cleanup?.confirmed === true, false, 'no unverified cleanup may be reported as confirmed');
    } finally {
      await bridge.close();
    }
    void config;
  } finally {
    if (alive(sentinel.pid)) sentinel.kill('SIGKILL');
  }
});

test('F2-03 the initial claim is arbitrated: a starter that loses the lock is not an owner', () => {
  const env = H.makeEnv('f2-03-race');
  const state = path.join(env.dir, 'state-race');
  fs.mkdirSync(state, { recursive: true });
  const lockFile = path.join(state, 'owner.lock');
  const options = { staleHeartbeatMs: 30000, heartbeatMs: 5000, bridgeVersion: 'test' };
  const realOpen = fs.openSync;
  let nested = false;
  let second = null;
  // FIX-004: the first claim is one exclusive create, so the interleaving injects
  // at that atomic step: a second starter claims first and the late one must
  // refuse instead of overwriting.
  fs.openSync = function patched(target, flags, ...rest) {
    if (!nested && flags === 'wx' && path.resolve(String(target)) === path.resolve(lockFile)) {
      nested = true;
      second = acquireOwnership(state, options);
    }
    return realOpen.call(fs, target, flags, ...rest);
  };
  let first = null;
  try {
    first = acquireOwnership(state, options);
  } finally {
    fs.openSync = realOpen;
  }
  assert.notEqual(second, null, 'the injected interleaving must have run a second claim');
  assert.equal(second.owned, true, 'the starter that claimed first keeps the lock');
  assert.equal(first.owned, false, 'the late starter must refuse instead of overwriting a fresh lock');
  assert.equal(peekOwnership(state).lockId, second.lockId, "the healthy owner's lock identity is unchanged");
  first.release();
  assert.equal(peekOwnership(state).lockId, second.lockId, 'a non-owner release must not delete the lock');
  second.release();
  assert.equal(fs.existsSync(lockFile), false, 'the owner release removes the lock');
});

test('F2-03 ownership is dynamic: a takeover revokes the old owner and stops its job', async () => {
  const env = H.makeEnv('f2-03-lost');
  const configPath = H.writeConfig(env, { __name: 'f203lost' });
  const config = loadConfig(configPath);
  const taskFile = H.writeTask(env, 'task.md', 'synthetic job body\n');
  const runner = new AliveRunner();
  const first = managerFor(config, runner);
  assert.equal(first.isOwner, true);
  const submit = await first.submit({ requestId: 'f203-first', workspaceId: 'impl', taskFile, mode: 'implement' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runner.runs.filter((run) => run.alive).length, 1);

  // Force a takeover by pretending the first owner stalled: age its own
  // heartbeat sidecar (freshness lives there) and the copy inside the lock.
  const lockFile = path.join(env.state, 'owner.lock');
  const stalled = H.readJson(lockFile);
  const agedAt = new Date(0).toISOString();
  stalled.heartbeatAt = agedAt;
  fs.writeFileSync(lockFile, JSON.stringify(stalled));
  fs.writeFileSync(
    path.join(env.state, `owner.heartbeat.${stalled.lockId}`),
    `${JSON.stringify({ schema: 'dsh-codex-bridge/owner-heartbeat/v1', lockId: stalled.lockId, pid: stalled.pid, heartbeatAt: agedAt }, null, 2)}\n`,
  );
  const second = managerFor(config, new AliveRunner());
  assert.equal(second.isOwner, true, 'a stalled heartbeat can be taken over');
  assert.equal(first.isOwner, false, 'the previous owner is no longer the owner (live check)');
  assert.equal(first.checkOwnership(), false, 're-validating ownership keeps reporting false');

  // The old owner must refuse new work and stop the job it still owns.
  await assert.rejects(
    () => first.submit({ requestId: 'f203-second', workspaceId: 'impl', taskFile, mode: 'implement' }),
    (error) => error instanceof BridgeError && error.code === 'STATE_DIR_BUSY',
  );
  await H.sleep(200);
  assert.equal(runner.runs[0].alive, false, 'the old owner stops its own process tree when ownership is lost');
  const view = first.status(submit.jobId);
  assert.equal(view.terminal, true);
  assert.equal(view.status, 'interrupted');
  assert.equal(view.error.code, 'OWNERSHIP_LOST');

  // The new owner legitimately recovers the old job; the old owner must not
  // write over that recovery (persistence rights are revoked).
  const secondSubmit = await second.submit({ requestId: 'f203-third', workspaceId: 'impl', taskFile, mode: 'implement' });
  assert.notEqual(secondSubmit.jobId, submit.jobId);
  const onDisk = H.readJson(path.join(env.state, 'jobs', submit.jobId, 'job.json'));
  assert.equal(onDisk.status, 'interrupted');
  assert.equal(onDisk.recovered, true, 'the new owner marked the abandoned job');
  assert.equal(onDisk.errorCode, 'INTERRUPTED', 'the old owner did not overwrite the new owner recovery with its own attribution');
  assert.equal(view.error.code, 'OWNERSHIP_LOST', 'the old owner keeps its own in-memory attribution');
  second.releaseOwnership();
});

test('F2-03 a released handle immediately loses execution rights', async () => {
  const env = H.makeEnv('f2-03-release');
  const config = loadConfig(H.writeConfig(env, { __name: 'f203release' }));
  const taskFile = H.writeTask(env, 'task.md', 'body\n');
  const manager = managerFor(config, new AliveRunner());
  assert.equal(manager.isOwner, true);
  manager.releaseOwnership();
  assert.equal(manager.isOwner, false);
  await assert.rejects(
    () => manager.submit({ requestId: 'after-release', workspaceId: 'impl', taskFile, mode: 'implement' }),
    (error) => error instanceof BridgeError && error.code === 'STATE_DIR_BUSY',
  );
});

test('F2-04 unreadable job evidence blocks new work instead of proving a new request', async () => {
  const env = H.makeEnv('f2-04-unreadable');
  const config = loadConfig(H.writeConfig(env, { __name: 'f204unreadable' }));
  const taskFile = H.writeTask(env, 'task.md', 'synthetic\n');
  const runner = new AliveRunner();
  const first = managerFor(config, runner);
  const submitted = await first.submit({ requestId: 'f204-a', workspaceId: 'impl', taskFile, mode: 'implement' });
  await new Promise((resolve) => setImmediate(resolve));
  runner.finish(0);
  first.releaseOwnership();

  // Missing index plus an unreadable surviving job record.
  fs.rmSync(first.store.requestFile('f204-a'), { force: true });
  fs.writeFileSync(first.store.jobFile(submitted.jobId), '{damaged synthetic job');

  const restarted = managerFor(config, new AliveRunner());
  const health = restarted.health();
  assert.equal(health.integrity.unreadableJobs.length, 1, 'the unreadable record is reported as integrity, not absence');
  await assert.rejects(
    () => restarted.submit({ requestId: 'f204-a', workspaceId: 'impl', taskFile, mode: 'implement' }),
    (error) => error instanceof BridgeError && error.code === 'REQUEST_INDEX_UNREADABLE',
  );
  assert.equal(restarted.store.jobIds().length, 1, 'no second job was created');
  assert.throws(
    () => restarted.status(submitted.jobId),
    (error) => error instanceof BridgeError && error.code === 'JOB_RECORD_UNREADABLE',
    'an unreadable record must be reported as an integrity error, not as a missing job',
  );
  restarted.releaseOwnership();
});

test('F2-04 a directory listing failure is an integrity error, not an empty store', () => {
  const env = H.makeEnv('f2-04-enumeration');
  const state = path.join(env.dir, 'state-enum');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'jobs'), 'not a directory');
  const store = new JobStore(state);
  const report = store.loadAllJobsStrict();
  assert.notEqual(report.enumerationError, null, 'an unlistable jobs directory is reported');
  const search = store.findJobsByRequestIdStrict('anything');
  assert.notEqual(search.enumerationError, null);
  assert.equal(isValidJobRecord({ jobId: 'job-abc123', requestId: 'x', requestHash: 'h', status: 'running', createdAt: new Date().toISOString() }), false, 'R4: five identity fields alone do not make the read path structurally safe');
  assert.equal(isValidJobRecord({ jobId: 'job-abc123' }), false, 'structurally invalid records are rejected');
});

test('F2-04 an index cross-linked to another request never returns that job', async () => {
  const env = H.makeEnv('f2-04-crosslink');
  const config = loadConfig(H.writeConfig(env, { __name: 'f204cross' }));
  const taskFile = H.writeTask(env, 'task.md', 'identical content for both requests\n');
  const runner = new AliveRunner();
  const manager = managerFor(config, runner);
  const a = await manager.submit({ requestId: 'A', workspaceId: 'impl', taskFile, mode: 'implement' });
  await new Promise((resolve) => setImmediate(resolve));
  runner.finish(0);
  const b = await manager.submit({ requestId: 'B', workspaceId: 'impl', taskFile, mode: 'implement' });
  await new Promise((resolve) => setImmediate(resolve));
  runner.finish(1);

  const bIndex = manager.store.loadRequestStrict('B').record;
  manager.store.saveRequest({ ...bIndex, requestId: 'A' }); // A's index now points at B's job
  const retry = await manager.submit({ requestId: 'A', workspaceId: 'impl', taskFile, mode: 'implement' });
  assert.equal(retry.jobId, a.jobId, 'A must resolve to A, never to a job that belongs to B');
  assert.notEqual(retry.jobId, b.jobId);

  // A contradictory hash in the index is unusable evidence: recovery must fall
  // back to A's own (matching) job record rather than trusting the index.
  manager.store.saveRequest({ ...bIndex, requestId: 'A', requestHash: 'not-the-real-hash' });
  const afterContradiction = await manager.submit({ requestId: 'A', workspaceId: 'impl', taskFile, mode: 'implement' });
  assert.equal(afterContradiction.jobId, a.jobId, 'A still resolves to A');
  assert.equal(afterContradiction.reusedExistingJob, true);
  assert.equal(runner.runs.length, 2, 'no extra run was started for A');
  manager.releaseOwnership();
});

test('F2-04 production configuration refuses test-only fault injection', () => {
  const env = H.makeEnv('f2-04-faults');
  const configPath = H.writeConfig(env, { __name: 'f204faults' });
  const raw = H.readJson(configPath);
  raw.faults = { failRequestWriteOnce: true };
  const production = path.join(env.dir, 'prod.json');
  fs.writeFileSync(
    production,
    JSON.stringify(
      {
        ...raw,
        runner: {
          type: 'production',
          production: {
            command: process.execPath,
            argsPrefix: [path.join(IMPL, 'fixtures', 'fake-runner.mjs')],
            profile: 'headless',
          },
        },
      },
      null,
      2,
    ),
  );
  assert.throws(
    () => loadConfig(production),
    (error) => error instanceof BridgeError && error.code === 'CONFIG_INVALID',
    'production must not accept fault injection',
  );

  // The same switch stays available for the fake runner used by the suite.
  const fakePath = path.join(env.dir, 'fake.json');
  const fakeRaw = H.readJson(configPath);
  fakeRaw.faults = { failRequestWriteOnce: true };
  fs.writeFileSync(fakePath, JSON.stringify(fakeRaw, null, 2));
  assert.equal(loadConfig(fakePath).faults.failRequestWriteOnce, true);
  void pathToFileURL;
});
