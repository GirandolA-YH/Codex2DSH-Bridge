/**
 * A07 input validation (clear error, no process started) and
 * A08 task-file path containment (traversal, prefix confusion, reparse escape).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as H from './helpers/harness.mjs';

function jobDirs(env) {
  const dir = path.join(env.state, 'jobs');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir);
}

test('A07 invalid arguments return stable codes and never start a job', async () => {
  const env = H.makeEnv('a07');
  const configPath = H.writeConfig(env, { __name: 'a07' });
  const goodTask = H.writeTask(env, 'good.md', 'FAKE_EXIT=0\nok\n');
  const emptyTask = H.writeTask(env, 'empty.md', '   \n\n');
  const bridge = await H.startBridge(configPath, env, { name: 'a07' });
  try {
    const cases = [
      [{ requestId: 'a07-1', workspaceId: 'impl', taskFile: goodTask, mode: 'deploy' }, 'INVALID_MODE'],
      [{ requestId: 'a07-2', workspaceId: 'nope', taskFile: goodTask, mode: 'implement' }, 'UNKNOWN_WORKSPACE'],
      [{ requestId: 'a07-3', workspaceId: 'impl', taskFile: goodTask, mode: 'implement', timeoutSeconds: 0 }, 'INVALID_TIMEOUT'],
      [{ requestId: 'a07-4', workspaceId: 'impl', taskFile: goodTask, mode: 'implement', timeoutSeconds: 3601 }, 'INVALID_TIMEOUT'],
      [{ requestId: 'a07-5', workspaceId: 'impl', taskFile: goodTask, mode: 'implement', timeoutSeconds: 'abc' }, 'INVALID_TIMEOUT'],
      [{ requestId: 'a07-6', workspaceId: 'impl', taskFile: emptyTask, mode: 'implement' }, 'EMPTY_TASK'],
      [{ requestId: 'a07-7', workspaceId: 'impl', taskFile: path.join(env.tasks, 'missing.md'), mode: 'implement' }, 'TASK_FILE_NOT_FOUND'],
      [{ requestId: 'a07-8', workspaceId: 'impl', taskFile: env.tasks, mode: 'implement' }, 'TASK_FILE_UNREADABLE'],
      [{ requestId: 'a07-9', workspaceId: 'impl', taskFile: goodTask, mode: 'implement', command: 'calc.exe' }, 'INVALID_ARGUMENT'],
      [{ requestId: '', workspaceId: 'impl', taskFile: goodTask, mode: 'implement' }, 'INVALID_ARGUMENT'],
    ];
    for (const [args, code] of cases) {
      const error = await H.callToolExpectError(bridge.client, 'dsh_submit', args);
      assert.equal(error.code, code, `args ${JSON.stringify(args)} → ${JSON.stringify(error)}`);
      assert.equal(typeof error.message, 'string');
    }

    const statusError = await H.callToolExpectError(bridge.client, 'dsh_status', { jobId: 'job-ffffffffffffffff' });
    assert.equal(statusError.code, 'JOB_NOT_FOUND');
    const malformed = await H.callToolExpectError(bridge.client, 'dsh_status', { jobId: '../../etc/passwd' });
    assert.equal(malformed.code, 'INVALID_ARGUMENT');
    const resultError = await H.callToolExpectError(bridge.client, 'dsh_result', { jobId: 'job-ffffffffffffffff' });
    assert.equal(resultError.code, 'JOB_NOT_FOUND');
    const cancelError = await H.callToolExpectError(bridge.client, 'dsh_cancel', { jobId: 'job-ffffffffffffffff' });
    assert.equal(cancelError.code, 'JOB_NOT_FOUND');
    const badStream = await H.callToolExpectError(bridge.client, 'dsh_result', {
      jobId: 'job-ffffffffffffffff',
      stream: 'nope',
    });
    assert.ok(['JOB_NOT_FOUND', 'INVALID_ARGUMENT'].includes(badStream.code));

    assert.deepEqual(jobDirs(env), [], 'no job directory was created for rejected input');
    const health = await H.callTool(bridge.client, 'dsh_health');
    assert.equal(health.payload.activeJob, null);
  } finally {
    await bridge.close();
  }
});

test('A08 task files outside the allowed roots are rejected without starting a process', async () => {
  const env = H.makeEnv('a08');
  const configPath = H.writeConfig(env, { __name: 'a08' });
  const sentinel = path.join(env.impl, 'should-not-exist.txt');

  const prefixSibling = path.join(env.dir, 'tasks-evil');
  fs.mkdirSync(prefixSibling, { recursive: true });
  const prefixTask = path.join(prefixSibling, 'evil.md');
  fs.writeFileSync(prefixTask, `FAKE_EXIT=0\nFAKE_CREATE=${sentinel}\n`);

  const junction = path.join(env.tasks, 'escape');
  fs.symlinkSync(env.outside, junction, 'junction');
  const junctionTask = path.join(junction, 'secret.txt');

  const outsideTask = path.join(env.outside, 'secret.txt');
  fs.writeFileSync(outsideTask, `FAKE_EXIT=0\nFAKE_CREATE=${sentinel}\n`);

  const bridge = await H.startBridge(configPath, env, { name: 'a08' });
  try {
    const rejected = [
      path.join(env.tasks, '..', 'outside', 'secret.txt'),
      outsideTask,
      prefixTask,
      junctionTask,
    ];
    for (const taskFile of rejected) {
      const error = await H.callToolExpectError(bridge.client, 'dsh_submit', {
        requestId: `a08-${path.basename(taskFile)}`,
        workspaceId: 'impl',
        taskFile,
        mode: 'implement',
      });
      assert.equal(error.code, 'PATH_NOT_ALLOWED', `${taskFile} → ${JSON.stringify(error)}`);
    }
    assert.equal(fs.existsSync(sentinel), false, 'no rejected task file reached a child process');
    assert.deepEqual(jobDirs(env), []);

    const validTask = H.writeTask(env, 'valid.md', 'FAKE_EXIT=0\nok\n');
    const submit = await H.callTool(bridge.client, 'dsh_submit', {
      requestId: 'a08-valid',
      workspaceId: 'impl',
      taskFile: validTask,
      mode: 'implement',
    });
    assert.equal(submit.isError, false);
    const job = await H.waitForTerminal(bridge.client, submit.payload.jobId);
    assert.equal(job.status, 'completed');
  } finally {
    await bridge.close();
  }
});
