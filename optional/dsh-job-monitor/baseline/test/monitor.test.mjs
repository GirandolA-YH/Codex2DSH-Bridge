import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createMonitor } from '../src/monitor.mjs';
import {
  makeTempRoot,
  rmTree,
  writeJob,
  writeOwner,
  writeRawJobFile,
  makeJobRecord,
  snapshotTree,
  collectStrings,
  FAKE_SECRET,
  FAKE_BEARER,
  FAKE_TASK_BODY,
} from './helpers/fixture.mjs';

const J = (n) => `job-${String(n).padStart(16, '0')}`;

function iso(ms) {
  return new Date(ms).toISOString();
}

function buildFixture() {
  const root = makeTempRoot('dsh-monitor-state-');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'reports'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'power.mjs'), `// ${FAKE_SECRET}\n`, 'utf8');
  fs.writeFileSync(path.join(workspace, 'README.md'), `# ${FAKE_TASK_BODY}\n`, 'utf8');
  fs.writeFileSync(path.join(workspace, 'reports', 'M01-REPORT.md'), `# ${FAKE_BEARER}\n`, 'utf8');

  const now = Date.now();
  writeOwner(root, { startedAt: now - 3600000, heartbeatAt: now - 2000 });

  writeJob(root, J(1), makeJobRecord(J(1), {
    status: 'running',
    createdAt: iso(now - 70000),
    startedAt: iso(now - 60000),
    timeoutSeconds: 1200,
    bytes: { stdout: 10, stderr: 5 },
    rawBytes: { stdout: 10, stderr: 5 },
  }), { stdout: `${FAKE_BEARER}\n`, stderr: `${FAKE_SECRET}\n` });

  writeJob(root, J(2), makeJobRecord(J(2), {
    status: 'completed',
    createdAt: iso(now - 20 * 60000),
    startedAt: iso(now - 19 * 60000),
    endedAt: iso(now - 15 * 60000),
    exitCode: 0,
    workspaceId: 'test-workspace',
  }), { stdout: 'ok\n', stderr: '' });

  writeJob(root, J(3), makeJobRecord(J(3), {
    status: 'failed',
    createdAt: iso(now - 30 * 60000),
    startedAt: iso(now - 30 * 60000 + 1000),
    endedAt: iso(now - 29 * 60000),
    exitCode: 1,
    errorCode: 'SPAWN_FAILED',
    errorMessage: `${FAKE_SECRET} ${FAKE_BEARER}`,
  }), { stdout: '', stderr: `${FAKE_BEARER}\n` });

  writeJob(root, J(4), makeJobRecord(J(4), {
    status: 'timed_out',
    createdAt: iso(now - 40 * 60000),
    startedAt: iso(now - 40 * 60000),
    endedAt: iso(now - 20 * 60000),
    timedOut: true,
    timeoutSeconds: 1200,
    errorCode: 'CLEANUP_UNCONFIRMED',
    cleanup: { reason: 'timeout', requestedAt: iso(now - 20 * 60000), confirmed: false, confirmedAt: null, attempts: 2, detail: FAKE_SECRET, error: FAKE_BEARER },
  }));

  writeRawJobFile(root, J(5), `{ "jobId": "${J(5)}", "leak": "${FAKE_SECRET}", "task": "${FAKE_TASK_BODY}"\n`);

  writeJob(root, J(6), makeJobRecord(J(6), {
    status: 'warming_up',
    createdAt: iso(now - 50 * 60000),
    startedAt: iso(now - 50 * 60000),
    workspaceId: 'unmapped-workspace',
  }), { stdout: 'x\n', stderr: '' });

  const ledgerPath = path.join(root, 'acceptance-ledger.json');
  fs.writeFileSync(
    ledgerPath,
    `${JSON.stringify({
      schema: 'dsh-monitor/acceptance-ledger/v1',
      updatedAt: '2026-10-10',
      jobs: {
        [J(1)]: { status: 'pending', reviewedAt: '2026-10-10' },
        [J(2)]: { status: 'pass', reviewedAt: '2026-10-09', note: FAKE_SECRET },
        [J(3)]: { status: 'fail', reviewedAt: '2026-10-10' },
      },
    }, null, 2)}\n`,
    'utf8',
  );

  return { root, workspace, ledgerPath, now };
}

function makeMonitor(fixture, overrides = {}) {
  return createMonitor({
    stateRoot: fixture.root,
    acceptanceLedger: fixture.ledgerPath,
    workspaceMap: { byWorkspaceId: { 'test-workspace': fixture.workspace }, names: { [J(2)]: '本地映射名：R2 修复' } },
    now: () => fixture.now,
    ...overrides,
  });
}

test('列表：排序、计数、损坏记录单独列出而不是当作“无作业”', () => {
  const fixture = buildFixture();
  try {
    const monitor = makeMonitor(fixture);
    const list = monitor.list();
    assert.equal(list.readOnly, true);
    assert.equal(list.counts.totalJobDirectories, 6);
    assert.equal(list.counts.listed, 5);
    assert.equal(list.counts.unreadable, 1);
    assert.equal(list.counts.truncated, false);
    assert.deepEqual(list.jobs.map((job) => job.jobId), [J(1), J(2), J(3), J(4), J(6)]);
    assert.equal(list.unreadable[0].jobId, J(5));
    assert.equal(list.unreadable[0].code, 'INVALID_JSON');
    assert.equal(list.jobs.find((job) => job.jobId === J(2)).name, '本地映射名：R2 修复');
    assert.equal(list.jobs.find((job) => job.jobId === J(6)).status, 'unknown');
    assert.equal(list.jobs.find((job) => job.jobId === J(6)).statusKnown, false);
    assert.equal(list.jobs.find((job) => job.jobId === J(1)).nameSource, 'derived');
    assert.ok(Array.isArray(list.notes) && list.notes.length > 0);
  } finally {
    rmTree(fixture.root);
  }
});

test('终态用时按 endedAt 冻结，运行中用时继续增长', () => {
  const fixture = buildFixture();
  try {
    const monitor = makeMonitor(fixture);
    const first = monitor.detail(J(2)).value.job;
    fixture.now += 10 * 60000;
    const later = monitor.detail(J(2)).value.job;
    assert.equal(first.elapsedFrozen, true);
    assert.equal(later.elapsedFrozen, true);
    assert.equal(first.elapsedMs, 4 * 60000);
    assert.equal(later.elapsedMs, first.elapsedMs, '终态用时不随刷新增长');

    const running1 = monitor.detail(J(1)).value.job;
    fixture.now += 30000;
    const running2 = monitor.detail(J(1)).value.job;
    assert.equal(running1.elapsedFrozen, false);
    assert.equal(running2.elapsedMs - running1.elapsedMs, 30000);
    assert.equal(running1.limitMs, 1200000);
    assert.ok(running1.timeUsedRatio > 0 && running1.timeUsedRatio < 1);
  } finally {
    rmTree(fixture.root);
  }
});

test('执行状态与独立验收状态分开，且不从 exit 0 推断通过', () => {
  const fixture = buildFixture();
  try {
    const monitor = makeMonitor(fixture);
    const completed = monitor.detail(J(2)).value;
    assert.equal(completed.job.status, 'completed');
    assert.equal(completed.job.statusLabel, '正常结束');
    assert.equal(completed.acceptance.status, 'pass');
    assert.equal(completed.acceptance.label, '验收通过');

    const failed = monitor.detail(J(3)).value;
    assert.equal(failed.job.statusLabel, '失败');
    assert.equal(failed.acceptance.status, 'fail');
    assert.equal(failed.job.errorCode, 'SPAWN_FAILED');
    assert.ok(failed.job.errorLabel.includes('未能启动'));

    const noEntry = monitor.detail(J(4)).value;
    assert.equal(noEntry.job.statusLabel, '超时');
    assert.equal(noEntry.acceptance.status, 'none');
    assert.equal(noEntry.acceptance.label, '未提供验收记录');

    const withoutLedger = makeMonitor(fixture, { acceptanceLedger: null }).detail(J(2)).value;
    assert.equal(withoutLedger.job.status, 'completed');
    assert.equal(withoutLedger.acceptance.status, 'none', '没有账本时 completed 也不能变成通过');
    assert.equal(withoutLedger.acceptance.source, 'no-ledger');
  } finally {
    rmTree(fixture.root);
  }
});

test('活动：增长量与静默；不读取日志原文', () => {
  const fixture = buildFixture();
  try {
    const monitor = makeMonitor(fixture);
    const first = monitor.detail(J(1)).value.activity;
    assert.equal(first.firstSample, true);

    fs.appendFileSync(path.join(fixture.root, 'jobs', J(1), 'stdout.log'), 'more\n', 'utf8');
    fixture.now += 5000;
    const second = monitor.detail(J(1)).value.activity;
    assert.equal(second.firstSample, false);
    assert.equal(second.streams.stdout.deltaBytes, 5);
    assert.equal(second.streams.stderr.deltaBytes, 0);
    assert.equal(second.noNewActivity, false);

    fixture.now += 5000;
    const third = monitor.detail(J(1)).value.activity;
    assert.equal(third.noNewActivity, true);
    const serialized = JSON.stringify(third);
    assert.equal(serialized.includes('more'), false);
    assert.equal(serialized.includes(FAKE_BEARER), false);
    assert.equal(serialized.includes(FAKE_SECRET), false);
  } finally {
    rmTree(fixture.root);
  }
});

test('交付信息：白名单映射、相对路径、未配置时明确说明', () => {
  const fixture = buildFixture();
  try {
    const monitor = makeMonitor(fixture);
    const mapped = monitor.detail(J(2)).value.delivery;
    assert.equal(mapped.configured, true);
    assert.equal(mapped.match, 'byWorkspaceId');
    assert.ok(mapped.recentFiles.some((file) => file.path === 'src/power.mjs'));
    assert.ok(mapped.reportCandidates.some((file) => file.path === 'reports/M01-REPORT.md'));
    assert.equal(JSON.stringify(mapped).includes('node_modules'), false);
    assert.equal(mapped.root, undefined, '不向前端暴露白名单目录的绝对路径');
    assert.equal(mapped.testResult.status, 'not-provided', '测试结果必须显示“未提供”，不得靠日志 PASS 字样推断');
    assert.match(mapped.testResult.note, /不匹配日志中的 PASS 字样/);

    const unmapped = monitor.detail(J(6)).value.delivery;
    assert.equal(unmapped.configured, false);
    assert.equal(unmapped.label, '未配置交付目录');

    const noMap = makeMonitor(fixture, { workspaceMap: {} }).detail(J(2)).value.delivery;
    assert.equal(noMap.configured, false);
    assert.match(noMap.note, /未配置交付目录/);
  } finally {
    rmTree(fixture.root);
  }
});

test('损坏记录：详情明确报错，非法/未知 jobId 被区分', () => {
  const fixture = buildFixture();
  try {
    const monitor = makeMonitor(fixture);
    const corrupt = monitor.detail(J(5));
    assert.equal(corrupt.ok, true);
    assert.equal(corrupt.value.job, null);
    assert.equal(corrupt.value.recordError.code, 'INVALID_JSON');
    assert.equal(JSON.stringify(corrupt.value).includes(FAKE_SECRET), false);

    const invalid = monitor.detail('../../etc/passwd');
    assert.equal(invalid.ok, false);
    assert.equal(invalid.httpStatus, 400);

    const unknown = monitor.detail(J(99));
    assert.equal(unknown.ok, false);
    assert.equal(unknown.httpStatus, 404);
  } finally {
    rmTree(fixture.root);
  }
});

test('枚举失败时不谎称“没有作业”', () => {
  const fixture = buildFixture();
  try {
    fs.rmSync(path.join(fixture.root, 'jobs'), { recursive: true, force: true });
    const monitor = makeMonitor(fixture);
    const list = monitor.list();
    assert.equal(list.counts.totalJobDirectories, 0);
    assert.equal(list.jobs.length, 0);
    assert.equal(list.source.jobsDirExists, false);
    const detail = monitor.detail(J(1));
    assert.equal(detail.ok, false);
    assert.equal(detail.httpStatus, 404);
  } finally {
    rmTree(fixture.root);
  }
});

test('所有接口输出都不含禁止字段与假凭据', () => {
  const fixture = buildFixture();
  try {
    const monitor = makeMonitor(fixture);
    const payloads = [monitor.list(), monitor.meta()];
    for (const jobId of [J(1), J(2), J(3), J(4), J(5), J(6)]) {
      payloads.push(monitor.detail(jobId).value ?? monitor.detail(jobId));
    }
    const strings = collectStrings(payloads).join('\n');
    for (const marker of [FAKE_SECRET, FAKE_BEARER, FAKE_TASK_BODY, 'task.accepted.md', 'stdoutLog', 'stderrLog', 'errorMessage', 'requestHash', 'childIdentity']) {
      assert.equal(strings.includes(marker), false, `输出不应包含 ${marker}`);
    }
  } finally {
    rmTree(fixture.root);
  }
});

test('只读：读取前后夹具内容哈希与 mtime 完全一致', () => {
  const fixture = buildFixture();
  try {
    const before = snapshotTree(fixture.root);
    const monitor = makeMonitor(fixture);
    monitor.meta();
    monitor.list();
    for (const jobId of [J(1), J(2), J(3), J(4), J(5), J(6)]) monitor.detail(jobId);
    monitor.detail(J(1));
    const after = snapshotTree(fixture.root);
    assert.equal(after.digest, before.digest, '只读采样不得修改夹具任何文件内容或 mtime');
  } finally {
    rmTree(fixture.root);
  }
});

test('meta：owner 心跳、账本与限额都能读到', () => {
  const fixture = buildFixture();
  try {
    const meta = makeMonitor(fixture).meta();
    assert.equal(meta.readOnly, true);
    assert.equal(meta.owner.present, true);
    assert.equal(meta.owner.stale, false);
    assert.ok(meta.owner.heartbeatAgeMs >= 1500);
    assert.equal(meta.acceptanceLedger.configured, true);
    assert.equal(meta.acceptanceLedger.readable, true);
    assert.equal(meta.acceptanceLedger.entryCount, 3);
    assert.equal(meta.workspaceMap.configured, true);
    assert.equal(meta.limits.maxJobs >= 1, true);

    const stale = makeMonitor(fixture, { staleHeartbeatMs: 1000 }).meta();
    assert.equal(stale.owner.stale, true);
  } finally {
    rmTree(fixture.root);
  }
});

test('列表上限会截断并给出说明', () => {
  const fixture = buildFixture();
  try {
    const monitor = makeMonitor(fixture, { limits: { maxJobs: 2, maxJobJsonBytes: 262144, maxLedgerBytes: 524288, maxOwnerBytes: 65536, maxScanEntries: 300, maxScanDepth: 4, maxRecentFiles: 12, maxReportCandidates: 8, maxStaticBytes: 524288 } });
    const list = monitor.list();
    assert.equal(list.jobs.length, 2);
    assert.equal(list.counts.truncated, true);
    assert.ok(list.notes.some((note) => note.includes('上限')));
  } finally {
    rmTree(fixture.root);
  }
});
