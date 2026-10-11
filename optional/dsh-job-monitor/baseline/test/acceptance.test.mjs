import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createAcceptanceReader, acceptanceFor } from '../src/acceptance.mjs';
import { makeTempRoot, rmTree } from './helpers/fixture.mjs';

const SECRET = 'sk-LEDGER-NOTE-MUST-NOT-LEAK';

function writeLedger(root, value) {
  const file = path.join(root, 'acceptance-ledger.json');
  fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return file;
}

test('账本：pass / fail / pending 与缺失条目', () => {
  const root = makeTempRoot();
  try {
    const file = writeLedger(root, {
      schema: 'dsh-monitor/acceptance-ledger/v1',
      updatedAt: '2026-10-10',
      jobs: {
        'job-aaaa000000000001': { status: 'pass', reviewedAt: '2026-10-09' },
        'job-aaaa000000000002': { status: 'FAIL', reviewedAt: '2026-10-10', note: SECRET },
        'job-aaaa000000000003': { status: 'pending' },
      },
    });
    const reader = createAcceptanceReader({ path: file });
    const read = reader.read();
    assert.equal(read.readable, true);
    assert.equal(read.entryCount, 3);
    assert.equal(read.updatedAt, '2026-10-10');

    assert.equal(acceptanceFor(read, 'job-aaaa000000000001').status, 'pass');
    assert.equal(acceptanceFor(read, 'job-aaaa000000000001').reviewedAt, '2026-10-09');
    assert.equal(acceptanceFor(read, 'job-aaaa000000000002').status, 'fail');
    assert.equal(acceptanceFor(read, 'job-aaaa000000000003').status, 'pending');
    assert.equal(acceptanceFor(read, 'job-aaaa000000000003').reviewedAt, null);
    assert.equal(acceptanceFor(read, 'job-aaaa000000000099').status, 'none');
    assert.equal(JSON.stringify([...read.byJobId.entries()]).includes(SECRET), false, '备注原文不得进入结果');
  } finally {
    rmTree(root);
  }
});

test('账本：未配置 / 缺失 / 坏 JSON / 形状错误都退化为“未提供验收记录”', () => {
  const root = makeTempRoot();
  try {
    const unconfigured = createAcceptanceReader({ path: null });
    const noneRead = unconfigured.read();
    assert.equal(noneRead.configured, false);
    assert.equal(noneRead.readable, false);
    assert.equal(acceptanceFor(noneRead, 'job-aaaa000000000001').status, 'none');

    const missing = createAcceptanceReader({ path: path.join(root, 'nope.json') }).read();
    assert.equal(missing.readable, false);
    assert.equal(missing.errorCode, 'ENOENT');
    assert.equal(acceptanceFor(missing, 'job-aaaa000000000001').status, 'none');

    const brokenFile = writeLedger(root, `{"jobs": {"job-aaaa000000000001": {"status":"pass"}}, "note":"${SECRET}"`);
    const broken = createAcceptanceReader({ path: brokenFile }).read();
    assert.equal(broken.readable, false);
    assert.equal(broken.errorCode, 'INVALID_JSON');
    assert.equal(JSON.stringify(broken).includes(SECRET), false);

    const wrongShapeFile = writeLedger(root, { updatedAt: '2026-10-10', jobs: [] });
    const wrongShape = createAcceptanceReader({ path: wrongShapeFile }).read();
    assert.equal(wrongShape.errorCode, 'LEDGER_SHAPE_INVALID');
  } finally {
    rmTree(root);
  }
});

test('账本：非法状态与非法键被忽略且计数', () => {
  const root = makeTempRoot();
  try {
    const file = writeLedger(root, {
      updatedAt: '2026-10-10',
      jobs: {
        'job-aaaa000000000001': { status: 'maybe' },
        'job-aaaa000000000002': 'pass',
        '../../etc/passwd': { status: 'pass' },
        'job-AAAA000000000003': { status: 'pass', reviewedAt: 'not-a-date' },
      },
    });
    const read = createAcceptanceReader({ path: file }).read();
    assert.equal(read.readable, true);
    assert.equal(read.entryCount, 1);
    assert.equal(read.invalidEntries, 2);
    assert.equal(read.ignoredKeys, 1);
    assert.equal(read.byJobId.get('job-AAAA000000000003').reviewedAt, null);
  } finally {
    rmTree(root);
  }
});

test('账本：超过读取上限时拒绝读取且不加载内容', () => {
  const root = makeTempRoot();
  try {
    const file = writeLedger(root, { jobs: { 'job-aaaa000000000001': { status: 'pass' } } });
    const read = createAcceptanceReader({ path: file, maxBytes: 10 }).read();
    assert.equal(read.readable, false);
    assert.equal(read.errorCode, 'TOO_LARGE');
  } finally {
    rmTree(root);
  }
});
