/**
 * A03 async submit, A04 exit-code mapping, A05 byte-exact task delivery,
 * A06 frozen accepted task copy. Runner: fake child process (no model call).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as H from './helpers/harness.mjs';

const sha256 = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

function extractBlock(text, begin, end) {
  const start = text.indexOf(begin);
  const stop = text.lastIndexOf(end);
  assert.ok(start >= 0 && stop > start, `markers not found in output: ${text.slice(0, 300)}`);
  return text.slice(start + begin.length, stop);
}

test('A03 submit returns a jobId within two seconds and status is readable while running', async () => {
  const env = H.makeEnv('a03');
  const configPath = H.writeConfig(env, { __name: 'a03' });
  const taskFile = H.writeTask(env, 'slow.md', 'FAKE_SLEEP_MS=2000\nslow job\n');
  const bridge = await H.startBridge(configPath, env, { name: 'a03' });
  try {
    const started = Date.now();
    const submit = await H.callTool(bridge.client, 'dsh_submit', {
      requestId: 'a03-async',
      workspaceId: 'impl',
      taskFile,
      mode: 'implement',
    });
    const elapsed = Date.now() - started;
    assert.equal(submit.isError, false);
    assert.ok(elapsed < 2000, `submit took ${elapsed} ms`);
    assert.ok(['starting', 'running'].includes(submit.payload.status), `status ${submit.payload.status}`);

    await H.sleep(600);
    const running = await H.callTool(bridge.client, 'dsh_status', { jobId: submit.payload.jobId });
    assert.equal(running.payload.job.status, 'running');
    assert.equal(running.payload.job.terminal, false);
    assert.equal(typeof running.payload.job.pid, 'number');

    const finished = await H.waitForTerminal(bridge.client, submit.payload.jobId);
    assert.equal(finished.status, 'completed');
    assert.equal(finished.timedOut, false);
  } finally {
    await bridge.close();
  }
});

test('A04 exit code maps to completed/failed and never to an acceptance verdict', async () => {
  const env = H.makeEnv('a04');
  const configPath = H.writeConfig(env, { __name: 'a04' });
  const okTask = H.writeTask(env, 'ok.md', 'FAKE_EXIT=0\nfine\n');
  const badTask = H.writeTask(env, 'bad.md', 'FAKE_EXIT=3\nbroken\nFAKE_STDERR=boom\n');
  const bridge = await H.startBridge(configPath, env, { name: 'a04' });
  try {
    const ok = await H.callTool(bridge.client, 'dsh_submit', {
      requestId: 'a04-ok',
      workspaceId: 'impl',
      taskFile: okTask,
      mode: 'implement',
    });
    const okJob = await H.waitForTerminal(bridge.client, ok.payload.jobId);
    assert.equal(okJob.status, 'completed');
    assert.equal(okJob.exitCode, 0);
    assert.equal(okJob.error, null);

    const bad = await H.callTool(bridge.client, 'dsh_submit', {
      requestId: 'a04-bad',
      workspaceId: 'impl',
      taskFile: badTask,
      mode: 'implement',
    });
    const badJob = await H.waitForTerminal(bridge.client, bad.payload.jobId);
    assert.equal(badJob.status, 'failed');
    assert.equal(badJob.exitCode, 3);
    assert.equal(badJob.error.code, 'PROCESS_EXIT_NONZERO');

    const forbidden = ['accepted', 'verified', 'approved', 'passed', 'ok'];
    assert.equal(forbidden.includes(okJob.status), false);
    assert.equal(Object.prototype.hasOwnProperty.call(okJob, 'accepted'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(okJob, 'verdict'), false);
    const health = await H.callTool(bridge.client, 'dsh_health');
    assert.match(JSON.stringify(health.payload.recovery), /never re-run/);
  } finally {
    await bridge.close();
  }
});

test('A05 quotes, newlines, backticks and $( ) reach the child as data', async () => {
  const env = H.makeEnv('a05');
  const configPath = H.writeConfig(env, { __name: 'a05' });
  const taskText =
    'FAKE_EXIT=0\n' +
    '中文任务：实现「引号」与空格   多个空格\n' +
    'double "quotes" and single \'quotes\'\n' +
    'backtick `whoami` and dollar $(New-Item hijack.txt) and %USERNAME%\n' +
    'semicolons; ampersands & pipes | redirect > file\n' +
    'trailing line without newline';
  const taskFile = H.writeTask(env, 'fidelity.md', taskText);
  const bridge = await H.startBridge(configPath, env, { name: 'a05' });
  try {
    const submit = await H.callTool(bridge.client, 'dsh_submit', {
      requestId: 'a05-fidelity',
      workspaceId: 'impl',
      taskFile,
      mode: 'implement',
    });
    const job = await H.waitForTerminal(bridge.client, submit.payload.jobId);
    assert.equal(job.status, 'completed');

    const result = await H.callTool(bridge.client, 'dsh_result', {
      jobId: job.jobId,
      stream: 'stdout',
      limit: 65536,
    });
    const received = extractBlock(result.payload.page.output, '<<<PROMPT_BEGIN>>>\n', '\n<<<PROMPT_END>>>');
    assert.equal(received, taskText, 'child received the accepted task byte for byte');
    assert.equal(job.task.promptKind, 'inline');

    assert.equal(fs.existsSync(path.join(env.impl, 'hijack.txt')), false, 'no shell interpolation happened');
    assert.equal(fs.existsSync(path.join(env.work, 'hijack.txt')), false);
  } finally {
    await bridge.close();
  }
});

test('A06 the accepted copy is frozen and hashed; later edits cannot change it', async () => {
  const env = H.makeEnv('a06');
  const configPath = H.writeConfig(env, { __name: 'a06' });
  const original = 'FAKE_EXIT=0\nORIGINAL正文\n';
  const taskFile = H.writeTask(env, 'frozen.md', original);
  const bridge = await H.startBridge(configPath, env, { name: 'a06' });
  try {
    const submit = await H.callTool(bridge.client, 'dsh_submit', {
      requestId: 'a06-frozen',
      workspaceId: 'impl',
      taskFile,
      mode: 'implement',
    });
    // Mutate the original immediately after acceptance.
    fs.writeFileSync(taskFile, 'FAKE_EXIT=0\nMUTATED正文\n');

    const job = await H.waitForTerminal(bridge.client, submit.payload.jobId);
    assert.equal(job.task.sha256, sha256(original));
    assert.equal(fs.readFileSync(job.task.acceptedCopy, 'utf8'), original);

    const result = await H.callTool(bridge.client, 'dsh_result', { jobId: job.jobId, stream: 'stdout', limit: 65536 });
    const received = extractBlock(result.payload.page.output, '<<<PROMPT_BEGIN>>>\n', '\n<<<PROMPT_END>>>');
    assert.equal(received, original);
    assert.doesNotMatch(result.payload.page.output, /MUTATED/);
  } finally {
    await bridge.close();
  }
});

test('A06 large tasks switch to pointer handoff and the child still gets the frozen copy', async () => {
  const env = H.makeEnv('a06-pointer');
  const configPath = H.writeConfig(env, {
    __name: 'a06pointer',
    limits: {
      defaultTimeoutSeconds: 30,
      minTimeoutSeconds: 1,
      maxTimeoutSeconds: 60,
      perStreamCaptureCapBytes: 5 * 1024 * 1024,
      resultPageMaxBytes: 64 * 1024,
      inlineTaskMaxChars: 200,
      maxTaskFileBytes: 1024 * 1024,
    },
  });
  const original = `FAKE_EXIT=0\nFAKE_PRINT_TASKFILE=1\n${'长任务正文 '.repeat(80)}\nEND\n`;
  const taskFile = H.writeTask(env, 'big.md', original);
  const bridge = await H.startBridge(configPath, env, { name: 'a06pointer' });
  try {
    const submit = await H.callTool(bridge.client, 'dsh_submit', {
      requestId: 'a06-pointer',
      workspaceId: 'impl',
      taskFile,
      mode: 'implement',
    });
    fs.writeFileSync(taskFile, 'FAKE_EXIT=0\nMUTATED\n');
    const job = await H.waitForTerminal(bridge.client, submit.payload.jobId);
    assert.equal(job.task.promptKind, 'pointer');
    assert.equal(job.task.sha256, sha256(original));

    const result = await H.callTool(bridge.client, 'dsh_result', { jobId: job.jobId, stream: 'stdout', limit: 65536 });
    const prompt = extractBlock(result.payload.page.output, '<<<PROMPT_BEGIN>>>\n', '\n<<<PROMPT_END>>>');
    assert.match(prompt, /已冻结的任务文件/);
    assert.match(prompt, new RegExp(job.task.sha256));
    assert.equal(prompt.includes('长任务正文'), false, 'the body is not repeated in the prompt');

    const copied = extractBlock(result.payload.page.output, '<<<TASKFILE_BEGIN>>>\n', '\n<<<TASKFILE_END>>>');
    assert.equal(copied, original);
  } finally {
    await bridge.close();
  }
});
