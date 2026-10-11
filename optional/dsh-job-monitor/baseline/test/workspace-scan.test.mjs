import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { scanWorkspace } from '../src/workspaceScan.mjs';
import { makeTempRoot, rmTree, FAKE_SECRET } from './helpers/fixture.mjs';

test('扫描只报告相对路径与元数据，不读取文件内容', () => {
  const root = makeTempRoot();
  try {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.mjs'), `// ${FAKE_SECRET}\n`, 'utf8');
    fs.writeFileSync(path.join(root, 'reports', 'M01-REPORT.md'), `# ${FAKE_SECRET}\n`, 'utf8');
    fs.writeFileSync(path.join(root, 'README.md'), `# ${FAKE_SECRET}\n`, 'utf8');

    const scan = scanWorkspace(root, { now: Date.now() });
    assert.equal(scan.ok, true);
    assert.equal(scan.counts.files, 3);
    const serialized = JSON.stringify(scan);
    assert.equal(serialized.includes(FAKE_SECRET), false, '文件内容不得出现在扫描结果里');
    assert.equal(serialized.includes(root), false, '不返回绝对路径');
    const paths = scan.files.map((file) => file.path);
    assert.ok(paths.includes('src/a.mjs'));
    assert.ok(paths.includes('reports/M01-REPORT.md'));
    assert.ok(scan.reportCandidates.some((file) => file.path === 'reports/M01-REPORT.md'));
  } finally {
    rmTree(root);
  }
});

test('忽略 .git / node_modules / dist / state / .tmp / audits 与日志文件', () => {
  const root = makeTempRoot();
  try {
    for (const dir of ['.git', 'node_modules', 'dist', 'state', '.tmp', 'audits']) {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
      fs.writeFileSync(path.join(root, dir, 'file.txt'), 'x', 'utf8');
    }
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'run.log'), 'x', 'utf8');
    fs.writeFileSync(path.join(root, 'src', 'keep.mjs'), 'x', 'utf8');

    const scan = scanWorkspace(root, { now: Date.now() });
    assert.deepEqual(scan.files.map((file) => file.path), ['src/keep.mjs']);
    assert.ok(scan.counts.ignored >= 6);
  } finally {
    rmTree(root);
  }
});

test('扫描上限会触发截断并说明原因', () => {
  const root = makeTempRoot();
  try {
    fs.mkdirSync(path.join(root, 'many'), { recursive: true });
    for (let i = 0; i < 20; i += 1) {
      fs.writeFileSync(path.join(root, 'many', `f${String(i).padStart(2, '0')}.txt`), 'x', 'utf8');
    }
    const scan = scanWorkspace(root, { now: Date.now(), maxScanEntries: 5, maxRecentFiles: 3 });
    assert.equal(scan.truncated, true);
    assert.equal(scan.truncatedReason, '达到扫描条目上限');
    assert.ok(scan.counts.entriesVisited <= 5);
    assert.ok(scan.files.length <= 3);
  } finally {
    rmTree(root);
  }
});

test('深度上限：更深的目录只被计入忽略/截断，不会无限下钻', () => {
  const root = makeTempRoot();
  try {
    const deep = path.join(root, 'a', 'b', 'c', 'd');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'deep.txt'), 'x', 'utf8');
    fs.writeFileSync(path.join(root, 'top.txt'), 'x', 'utf8');
    const scan = scanWorkspace(root, { now: Date.now(), maxScanDepth: 2 });
    assert.deepEqual(scan.files.map((file) => file.path), ['top.txt']);
    assert.equal(scan.truncated, true);
    assert.equal(scan.truncatedReason, '达到目录深度上限');
  } finally {
    rmTree(root);
  }
});

test('目录联接不会被跟随', () => {
  const root = makeTempRoot();
  const outside = makeTempRoot('dsh-monitor-scan-outside-');
  try {
    fs.mkdirSync(path.join(root, 'inside'), { recursive: true });
    fs.writeFileSync(path.join(root, 'inside', 'ok.txt'), 'x', 'utf8');
    fs.writeFileSync(path.join(outside, 'hidden.txt'), 'x', 'utf8');
    let linked = true;
    try {
      fs.symlinkSync(outside, path.join(root, 'linked'), 'junction');
    } catch (error) {
      linked = false;
      console.log(`[skip-note] 无法创建目录联接（${error.code}）：本用例跳过`);
    }
    const scan = scanWorkspace(root, { now: Date.now() });
    assert.deepEqual(scan.files.map((file) => file.path), ['inside/ok.txt']);
    if (linked) assert.equal(scan.counts.rejectedReparse, 1);
  } finally {
    rmTree(root);
    rmTree(outside);
  }
});

test('目录不可读时返回稳定错误码而不是空结果', () => {
  const scan = scanWorkspace(path.join(makeTempRoot(), 'missing'), { now: Date.now() });
  assert.equal(scan.ok, false);
  assert.equal(scan.errorCode, 'ENOENT');
});
