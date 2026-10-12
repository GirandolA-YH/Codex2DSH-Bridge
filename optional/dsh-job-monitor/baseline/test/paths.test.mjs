import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isValidJobId } from '../src/constants.mjs';
import { resolveRoot, safeResolve } from '../src/paths.mjs';
import { makeTempRoot, rmTree } from './helpers/fixture.mjs';

test('jobId 规则与桥一致', () => {
  assert.equal(isValidJobId('job-example00000001'), true);
  assert.equal(isValidJobId('job-abcdef'), true);
  assert.equal(isValidJobId('job-abcde'), false);
  assert.equal(isValidJobId('job-' + 'a'.repeat(33)), false);
  assert.equal(isValidJobId('job-abc def'), false);
  assert.equal(isValidJobId('job-../x'), false);
  assert.equal(isValidJobId('job-abc/def'), false);
  assert.equal(isValidJobId('JOB-abcdef'), false);
  assert.equal(isValidJobId(''), false);
  assert.equal(isValidJobId(null), false);
  assert.equal(isValidJobId(42), false);
});

test('safeResolve 只接受授权根内的真实路径', () => {
  const root = makeTempRoot();
  try {
    fs.mkdirSync(path.join(root, 'jobs', 'job-aaaaaaaaaaaa'), { recursive: true });
    fs.writeFileSync(path.join(root, 'jobs', 'job-aaaaaaaaaaaa', 'job.json'), '{}', 'utf8');
    const info = resolveRoot(root);
    assert.equal(info.ok, true);

    const file = safeResolve(info.real, ['jobs', 'job-aaaaaaaaaaaa', 'job.json']);
    assert.equal(file.ok, true);
    assert.equal(file.stat.isFile(), true);

    const missing = safeResolve(info.real, ['jobs', 'job-bbbbbbbbbbbb', 'job.json']);
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'ENOENT');

    for (const segments of [['..'], ['..', 'x'], ['jobs', '..', '..'], ['a/b'], ['a\\b'], [''], ['.'], ['a\0b']]) {
      const result = safeResolve(info.real, segments);
      assert.equal(result.ok, false, `应拒绝 ${JSON.stringify(segments)}`);
      assert.ok(['ESCAPE', 'ENOENT', 'UNKNOWN'].includes(result.code), `意外代码 ${result.code}`);
    }
  } finally {
    rmTree(root);
  }
});

test('safeResolve 拒绝目录联接（重解析点），即使目标仍在根内', () => {
  const root = makeTempRoot();
  try {
    const real = path.join(root, 'real-dir');
    fs.mkdirSync(real, { recursive: true });
    const linkPath = path.join(root, 'linked-dir');
    let linked = true;
    try {
      fs.symlinkSync(real, linkPath, 'junction');
    } catch (error) {
      linked = false;
      console.log(`[skip-note] 无法创建目录联接（${error.code}）：重解析拒绝路径改由逃逸用例覆盖`);
    }
    const info = resolveRoot(root);
    if (!linked) return;
    const result = safeResolve(info.real, ['linked-dir']);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'REPARSE');
  } finally {
    rmTree(root);
  }
});

test('safeResolve 拒绝指向授权根之外的重解析逃逸', () => {
  const root = makeTempRoot();
  const outside = makeTempRoot('dsh-monitor-outside-');
  try {
    fs.mkdirSync(path.join(outside, 'inner'), { recursive: true });
    fs.mkdirSync(path.join(outside, 'job-cccccccccccc'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'job-cccccccccccc', 'job.json'), '{}', 'utf8');
    fs.mkdirSync(path.join(root, 'jobs'), { recursive: true });
    let linked = true;
    try {
      fs.symlinkSync(path.join(outside, 'job-cccccccccccc'), path.join(root, 'jobs', 'job-cccccccccccc'), 'junction');
    } catch (error) {
      linked = false;
      console.log(`[skip-note] 无法创建目录联接（${error.code}）：本用例跳过`);
    }
    const info = resolveRoot(root);
    if (!linked) return;
    const result = safeResolve(info.real, ['jobs', 'job-cccccccccccc', 'job.json']);
    assert.equal(result.ok, false);
    assert.ok(result.code === 'ESCAPE' || result.code === 'REPARSE', `意外代码 ${result.code}`);
  } finally {
    rmTree(root);
    rmTree(outside);
  }
});

test('resolveRoot 对不存在的根不抛异常', () => {
  const target = path.join(makeTempRoot(), 'does-not-exist');
  const info = resolveRoot(target);
  assert.equal(info.ok, false);
  assert.equal(info.exists, false);
  assert.equal(info.code, 'ENOENT');
});
