/** 测试夹具工具：临时目录、作业写入、只读校验用的目录快照。 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const FAKE_SECRET = 'sk-DEMO-NOT-A-REAL-KEY-000000000000';
export const FAKE_BEARER = 'Authorization: Bearer sk-DEMO-LOG-SECRET-000000';
export const FAKE_TASK_BODY = 'DO-NOT-LEAK-TASK-BODY-正文占位';

export function makeTempRoot(prefix = 'dsh-monitor-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function rmTree(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

export function writeOwner(root, { lockId = 'abcdef0123456789abcdef01', startedAt, heartbeatAt } = {}) {
  const now = Date.now();
  fs.writeFileSync(
    path.join(root, 'owner.lock'),
    `${JSON.stringify(
      {
        schema: 'dsh-codex-bridge/owner-lock/v1',
        lockId,
        pid: 1234,
        hostname: 'TEST-HOST',
        startedAt: new Date(startedAt ?? now - 60000).toISOString(),
        heartbeatAt: new Date(heartbeatAt ?? now).toISOString(),
        bridgeVersion: '0.1.0',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(root, `owner.heartbeat.${lockId}`),
    `${JSON.stringify(
      {
        schema: 'dsh-codex-bridge/owner-heartbeat/v1',
        lockId,
        pid: 1234,
        heartbeatAt: new Date(heartbeatAt ?? now).toISOString(),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

export function makeJobRecord(jobId, overrides = {}) {
  const now = Date.now();
  return {
    jobId,
    requestId: `test-${jobId}`,
    requestHash: 'f'.repeat(64),
    workspaceId: 'test-workspace',
    workspaceDir: 'E:\\should\\never\\be\\read',
    mode: 'implement',
    taskFileOriginal: `E:\\secret\\${FAKE_TASK_BODY}.md`,
    taskFileAccepted: 'E:\\secret\\task.accepted.md',
    taskFileSha256: 'a'.repeat(64),
    taskFileBytes: 10,
    promptKind: 'pointer',
    taskArgChars: 10,
    taskArgSha256: 'b'.repeat(64),
    runnerType: 'production',
    command: ['node', '--token', FAKE_SECRET],
    status: 'running',
    createdAt: new Date(now - 120000).toISOString(),
    startedAt: new Date(now - 60000).toISOString(),
    endedAt: null,
    pid: 4321,
    childIdentity: null,
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
    ownerLockId: 'abcdef0123456789abcdef01',
    ownerStartedAt: new Date(now - 120000).toISOString(),
    recovered: false,
    cleanup: null,
    lateExit: null,
    audit: null,
    ...overrides,
  };
}

export function writeJob(root, jobId, record, { stdout, stderr, utf8 = true } = {}) {
  const dir = path.join(root, 'jobs', jobId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'job.json'),
    `${JSON.stringify(record, null, 2)}\n`,
    'utf8',
  );
  if (stdout !== undefined) fs.writeFileSync(path.join(dir, 'stdout.log'), stdout, utf8 ? 'utf8' : undefined);
  if (stderr !== undefined) fs.writeFileSync(path.join(dir, 'stderr.log'), stderr, utf8 ? 'utf8' : undefined);
  return dir;
}

export function writeRawJobFile(root, jobId, rawText) {
  const dir = path.join(root, 'jobs', jobId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'job.json'), rawText, 'utf8');
  return dir;
}

/** 递归记录 (相对路径, 大小, mtimeMs, 内容 sha256)，用于证明只有读、没有写。 */
export function snapshotTree(root) {
  const entries = [];
  const walk = (base, rel) => {
    let items;
    try {
      items = fs.readdirSync(path.join(base, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
      const nextRel = rel === '' ? item.name : `${rel}/${item.name}`;
      const abs = path.join(base, nextRel);
      const stat = fs.lstatSync(abs);
      if (stat.isDirectory()) {
        entries.push({ path: nextRel, kind: 'dir', mtimeMs: Math.round(stat.mtimeMs) });
        walk(base, nextRel);
      } else {
        const content = fs.readFileSync(abs);
        entries.push({
          path: nextRel,
          kind: 'file',
          size: stat.size,
          mtimeMs: Math.round(stat.mtimeMs),
          sha256: crypto.createHash('sha256').update(content).digest('hex'),
        });
      }
    }
  };
  walk(root, '');
  const digest = crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  return { entries, digest };
}

/** 收集 JSON 中所有字符串，便于断言敏感文本没有出现在任何位置。 */
export function collectStrings(value, out = []) {
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return out;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      collectStrings(item, out);
    }
  }
  return out;
}
