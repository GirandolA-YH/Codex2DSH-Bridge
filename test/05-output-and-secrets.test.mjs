/**
 * A12 output limits and pagination, A13 secret handling across results, logs,
 * job records and diagnostics.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as H from './helpers/harness.mjs';

const CAP = 5 * 1024 * 1024;
const PAGE = 64 * 1024;

test('A12 oversized output is capped, drained and paginated without stalling', async () => {
  const env = H.makeEnv('a12');
  const configPath = H.writeConfig(env, { __name: 'a12' });
  const hogBytes = 6 * 1024 * 1024;
  const taskFile = H.writeTask(env, 'hog.md', `FAKE_HOG_BYTES=${hogBytes}\nFAKE_HOG_LINED=1\nFAKE_EXIT=0\n`);
  const bridge = await H.startBridge(configPath, env, { name: 'a12' });
  try {
    const started = Date.now();
    const submit = await H.callTool(bridge.client, 'dsh_submit', {
      requestId: 'a12-hog',
      workspaceId: 'impl',
      taskFile,
      mode: 'implement',
    });
    const job = await H.waitForTerminal(bridge.client, submit.payload.jobId, 60000);
    const elapsed = Date.now() - started;
    assert.equal(job.status, 'completed', `hog job ended as ${job.status}`);
    assert.ok(elapsed < 45000, `hog job took ${elapsed} ms`);

    assert.equal(job.output.truncated.stdout, true);
    assert.equal(job.output.truncated.stderr, true);
    assert.ok(job.output.stdoutStoredBytes <= CAP, `stored ${job.output.stdoutStoredBytes} > cap`);
    assert.ok(job.output.stdoutStoredBytes >= CAP - 2 * PAGE, `stored only ${job.output.stdoutStoredBytes}`);
    assert.ok(job.output.stdoutRawBytes >= hogBytes, `raw ${job.output.stdoutRawBytes} < ${hogBytes}`);

    const firstPage = await H.callTool(bridge.client, 'dsh_result', { jobId: job.jobId, stream: 'stdout', limit: PAGE });
    assert.ok(firstPage.payload.page.pageBytes <= PAGE);
    assert.equal(firstPage.payload.page.maxPageBytes, PAGE);
    assert.equal(firstPage.payload.page.nextOffset, firstPage.payload.page.output.length);
    assert.equal(firstPage.payload.page.totalChars, job.output.stdoutStoredBytes);

    const secondOffset = firstPage.payload.page.nextOffset - 128;
    const secondPage = await H.callTool(bridge.client, 'dsh_result', {
      jobId: job.jobId,
      stream: 'stdout',
      offset: secondOffset,
      limit: 256,
    });
    assert.equal(secondPage.payload.page.offset, secondOffset);
    assert.notEqual(secondPage.payload.page.output, firstPage.payload.page.output);

    for (const logFile of [job.output.stdoutLog, job.output.stderrLog]) {
      const size = fs.statSync(logFile).size;
      assert.ok(size <= CAP + 4096, `log ${logFile} grew to ${size}`);
      assert.match(fs.readFileSync(logFile, 'utf8'), /output truncated/);
    }

    const record = H.readJson(path.join(env.state, 'jobs', job.jobId, 'job.json'));
    assert.equal(record.truncated.stdout, true);
    assert.equal(record.rawBytes.stdout, job.output.stdoutRawBytes);
  } finally {
    await bridge.close();
  }
});

test('A13 fake credentials never reach results, logs, job records or diagnostics', async () => {
  const env = H.makeEnv('a13');
  const configPath = H.writeConfig(env, { __name: 'a13' });
  const taskFile = H.writeTask(env, 'secret.md', 'FAKE_EXIT=0\nFAKE_SECRET=1\n');
  const bridge = await H.startBridge(configPath, env, { name: 'a13' });
  const needles = [/sk-FAKEsecretVALUE/, /FAKEBearerTokenVALUE/, /FAKEPasswordVALUE/];
  try {
    const submit = await H.callTool(bridge.client, 'dsh_submit', {
      requestId: 'a13-secret',
      workspaceId: 'impl',
      taskFile,
      mode: 'implement',
    });
    const job = await H.waitForTerminal(bridge.client, submit.payload.jobId);
    assert.equal(job.status, 'completed');

    const result = await H.callTool(bridge.client, 'dsh_result', { jobId: job.jobId, limit: PAGE });
    const serializedResult = JSON.stringify(result.payload);
    for (const needle of needles) assert.doesNotMatch(serializedResult, needle);
    assert.match(result.payload.page.output, /\*\*\*REDACTED\*\*\*/);

    const status = await H.callTool(bridge.client, 'dsh_status', { jobId: job.jobId });
    for (const needle of needles) assert.doesNotMatch(JSON.stringify(status.payload), needle);

    const health = await H.callTool(bridge.client, 'dsh_health');
    for (const needle of needles) assert.doesNotMatch(JSON.stringify(health.payload), needle);

    const recordText = fs.readFileSync(path.join(env.state, 'jobs', job.jobId, 'job.json'), 'utf8');
    const stdoutLog = fs.readFileSync(job.output.stdoutLog, 'utf8');
    const stderrLog = fs.readFileSync(job.output.stderrLog, 'utf8');
    for (const needle of needles) {
      assert.doesNotMatch(recordText, needle, 'job.json leaked a secret');
      assert.doesNotMatch(stdoutLog, needle, 'stdout log leaked a secret');
      assert.doesNotMatch(stderrLog, needle, 'stderr log leaked a secret');
    }
    assert.match(stdoutLog, /\*\*\*REDACTED\*\*\*/);
    assert.match(stderrLog, /\*\*\*REDACTED\*\*\*/);
  } finally {
    await bridge.close();
  }
});
