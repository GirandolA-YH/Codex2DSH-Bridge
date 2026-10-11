import test from 'node:test';
import assert from 'node:assert/strict';
import { buildActivity } from '../src/activity.mjs';

const JOB = { bytes: { stdout: 100, stderr: 40 }, truncated: { stdout: false, stderr: true } };

function stats(stdout, stderr) {
  return {
    stdout: stdout === null ? { exists: false, code: 'ENOENT' } : { exists: true, sizeBytes: stdout.size, mtimeMs: stdout.mtime },
    stderr: stderr === null ? { exists: false, code: 'ENOENT' } : { exists: true, sizeBytes: stderr.size, mtimeMs: stderr.mtime },
  };
}

test('首次采样只建立基线，不宣称“暂无新活动”', () => {
  const result = buildActivity({
    job: JOB,
    stats: stats({ size: 100, mtime: 1000 }, { size: 40, mtime: 900 }),
    previous: null,
    nowMs: 10000,
  });
  assert.equal(result.value.firstSample, true);
  assert.equal(result.value.noNewActivity, false);
  assert.equal(result.value.streams.stdout.deltaBytes, null);
  assert.match(result.value.note, /首次采样/);
});

test('日志增长产生正增量；静默只表示文件未变化', () => {
  const first = buildActivity({
    job: JOB,
    stats: stats({ size: 100, mtime: 1000 }, { size: 40, mtime: 900 }),
    previous: null,
    nowMs: 10000,
  });
  const grew = buildActivity({
    job: JOB,
    stats: stats({ size: 250, mtime: 5000 }, { size: 40, mtime: 900 }),
    previous: first.snapshot,
    nowMs: 15000,
  });
  assert.equal(grew.value.streams.stdout.deltaBytes, 150);
  assert.equal(grew.value.streams.stderr.deltaBytes, 0);
  assert.equal(grew.value.noNewActivity, false);
  assert.equal(grew.value.streams.stdout.recordedMismatch, true, 'job.json 记录 100 != 实际 250');

  const silent = buildActivity({
    job: JOB,
    stats: stats({ size: 250, mtime: 5000 }, { size: 40, mtime: 900 }),
    previous: grew.snapshot,
    nowMs: 20000,
  });
  assert.equal(silent.value.noNewActivity, true);
  assert.match(silent.value.note, /暂无新活动/);
  assert.match(silent.value.note, /不代表卡死/);
  assert.equal(/失败|已退出|卡死(?!、)/.test(silent.value.note.replace('不代表卡死、失败或进程已退出', '')), false);
});

test('修改时间变化但大小不变 -> 不算“暂无新活动”', () => {
  const first = buildActivity({
    job: JOB,
    stats: stats({ size: 100, mtime: 1000 }, { size: 40, mtime: 900 }),
    previous: null,
    nowMs: 10000,
  });
  const touched = buildActivity({
    job: JOB,
    stats: stats({ size: 100, mtime: 1234 }, { size: 40, mtime: 900 }),
    previous: first.snapshot,
    nowMs: 15000,
  });
  assert.equal(touched.value.streams.stdout.deltaBytes, 0);
  assert.equal(touched.value.streams.stdout.mtimeChanged, true);
  assert.equal(touched.value.noNewActivity, false);
});

test('日志文件缺失/出现/消失都有明确语义', () => {
  const both = buildActivity({
    job: JOB,
    stats: stats(null, null),
    previous: null,
    nowMs: 1000,
  });
  assert.equal(both.value.anyLogFileExists, false);
  assert.match(both.value.note, /未找到日志文件/);

  const appeared = buildActivity({
    job: JOB,
    stats: stats({ size: 10, mtime: 5000 }, null),
    previous: both.snapshot,
    nowMs: 2000,
  });
  assert.equal(appeared.value.streams.stdout.appeared, true);
  assert.equal(appeared.value.streams.stdout.deltaBytes, 10);

  const disappeared = buildActivity({
    job: JOB,
    stats: stats(null, null),
    previous: appeared.snapshot,
    nowMs: 3000,
  });
  assert.equal(disappeared.value.streams.stdout.disappeared, true);
  assert.equal(disappeared.value.noNewActivity, false);
});

test('活动结果里不含任何日志内容字段', () => {
  const result = buildActivity({
    job: JOB,
    stats: stats({ size: 100, mtime: 1000 }, { size: 40, mtime: 900 }),
    previous: null,
    nowMs: 10000,
  });
  const keys = Object.keys(result.value.streams.stdout);
  for (const forbidden of ['text', 'content', 'tail', 'head', 'firstLines', 'lines']) {
    assert.equal(keys.includes(forbidden), false);
  }
  assert.equal(result.value.streams.stderr.truncated, true);
});
