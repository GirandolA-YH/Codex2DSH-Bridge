/**
 * A14 normal shutdown cleans up owned jobs; an abrupt bridge death leaves the
 * job `interrupted` on restart, never re-run and never shown as running.
 * A15 a missing/incorrect runner produces an actionable diagnostic and no job
 * stuck in `starting`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { probeProcessIdentity } from '../dist/src/process-identity.js';
import * as H from './helpers/harness.mjs';

function allJobRecords(env) {
  const dir = path.join(env.state, 'jobs');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((jobId) => H.readJson(path.join(dir, jobId, 'job.json')))
    .filter(Boolean);
}

async function killTreeByPid(pid) {
  if (pid === null || pid === undefined) return;
  await new Promise((resolve) => {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('close', () => resolve());
    killer.on('error', () => resolve());
  });
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

test('A14 normal disconnect cancels the owned job and leaves no live child', async () => {
  const env = H.makeEnv('a14-shutdown');
  const configPath = H.writeConfig(env, { __name: 'a14shutdown' });
  const taskFile = H.writeTask(env, 'shutdown.md', 'FAKE_SLEEP_MS=60000\nlong\n');
  const bridge = await H.startBridge(configPath, env, { name: 'a14shutdown' });
  const submit = await H.callTool(bridge.client, 'dsh_submit', {
    requestId: 'a14-shutdown',
    workspaceId: 'impl',
    taskFile,
    mode: 'implement',
  });
  const jobId = submit.payload.jobId;
  await H.sleep(700);
  const running = await H.callTool(bridge.client, 'dsh_status', { jobId });
  assert.equal(running.payload.job.status, 'running');
  const childPid = running.payload.job.pid;

  await bridge.close();
  await H.waitFor(() => {
    const record = H.readJson(path.join(env.state, 'jobs', jobId, 'job.json'));
    return record.status !== 'running';
  }, 10000);

  const record = H.readJson(path.join(env.state, 'jobs', jobId, 'job.json'));
  assert.ok(['cancelled', 'interrupted'].includes(record.status), `status after shutdown: ${record.status}`);
  assert.ok(record.endedAt !== null);
  await H.sleep(500);
  let stillAlive = true;
  try {
    process.kill(childPid, 0);
  } catch {
    stillAlive = false;
  }
  assert.equal(stillAlive, false, 'no bridge-owned child survived a normal shutdown');
});

test('A14 abrupt death marks the job interrupted on restart without re-running it', async () => {
  const env = H.makeEnv('a14-restart');
  const configPath = H.writeConfig(env, { __name: 'a14restart' });
  const taskFile = H.writeTask(env, 'orphan.md', 'FAKE_SLEEP_MS=60000\norphan\n');
  const first = await H.startBridge(configPath, env, { name: 'a14-first' });
  const submit = await H.callTool(first.client, 'dsh_submit', {
    requestId: 'a14-restart',
    workspaceId: 'impl',
    taskFile,
    mode: 'implement',
  });
  const jobId = submit.payload.jobId;
  await H.sleep(700);
  const running = await H.callTool(first.client, 'dsh_status', { jobId });
  assert.equal(running.payload.job.status, 'running');
  const childPid = running.payload.job.pid;
  const serverPid = first.serverPid();

  process.kill(serverPid, 'SIGKILL');
  await H.sleep(800);
  try {
    await first.close();
  } catch {
    /* the transport is already gone */
  }

  const second = await H.startBridge(configPath, env, { name: 'a14-second' });
  try {
    const recovered = await H.callTool(second.client, 'dsh_status', { jobId });
    assert.equal(recovered.payload.job.status, 'interrupted');
    assert.equal(recovered.payload.job.error.code, 'INTERRUPTED');
    assert.equal(recovered.payload.job.terminal, true);
    assert.equal(recovered.payload.job.recovered, true);

    const records = allJobRecords(env);
    assert.equal(records.length, 1, 'the restart did not re-run the job');
    assert.equal(records[0].jobId, jobId);
    assert.equal(records.every((record) => ['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(record.status)), true);

    const health = await H.callTool(second.client, 'dsh_health');
    assert.equal(health.payload.activeJob, null);
    assert.match(health.payload.recovery.policy, /never re-run/);

    // R04: a recorded pid that is still alive blocks new work until resolved.
    let orphanAlive = true;
    try {
      process.kill(childPid, 0);
    } catch {
      orphanAlive = false;
    }
    if (orphanAlive) {
      assert.equal(health.payload.orphanBlock.pids.includes(childPid), true, 'the surviving orphan is reported');
      const blocked = await H.callToolExpectError(second.client, 'dsh_submit', {
        requestId: 'a14-blocked',
        workspaceId: 'impl',
        taskFile,
        mode: 'implement',
      });
      assert.equal(blocked.code, 'ORPHAN_UNRESOLVED');
      assert.match(blocked.message, /Resolve it first/);
      assert.deepEqual(allJobRecords(env).length, 1, 'the blocked submission created no job');
    } else {
      // The host already reaped the child: the bridge must then accept work.
      const accepted = await H.callTool(second.client, 'dsh_submit', {
        requestId: 'a14-orphan-gone',
        workspaceId: 'impl',
        taskFile: H.writeTask(env, 'after-restart.md', 'FAKE_EXIT=0\nok\n'),
        mode: 'implement',
      });
      assert.equal(accepted.isError, false);
      await H.waitForTerminal(second.client, accepted.payload.jobId);
    }
    await killTreeByPid(childPid);
  } finally {
    await second.close();
  }
});

test('A14 orphan recovery terminates only a proved child identity and otherwise only blocks', async () => {
  const env = H.makeEnv('a14-orphan-identity');
  const benignConfig = H.writeConfig(env, { __name: 'a14identity' });
  // 1. Produce a real job record, then leave it as if the bridge had died while
  //    the job was running, with the pid pointing at a process that is really
  //    alive and whose identity the bridge never recorded.
  const first = await H.startBridge(benignConfig, env, { name: 'a14i-first' });
  const submitted = await H.callTool(first.client, 'dsh_submit', {
    requestId: 'a14-identity',
    workspaceId: 'impl',
    taskFile: H.writeTask(env, 'quick.md', 'FAKE_EXIT=0\nquick\n'),
    mode: 'implement',
  });
  const jobId = submitted.payload.jobId;
  await H.waitForTerminal(first.client, jobId);
  await first.close();
  await H.sleep(400);

  const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  const jobFile = path.join(env.state, 'jobs', jobId, 'job.json');
  const record = H.readJson(jobFile);
  record.status = 'running';
  record.endedAt = null;
  record.exitCode = null;
  record.pid = orphan.pid;
  record.childIdentity = null;
  record.recovered = false;
  record.cleanup = null;
  fs.writeFileSync(jobFile, JSON.stringify(record, null, 2));

  try {
    // 2. Default policy: never terminate an unprovable pid; block new work.
    const blockedBridge = await H.startBridge(benignConfig, env, { name: 'a14i-blocked' });
    try {
      const health = await H.callTool(blockedBridge.client, 'dsh_health');
      assert.equal(health.payload.orphanBlock.pids.includes(orphan.pid), true, 'the live orphan is reported');
      assert.match(health.payload.orphanBlock.guidance, /Inspect the pid yourself/);
      const recovered = await H.callTool(blockedBridge.client, 'dsh_status', { jobId });
      assert.equal(recovered.payload.job.status, 'interrupted');
      const error = await H.callToolExpectError(blockedBridge.client, 'dsh_submit', {
        requestId: 'a14i-blocked',
        workspaceId: 'impl',
        taskFile: H.writeTask(env, 'blocked.md', 'FAKE_EXIT=0\nblocked\n'),
        mode: 'implement',
      });
      assert.equal(error.code, 'ORPHAN_UNRESOLVED');
      assert.equal(alive(orphan.pid), true, 'the default policy never kills an unprovable pid');
    } finally {
      await blockedBridge.close();
    }
    await H.sleep(400);

    // 3. Even with the cleanup switch enabled, an unrecorded identity is not
    //    proof: the pid must survive and new work must stay blocked.
    const unprovenConfig = H.writeConfig(env, { __name: 'a14identity-unproven', recovery: { killOrphanedChildrenOnStart: true } });
    const unprovenBridge = await H.startBridge(unprovenConfig, env, { name: 'a14i-unproven' });
    try {
      const health = await H.callTool(unprovenBridge.client, 'dsh_health');
      assert.equal(health.payload.orphanBlock.pids.includes(orphan.pid), true, 'unproven identity keeps the block');
      assert.equal(alive(orphan.pid), true, 'an unprovable pid is never terminated');
      const error = await H.callToolExpectError(unprovenBridge.client, 'dsh_submit', {
        requestId: 'a14i-unproven',
        workspaceId: 'impl',
        taskFile: H.writeTask(env, 'unproven.md', 'FAKE_EXIT=0\nunproven\n'),
        mode: 'implement',
      });
      assert.equal(error.code, 'ORPHAN_UNRESOLVED');
    } finally {
      await unprovenBridge.close();
    }
    await H.sleep(400);

    // 4. With a recorded, matching OS identity the bridge may terminate it and
    //    only then accept new work.
    const probe = probeProcessIdentity(orphan.pid);
    assert.equal(probe.status, 'ok', `identity probe failed: ${probe.reason ?? ''}`);
    const withIdentity = H.readJson(jobFile);
    withIdentity.status = 'running';
    withIdentity.endedAt = null;
    withIdentity.pid = orphan.pid;
    withIdentity.recovered = false;
    withIdentity.cleanup = null;
    withIdentity.childIdentity = {
      pid: orphan.pid,
      creationTimeMs: probe.identity.creationTimeMs,
      executablePath: probe.identity.executablePath,
      commandLineDigest: probe.identity.commandLineDigest,
    };
    fs.writeFileSync(jobFile, JSON.stringify(withIdentity, null, 2));

    const provenConfig = H.writeConfig(env, { __name: 'a14identity-proven', recovery: { killOrphanedChildrenOnStart: true } });
    const provenBridge = await H.startBridge(provenConfig, env, { name: 'a14i-proven' });
    try {
      const health = await H.callTool(provenBridge.client, 'dsh_health');
      assert.equal(health.payload.orphanBlock, null, 'the verified pid was terminated and confirmed');
      const accepted = await H.callTool(provenBridge.client, 'dsh_submit', {
        requestId: 'a14i-after',
        workspaceId: 'impl',
        taskFile: H.writeTask(env, 'after.md', 'FAKE_EXIT=0\nok\n'),
        mode: 'implement',
      });
      assert.equal(accepted.isError, false, 'a verified cleanup releases the block');
      const finished = await H.waitForTerminal(provenBridge.client, accepted.payload.jobId);
      assert.equal(finished.status, 'completed');
      assert.equal(alive(orphan.pid), false, 'the identity-proven orphan was terminated');
      const recordAfter = H.readJson(jobFile);
      assert.equal(recordAfter.cleanup.confirmed, true);
      assert.match(String(recordAfter.cleanup.detail), /identity proven/);
    } finally {
      await provenBridge.close();
    }
  } finally {
    if (alive(orphan.pid)) await killTreeByPid(orphan.pid);
  }
});

test('A15 an unavailable runner is diagnosed and jobs never stay in starting', async () => {
  const env = H.makeEnv('a15');
  const missing = path.join(env.dir, 'does-not-exist-runner.mjs');
  const configPath = H.writeConfig(env, {
    __name: 'a15',
    runner: {
      type: 'fake',
      fake: { command: process.execPath, argsPrefix: [missing] },
    },
  });
  const taskFile = H.writeTask(env, 'any.md', 'FAKE_EXIT=0\nok\n');
  const bridge = await H.startBridge(configPath, env, { name: 'a15' });
  try {
    const health = await H.callTool(bridge.client, 'dsh_health');
    assert.equal(health.payload.runner.available, false);
    assert.match(String(health.payload.runner.diagnostic), /not found/);

    const error = await H.callToolExpectError(bridge.client, 'dsh_submit', {
      requestId: 'a15-missing-runner',
      workspaceId: 'impl',
      taskFile,
      mode: 'implement',
    });
    assert.equal(error.code, 'RUNNER_UNAVAILABLE');
    assert.equal(health.payload.activeJob, null);
    const jobsDir = path.join(env.state, 'jobs');
    const entries = fs.existsSync(jobsDir) ? fs.readdirSync(jobsDir) : [];
    assert.deepEqual(entries, [], 'no job was created for an unavailable runner');

    const stderr = fs.readFileSync(bridge.stderrLog, 'utf8');
    assert.match(stderr, /runnerAvailable/);
  } finally {
    await bridge.close();
  }
});

test('A15 an unreadable DSH launch target is diagnosed without executing it', async () => {
  const env = H.makeEnv('a15-production');
  const configPath = H.writeConfig(env, {
    __name: 'a15prod',
    runner: {
      type: 'production',
      production: {
        command: process.execPath,
        argsPrefix: [path.join(env.dir, 'no-such-dsh', 'lib', 'bin.js')],
        profile: 'headless',
      },
    },
  });
  const bridge = await H.startBridge(configPath, env, { name: 'a15prod' });
  try {
    const health = await H.callTool(bridge.client, 'dsh_health');
    assert.equal(health.payload.runner.type, 'production');
    assert.equal(health.payload.runner.available, false);
    assert.match(String(health.payload.runner.diagnostic), /not found/);
    assert.equal(health.payload.activeJob, null);
  } finally {
    await bridge.close();
  }
});
