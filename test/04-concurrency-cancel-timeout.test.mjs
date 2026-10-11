/**
 * A09 idempotency and single-active-job concurrency,
 * A10 cancellation of the whole owned process tree (unrelated processes survive),
 * A11 timeout termination and cancel/exit race stability.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as H from './helpers/harness.mjs';

function jobDirs(env) {
  const dir = path.join(env.state, 'jobs');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

function heartbeatPid(file) {
  if (!fs.existsSync(file)) return null;
  const first = fs.readFileSync(file, 'utf8').split('\n')[0];
  const match = /^pid=(\d+)$/.exec(first.trim());
  return match === null ? null : Number(match[1]);
}

function alive(pid) {
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function killTree(pid) {
  if (pid === null) return;
  await new Promise((resolve) => {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('close', () => resolve());
    killer.on('error', () => resolve());
  });
}

test('A09 same requestId is idempotent, different content conflicts, other work is BUSY', async () => {
  const env = H.makeEnv('a09');
  const configPath = H.writeConfig(env, { __name: 'a09' });
  const first = H.writeTask(env, 'first.md', 'FAKE_EXIT=0\nfirst\n');
  const second = H.writeTask(env, 'second.md', 'FAKE_EXIT=0\nsecond\n');
  const slow = H.writeTask(env, 'slow.md', 'FAKE_SLEEP_MS=2500\nslow\n');
  const bridge = await H.startBridge(configPath, env, { name: 'a09' });
  try {
    const a = await H.callTool(bridge.client, 'dsh_submit', {
      requestId: 'a09-idem',
      workspaceId: 'impl',
      taskFile: first,
      mode: 'implement',
    });
    const b = await H.callTool(bridge.client, 'dsh_submit', {
      requestId: 'a09-idem',
      workspaceId: 'impl',
      taskFile: first,
      mode: 'implement',
    });
    assert.equal(a.payload.jobId, b.payload.jobId);
    assert.equal(b.payload.reusedExistingJob, true);
    assert.equal(jobDirs(env).length, 1, 'a retry did not create a second job');

    const conflict = await H.callToolExpectError(bridge.client, 'dsh_submit', {
      requestId: 'a09-idem',
      workspaceId: 'impl',
      taskFile: second,
      mode: 'implement',
    });
    assert.equal(conflict.code, 'REQUEST_CONFLICT');
    assert.equal(jobDirs(env).length, 1);

    await H.waitForTerminal(bridge.client, a.payload.jobId);

    const running = await H.callTool(bridge.client, 'dsh_submit', {
      requestId: 'a09-slow',
      workspaceId: 'impl',
      taskFile: slow,
      mode: 'implement',
    });
    await H.sleep(400);
    const busy = await H.callToolExpectError(bridge.client, 'dsh_submit', {
      requestId: 'a09-other',
      workspaceId: 'impl',
      taskFile: second,
      mode: 'implement',
    });
    assert.equal(busy.code, 'BUSY');
    assert.equal(busy.details.activeJobId, running.payload.jobId);
    await H.waitForTerminal(bridge.client, running.payload.jobId);
  } finally {
    await bridge.close();
  }
});

test('A10 cancel stops the fake job and its descendant but not unrelated processes', async () => {
  const env = H.makeEnv('a10');
  const configPath = H.writeConfig(env, { __name: 'a10' });
  const heartbeat = path.join(env.dir, 'heartbeat.txt');
  const taskFile = H.writeTask(env, 'tree.md', `FAKE_SPAWN_CHILD=${heartbeat}\nFAKE_SLEEP_MS=60000\n`);
  const bridge = await H.startBridge(configPath, env, { name: 'a10' });

  // A process the bridge never started: it must survive the cancellation.
  const sentinel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });

  try {
    const submit = await H.callTool(bridge.client, 'dsh_submit', {
      requestId: 'a10-cancel',
      workspaceId: 'impl',
      taskFile,
      mode: 'implement',
    });
    const jobId = submit.payload.jobId;
    await H.waitFor(() => fs.existsSync(heartbeat), 10000);
    const grandchildPid = heartbeatPid(heartbeat);
    assert.ok(grandchildPid !== null, 'grandchild wrote its pid');
    assert.equal(alive(grandchildPid), true);
    const before = fs.statSync(heartbeat).size;
    await H.sleep(600);
    assert.ok(fs.statSync(heartbeat).size > before, 'grandchild was running before cancel');

    const cancelled = await H.callTool(bridge.client, 'dsh_cancel', { jobId });
    assert.equal(cancelled.isError, false);
    assert.equal(cancelled.payload.job.status, 'cancelled');
    assert.equal(cancelled.payload.alreadyTerminal, false);

    await H.sleep(800);
    const sizeAfter = fs.statSync(heartbeat).size;
    await H.sleep(700);
    assert.equal(fs.statSync(heartbeat).size, sizeAfter, 'descendant stopped producing heartbeats');
    assert.equal(alive(grandchildPid), false, 'grandchild was terminated with the tree');
    assert.equal(alive(sentinel.pid), true, 'unrelated process survived');

    const again = await H.callTool(bridge.client, 'dsh_cancel', { jobId });
    assert.equal(again.payload.alreadyTerminal, true);
    assert.equal(again.payload.job.status, 'cancelled');
    const status = await H.callTool(bridge.client, 'dsh_status', { jobId });
    assert.equal(status.payload.job.status, 'cancelled');
  } finally {
    sentinel.kill('SIGKILL');
    await bridge.close();
  }
});

test('A11 timeout terminates the tree and cancel/exit races settle on one stable state', async () => {
  const env = H.makeEnv('a11');
  const configPath = H.writeConfig(env, { __name: 'a11' });
  const heartbeat = path.join(env.dir, 'heartbeat-timeout.txt');
  const timeoutTask = H.writeTask(env, 'timeout.md', `FAKE_SPAWN_CHILD=${heartbeat}\nFAKE_SLEEP_MS=60000\n`);
  const raceTask = H.writeTask(env, 'race.md', 'FAKE_SLEEP_MS=60000\nrace\n');
  const bridge = await H.startBridge(configPath, env, { name: 'a11' });
  try {
    const submit = await H.callTool(bridge.client, 'dsh_submit', {
      requestId: 'a11-timeout',
      workspaceId: 'impl',
      taskFile: timeoutTask,
      mode: 'implement',
      timeoutSeconds: 2,
    });
    const job = await H.waitForTerminal(bridge.client, submit.payload.jobId, 20000);
    assert.equal(job.status, 'timed_out');
    assert.equal(job.timedOut, true);
    assert.equal(job.error.code, 'TIMEOUT');
    await H.sleep(800);
    const grandchildPid = heartbeatPid(heartbeat);
    assert.equal(alive(grandchildPid), false, 'timeout killed the descendant too');

    const race = await H.callTool(bridge.client, 'dsh_submit', {
      requestId: 'a11-race',
      workspaceId: 'impl',
      taskFile: raceTask,
      mode: 'implement',
      timeoutSeconds: 3,
    });
    await H.sleep(250);
    const cancelResult = await H.callTool(bridge.client, 'dsh_cancel', { jobId: race.payload.jobId });
    assert.equal(cancelResult.isError, false);
    const first = await H.waitForTerminal(bridge.client, race.payload.jobId, 20000);
    assert.ok(['cancelled', 'timed_out'].includes(first.status), `unexpected status ${first.status}`);
    const reads = [];
    for (let index = 0; index < 3; index += 1) {
      const snapshot = await H.callTool(bridge.client, 'dsh_status', { jobId: race.payload.jobId });
      reads.push(`${snapshot.payload.job.status}|${snapshot.payload.job.endedAt}`);
      await H.sleep(300);
    }
    assert.equal(new Set(reads).size, 1, `terminal state changed across reads: ${reads.join(' , ')}`);
    const record = H.readJson(path.join(env.state, 'jobs', race.payload.jobId, 'job.json'));
    assert.equal(record.status, first.status);
    assert.ok(record.endedAt !== null);
  } finally {
    await bridge.close();
  }
});
