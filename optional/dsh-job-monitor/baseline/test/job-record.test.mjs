import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { extractJobRecord } from '../src/jobRecord.mjs';
import { readJsonBounded, parseJsonBounded } from '../src/jsonRead.mjs';
import { makeTempRoot, makeJobRecord, writeJob, collectStrings, rmTree, FAKE_SECRET, FAKE_BEARER, FAKE_TASK_BODY } from './helpers/fixture.mjs';

const FORBIDDEN_KEYS = [
  'requestId',
  'requestHash',
  'taskFileOriginal',
  'taskFileAccepted',
  'taskFileSha256',
  'command',
  'errorMessage',
  'workspaceDir',
  'stdoutLog',
  'stderrLog',
  'pid',
  'ownerPid',
  'ownerLockId',
  'childIdentity',
  'audit',
  'promptKind',
];

test('白名单抽取：只保留约定字段，禁止字段完全不出现', () => {
  const record = makeJobRecord('job-1111111111111111', {
    status: 'timed_out',
    exitCode: null,
    errorCode: 'CLEANUP_UNCONFIRMED',
    timedOut: true,
    truncated: { stdout: true, stderr: false },
    bytes: { stdout: 100, stderr: 20 },
  });
  const result = extractJobRecord(record, 'job-1111111111111111');
  assert.equal(result.ok, true);
  const keys = Object.keys(result.job);
  for (const forbidden of FORBIDDEN_KEYS) {
    assert.equal(keys.includes(forbidden), false, `输出不应包含 ${forbidden}`);
  }
  assert.deepEqual(keys.sort(), [
    'bytes',
    'cancelRequested',
    'cleanup',
    'createdAt',
    'endedAt',
    'errorCode',
    'exitCode',
    'jobId',
    'mode',
    'rawBytes',
    'recovered',
    'signal',
    'startedAt',
    'status',
    'timedOut',
    'timeoutSeconds',
    'truncated',
    'workspaceId',
  ]);
  const all = collectStrings(result.job).join('\n');
  assert.equal(all.includes(FAKE_SECRET), false);
  assert.equal(all.includes(FAKE_BEARER), false);
  assert.equal(all.includes(FAKE_TASK_BODY), false);
  assert.equal(result.job.errorCode, 'CLEANUP_UNCONFIRMED');
  assert.equal(result.warnings.length, 0);
});

test('jobId 与目录不一致 -> 拒绝', () => {
  const record = makeJobRecord('job-1111111111111111');
  const result = extractJobRecord(record, 'job-2222222222222222');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'JOB_ID_MISMATCH');
});

test('未知状态与非法字段：降级但保留记录，并给出警告', () => {
  const record = makeJobRecord('job-1111111111111111', {
    status: 'warming_up',
    mode: 'teleport',
    workspaceId: 42,
    exitCode: 'zero',
    errorCode: 'contains a space and text',
    timeoutSeconds: -5,
  });
  const result = extractJobRecord(record, 'job-1111111111111111');
  assert.equal(result.ok, true);
  assert.equal(result.job.status, 'unknown');
  assert.equal(result.job.mode, 'unknown');
  assert.equal(result.job.workspaceId, null);
  assert.equal(result.job.exitCode, null);
  assert.equal(result.job.errorCode, null);
  assert.equal(result.job.timeoutSeconds, null);
  assert.ok(result.warnings.length >= 4);
  const all = collectStrings(result).join('\n');
  assert.equal(all.includes('contains a space'), false, '非法 errorCode 原文不得回显');
});

test('非对象 / 缺 createdAt -> 不可信记录', () => {
  assert.equal(extractJobRecord(null, 'job-1111111111111111').code, 'NOT_OBJECT');
  assert.equal(extractJobRecord([], 'job-1111111111111111').code, 'NOT_OBJECT');
  const record = makeJobRecord('job-1111111111111111');
  delete record.createdAt;
  assert.equal(extractJobRecord(record, 'job-1111111111111111').code, 'CREATED_AT_INVALID');
});

test('readJsonBounded：坏 JSON 只返回代码，不回显片段', () => {
  const root = makeTempRoot();
  try {
    const file = path.join(root, 'broken.json');
    fs.writeFileSync(file, `{ "a": "${FAKE_SECRET}", `, 'utf8');
    const read = readJsonBounded(file, 1024);
    assert.equal(read.ok, false);
    assert.equal(read.code, 'INVALID_JSON');
    assert.equal(JSON.stringify(read).includes(FAKE_SECRET), false);

    const big = path.join(root, 'big.json');
    fs.writeFileSync(big, `{"pad":"${'x'.repeat(4096)}"}`, 'utf8');
    const tooLarge = readJsonBounded(big, 128);
    assert.equal(tooLarge.ok, false);
    assert.equal(tooLarge.code, 'TOO_LARGE');

    assert.equal(readJsonBounded(path.join(root, 'nope.json'), 128).code, 'ENOENT');

    const asString = parseJsonBounded(`{"x":"${FAKE_SECRET}"`, 1024);
    assert.equal(asString.ok, false);
    assert.equal(asString.code, 'INVALID_JSON');
    assert.equal(JSON.stringify(asString).includes(FAKE_SECRET), false);
  } finally {
    rmTree(root);
  }
});

test('磁盘上的 job.json 经读取后仍是同一套白名单结果', () => {
  const root = makeTempRoot();
  try {
    const record = makeJobRecord('job-3333333333333333', { status: 'completed', endedAt: new Date().toISOString(), exitCode: 0 });
    writeJob(root, 'job-3333333333333333', record, { stdout: FAKE_BEARER, stderr: FAKE_SECRET });
    const read = readJsonBounded(path.join(root, 'jobs', 'job-3333333333333333', 'job.json'), 65536);
    assert.equal(read.ok, true);
    const result = extractJobRecord(read.value, 'job-3333333333333333');
    assert.equal(result.ok, true);
    assert.equal(result.job.status, 'completed');
    assert.equal(JSON.stringify(result.job).includes(FAKE_SECRET), false);
  } finally {
    rmTree(root);
  }
});
