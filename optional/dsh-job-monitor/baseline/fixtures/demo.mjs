/**
 * 演示夹具（仅用于 --demo 与离线自测；绝不进入真实只读模式）。
 *
 * 夹具刻意包含真实桥不会缺少的“禁止字段”：requestId / command / errorMessage /
 * workspaceDir / stdoutLog / taskFileOriginal，以及日志里的假凭据。这样任何一次
 * 演示或测试都能直接证明：白名单之外的内容不会出现在 API 或页面里。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE_SECRET = 'sk-DEMO-NOT-A-REAL-KEY-000000000000';
const FAKE_BEARER = 'Authorization: Bearer sk-DEMO-LOG-SECRET-000000';
const FAKE_TASK_BODY = '这是任务正文占位符：DO-NOT-LEAK-TASK-BODY';
const LOCK_ID = 'demolock0000000000000001';

function iso(ms) {
  return new Date(ms).toISOString();
}

function writeJob(root, jobId, record, logText) {
  const dir = path.join(root, 'jobs', jobId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'job.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  if (logText !== undefined) {
    fs.writeFileSync(path.join(dir, 'stdout.log'), logText.stdout, 'utf8');
    fs.writeFileSync(path.join(dir, 'stderr.log'), logText.stderr, 'utf8');
  }
  return dir;
}

function baseRecord(jobId, overrides) {
  return {
    jobId,
    requestId: `demo-${jobId}`,
    requestHash: 'a'.repeat(64),
    workspaceId: 'demo-workspace',
    workspaceDir: path.join(path.dirname(fileURLToPath(import.meta.url)), 'demo-workspace'),
    mode: 'implement',
    taskFileOriginal: 'E:\\secret\\path\\task-with-' + FAKE_TASK_BODY + '.md',
    taskFileAccepted: 'E:\\secret\\path\\task.accepted.md',
    taskFileSha256: 'b'.repeat(64),
    taskFileBytes: 1234,
    promptKind: 'pointer',
    taskArgChars: 100,
    taskArgSha256: 'c'.repeat(64),
    runnerType: 'production',
    command: ['DeepSeek Harness.exe', '--api-key', FAKE_SECRET],
    status: 'running',
    createdAt: iso(Date.now()),
    startedAt: null,
    endedAt: null,
    pid: 4242,
    childIdentity: { pid: 4242, creationTimeMs: 1, executablePath: 'E:\\secret\\app.exe', commandLineDigest: 'd'.repeat(64) },
    exitCode: null,
    signal: null,
    timedOut: false,
    cancelRequested: false,
    errorCode: null,
    errorMessage: FAKE_BEARER,
    truncated: { stdout: false, stderr: false },
    bytes: { stdout: 0, stderr: 0 },
    rawBytes: { stdout: 0, stderr: 0 },
    stdoutLog: 'E:\\secret\\stdout.log',
    stderrLog: 'E:\\secret\\stderr.log',
    timeoutSeconds: 1200,
    ownerPid: 999,
    ownerLockId: LOCK_ID,
    ownerStartedAt: iso(Date.now()),
    recovered: false,
    cleanup: null,
    lateExit: null,
    audit: null,
    ...overrides,
  };
}

/**
 * @param {string} root 目标目录（会被创建；调用者负责清理）
 * @param {{now?: number}} [options]
 */
export function materializeDemoState(root, options = {}) {
  const now = typeof options.now === 'number' ? options.now : Date.now();
  fs.mkdirSync(path.join(root, 'jobs'), { recursive: true });

  const workspaceDir = path.join(root, 'workspace');
  fs.mkdirSync(path.join(workspaceDir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, 'test'), { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, 'reports'), { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, 'node_modules', 'left-pad'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, 'README.md'), '# 演示工作目录\n', 'utf8');
  fs.writeFileSync(path.join(workspaceDir, 'src', 'monitor.mjs'), `// demo\n// ${FAKE_SECRET}\n`, 'utf8');
  fs.writeFileSync(path.join(workspaceDir, 'test', 'monitor.test.mjs'), '// demo test\n', 'utf8');
  fs.writeFileSync(path.join(workspaceDir, 'reports', 'M01-IMPLEMENTATION-REPORT.md'), '# 演示报告\n', 'utf8');
  fs.writeFileSync(path.join(workspaceDir, 'run.log'), `${FAKE_BEARER}\n`, 'utf8');

  const mtime = (offsetMs) => new Date(now - offsetMs);

  // 1) 运行中：日志持续增长，时限 1200 秒。
  const runningStart = now - (4 * 60 + 35) * 1000;
  writeJob(
    root,
    'job-demo000000000001',
    baseRecord('job-demo000000000001', {
      status: 'running',
      createdAt: iso(runningStart - 5000),
      startedAt: iso(runningStart),
      bytes: { stdout: 18432, stderr: 2048 },
      rawBytes: { stdout: 18432, stderr: 2048 },
      timeoutSeconds: 1200,
    }),
    {
      stdout: `演示 stdout 占位内容\n${FAKE_BEARER}\n${FAKE_TASK_BODY}\n`,
      stderr: `演示 stderr 占位内容\n${FAKE_SECRET}\n`,
    },
  );
  const runningDir = path.join(root, 'jobs', 'job-demo000000000001');
  fs.utimesSync(path.join(runningDir, 'stdout.log'), mtime(8000), mtime(8000));
  fs.utimesSync(path.join(runningDir, 'stderr.log'), mtime(120000), mtime(120000));

  // 2) 正常结束（exit 0）+ 验收通过。
  const completedStart = now - 25 * 60 * 1000;
  const completedEnd = now - 11 * 60 * 1000;
  writeJob(
    root,
    'job-demo000000000002',
    baseRecord('job-demo000000000002', {
      mode: 'fix',
      status: 'completed',
      createdAt: iso(completedStart - 3000),
      startedAt: iso(completedStart),
      endedAt: iso(completedEnd),
      exitCode: 0,
      bytes: { stdout: 65536, stderr: 0 },
      rawBytes: { stdout: 65536, stderr: 0 },
      truncated: { stdout: true, stderr: false },
      timeoutSeconds: 1200,
      cleanup: { reason: 'shutdown', requestedAt: iso(completedEnd), attempts: 1, lastAttemptAt: iso(completedEnd), method: 'none', killed: false, exited: true, detail: null, confirmed: true, confirmedAt: iso(completedEnd), error: null },
    }),
    { stdout: `演示 stdout\n${FAKE_TASK_BODY}\n`, stderr: '' },
  );
  fs.utimesSync(path.join(root, 'jobs', 'job-demo000000000002', 'stdout.log'), mtime(11 * 60 * 1000), mtime(11 * 60 * 1000));
  fs.utimesSync(path.join(root, 'jobs', 'job-demo000000000002', 'stderr.log'), mtime(11 * 60 * 1000), mtime(11 * 60 * 1000));

  // 3) 超时 + 验收未通过 + 停止未确认。
  const timeoutStart = now - 40 * 60 * 1000;
  const timeoutEnd = now - 20 * 60 * 1000;
  writeJob(
    root,
    'job-demo000000000003',
    baseRecord('job-demo000000000003', {
      mode: 'audit',
      status: 'timed_out',
      createdAt: iso(timeoutStart - 2000),
      startedAt: iso(timeoutStart),
      endedAt: iso(timeoutEnd),
      exitCode: null,
      signal: 'SIGKILL',
      timedOut: true,
      errorCode: 'CLEANUP_UNCONFIRMED',
      errorMessage: `超时详情 ${FAKE_BEARER}`,
      bytes: { stdout: 5242880, stderr: 1024 },
      rawBytes: { stdout: 5242880, stderr: 1024 },
      truncated: { stdout: true, stderr: false },
      timeoutSeconds: 1200,
      cleanup: { reason: 'timeout', requestedAt: iso(timeoutEnd), attempts: 2, lastAttemptAt: iso(timeoutEnd), method: 'taskkill', killed: true, exited: null, detail: FAKE_BEARER, confirmed: false, confirmedAt: null, error: FAKE_SECRET },
    }),
    { stdout: `演示 stdout\n${FAKE_TASK_BODY}\n`, stderr: `演示 stderr\n${FAKE_BEARER}\n` },
  );

  // 4) 失败且账本中没有条目 -> 未提供验收记录。
  writeJob(
    root,
    'job-demo000000000004',
    baseRecord('job-demo000000000004', {
      mode: 'implement',
      status: 'failed',
      createdAt: iso(now - 90 * 60 * 1000),
      startedAt: iso(now - 90 * 60 * 1000 + 1500),
      endedAt: iso(now - 89 * 60 * 1000),
      exitCode: 1,
      errorCode: 'SPAWN_FAILED',
      errorMessage: `启动失败 ${FAKE_SECRET}`,
      bytes: { stdout: 0, stderr: 0 },
      rawBytes: { stdout: 0, stderr: 0 },
    }),
    { stdout: '', stderr: `${FAKE_BEARER}\n` },
  );

  // 5) 损坏记录：jobId 与目录不一致 + 非法 JSON 里含假凭据。
  const corruptDir = path.join(root, 'jobs', 'job-demo000000000005');
  fs.mkdirSync(corruptDir, { recursive: true });
  fs.writeFileSync(
    path.join(corruptDir, 'job.json'),
    `{ "jobId": "job-demo000000000005", "status": "running", "leak": "${FAKE_SECRET}",\n`,
    'utf8',
  );

  // 6) 未知状态：字段可解析但状态不在桥的枚举里。
  writeJob(
    root,
    'job-demo000000000006',
    baseRecord('job-demo000000000006', {
      status: 'warming_up',
      createdAt: iso(now - 5 * 60 * 1000),
      startedAt: iso(now - 5 * 60 * 1000),
      bytes: { stdout: 100, stderr: 0 },
      rawBytes: { stdout: 100, stderr: 0 },
    }),
    { stdout: `演示 stdout\n${FAKE_TASK_BODY}\n`, stderr: '' },
  );

  // owner.lock + 心跳
  fs.writeFileSync(
    path.join(root, 'owner.lock'),
    `${JSON.stringify(
      {
        schema: 'dsh-codex-bridge/owner-lock/v1',
        lockId: LOCK_ID,
        pid: 4242,
        hostname: 'DEMO-HOST',
        startedAt: iso(now - 60 * 60 * 1000),
        heartbeatAt: iso(now - 4000),
        bridgeVersion: '0.1.0',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(root, `owner.heartbeat.${LOCK_ID}`),
    `${JSON.stringify(
      { schema: 'dsh-codex-bridge/owner-heartbeat/v1', lockId: LOCK_ID, pid: 4242, heartbeatAt: iso(now - 4000) },
      null,
      2,
    )}\n`,
    'utf8',
  );

  // 独立验收账本（含原始备注，用于验证备注不会出现在页面/接口）。
  const ledgerPath = path.join(root, 'acceptance-ledger.json');
  fs.writeFileSync(
    ledgerPath,
    `${JSON.stringify(
      {
        schema: 'dsh-monitor/acceptance-ledger/v1',
        updatedAt: iso(now).slice(0, 10),
        jobs: {
          'job-demo000000000001': { status: 'pending', reviewedAt: iso(now).slice(0, 10) },
          'job-demo000000000002': { status: 'pass', reviewedAt: iso(now).slice(0, 10), note: `通过，但备注含 ${FAKE_SECRET}` },
          'job-demo000000000003': { status: 'fail', reviewedAt: iso(now).slice(0, 10), reviewerPath: 'E:\\secret\\review.md' },
          'not-a-job': { status: 'pass', note: FAKE_SECRET },
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  fs.writeFileSync(
    path.join(root, 'README.md'),
    [
      '# 演示夹具（演示数据）',
      '',
      '本目录由 `fixtures/demo.mjs` 生成，只用于 `node server.mjs --demo` 与离线测试。',
      '它**不是**桥的真实状态目录，也不包含任何真实凭据：其中出现的字符串都是占位符。',
      '',
      `- 假凭据占位：\`${FAKE_SECRET}\``,
      `- 假请求头占位：\`${FAKE_BEARER}\``,
      `- 任务正文占位：\`${FAKE_TASK_BODY}\``,
      '',
      '这些字符串的存在是为了证明白名单之外的字段与日志原文永远不会出现在 API/HTML 中。',
      '',
    ].join('\n'),
    'utf8',
  );

  return { root, ledgerPath, workspaceDir, lockId: LOCK_ID };
}

export const DEMO_MARKERS = Object.freeze({
  secret: FAKE_SECRET,
  bearer: FAKE_BEARER,
  taskBody: FAKE_TASK_BODY,
  lockId: LOCK_ID,
});
