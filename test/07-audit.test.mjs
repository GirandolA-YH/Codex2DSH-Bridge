/**
 * A16 audit isolation: a fresh snapshot is the audit cwd, source and snapshot
 * manifests are compared before/after, and any movement fails the audit instead
 * of being reported as a clean read-only run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as H from './helpers/harness.mjs';

function extractBlock(text, begin, end) {
  const start = text.indexOf(begin);
  const stop = text.lastIndexOf(end);
  assert.ok(start >= 0 && stop > start, `markers not found: ${text.slice(0, 200)}`);
  return text.slice(start + begin.length, stop);
}

test('A16 audit mode refuses an implementation workspace and runs in a fresh snapshot', async () => {
  const env = H.makeEnv('a16');
  const configPath = H.writeConfig(env, { __name: 'a16' });
  const taskFile = H.writeTask(env, 'audit.md', 'FAKE_EXIT=0\nFAKE_PRINT_CWD=1\nFAKE_SLEEP_MS=300\naudit this\n');
  const bridge = await H.startBridge(configPath, env, { name: 'a16' });
  try {
    const refused = await H.callToolExpectError(bridge.client, 'dsh_submit', {
      requestId: 'a16-refused',
      workspaceId: 'impl',
      taskFile,
      mode: 'audit',
    });
    assert.equal(refused.code, 'WORKSPACE_MODE_NOT_ALLOWED');

    const submit = await H.callTool(bridge.client, 'dsh_submit', {
      requestId: 'a16-audit',
      workspaceId: 'audit',
      taskFile,
      mode: 'audit',
    });
    assert.equal(submit.isError, false);
    const job = await H.waitForTerminal(bridge.client, submit.payload.jobId);
    assert.equal(job.status, 'completed');
    assert.equal(job.audit.sourceWorkspaceId, 'impl');
    assert.equal(job.audit.snapshotDir, env.audit);
    assert.equal(job.audit.sourceDir, env.impl);
    assert.equal(job.audit.sourceStable, true);
    assert.equal(job.audit.snapshotStable, true);
    assert.equal(job.audit.sourceManifestBefore.digest, job.audit.sourceManifestAfter.digest);
    assert.equal(job.audit.snapshotManifestBefore.digest, job.audit.snapshotManifestAfter.digest);

    assert.equal(fs.existsSync(path.join(env.audit, 'module.js')), true, 'snapshot contains the audited source');
    assert.equal(fs.existsSync(path.join(env.audit, 'state')), false, 'snapshot excludes runtime state');

    const result = await H.callTool(bridge.client, 'dsh_result', { jobId: job.jobId, stream: 'stdout', limit: 65536 });
    const cwdMatch = /<<<CWD>>>([^\n]*)/.exec(result.payload.page.output);
    assert.ok(cwdMatch !== null, 'the child reported its working directory');
    assert.equal(path.resolve(cwdMatch[1]), path.resolve(env.audit));
    assert.notEqual(path.resolve(cwdMatch[1]), path.resolve(env.impl));

    assert.ok(job.audit.reportPath !== null);
    assert.equal(path.dirname(job.audit.reportPath).startsWith(env.reports), true);
    const report = H.readJson(job.audit.reportPath);
    assert.equal(report.jobId, job.jobId);
    assert.match(report.isolationBoundary, /not an OS sandbox/);
    assert.equal(fs.existsSync(path.join(env.reports, `${job.jobId}.audit-final.md`)), true);
  } finally {
    await bridge.close();
  }
});

test('A16 a source change during the audit is reported as an audit failure', async () => {
  const env = H.makeEnv('a16-source-change');
  const configPath = H.writeConfig(env, { __name: 'a16change' });
  const taskFile = H.writeTask(env, 'audit-slow.md', 'FAKE_EXIT=0\nFAKE_SLEEP_MS=2500\naudit slowly\n');
  const bridge = await H.startBridge(configPath, env, { name: 'a16change' });
  try {
    const submit = await H.callTool(bridge.client, 'dsh_submit', {
      requestId: 'a16-source-change',
      workspaceId: 'audit',
      taskFile,
      mode: 'audit',
    });
    await H.sleep(600);
    fs.writeFileSync(path.join(env.impl, 'module.js'), 'export const value = 2; // moved during audit\n');
    const job = await H.waitForTerminal(bridge.client, submit.payload.jobId, 30000);
    assert.equal(job.status, 'failed');
    assert.equal(job.error.code, 'AUDIT_SOURCE_MODIFIED');
    assert.equal(job.audit.sourceStable, false);
    assert.equal(job.audit.sourceDiff.changed.includes('module.js'), true);
    assert.match(job.audit.findings.join(' '), /audited source changed/);
    const report = H.readJson(job.audit.reportPath);
    assert.equal(report.status, 'failed');
  } finally {
    await bridge.close();
  }
});

test('A16 a modified snapshot is reported as not read-only', async () => {
  const env = H.makeEnv('a16-snapshot-change');
  const configPath = H.writeConfig(env, { __name: 'a16snap' });
  const taskFile = H.writeTask(env, 'audit-write.md', 'FAKE_EXIT=0\nFAKE_CREATE=tampered.txt\nFAKE_SLEEP_MS=200\nwrite into cwd\n');
  const bridge = await H.startBridge(configPath, env, { name: 'a16snap' });
  try {
    const submit = await H.callTool(bridge.client, 'dsh_submit', {
      requestId: 'a16-snapshot-change',
      workspaceId: 'audit',
      taskFile,
      mode: 'audit',
    });
    const job = await H.waitForTerminal(bridge.client, submit.payload.jobId, 30000);
    assert.equal(job.status, 'failed');
    assert.equal(job.error.code, 'AUDIT_SNAPSHOT_MODIFIED');
    assert.equal(job.audit.snapshotStable, false);
    assert.equal(job.audit.sourceStable, true, 'the source itself did not move');
    assert.match(job.audit.findings.join(' '), /snapshot changed/);
  } finally {
    await bridge.close();
  }
});
