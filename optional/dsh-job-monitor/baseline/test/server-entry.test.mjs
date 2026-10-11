import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildConfig } from '../src/config.mjs';
import { buildRealConfig, buildDemoConfig } from '../server.mjs';
import { createMonitor } from '../src/monitor.mjs';
import { DEFAULT_LIMITS } from '../src/constants.mjs';

test('入口必须把 host/port 原样传给监听器（回归：曾漏传导致绑定 0.0.0.0 与随机端口）', () => {
  const base = buildConfig(['--port', '4321', '--host', '127.0.0.1', '--state-root', 'E:/does-not-matter']);
  assert.equal(base.ok, true);
  const real = buildRealConfig(base.config);
  assert.equal(real.host, '127.0.0.1');
  assert.equal(real.port, 4321);
  assert.equal(real.demo, false);

  const demoBase = buildConfig(['--port', '4322', '--host', 'localhost', '--demo']);
  const demo = buildDemoConfig(demoBase.config);
  try {
    assert.equal(demo.host, '127.0.0.1', 'localhost 归一化为 127.0.0.1');
    assert.equal(demo.port, 4322);
    assert.equal(demo.demo, true);
    assert.ok(demo.stateRoot.toLowerCase().includes('dsh-monitor-demo-'));
    assert.equal(typeof demo.cleanup, 'function');
  } finally {
    if (demo.cleanup) demo.cleanup();
  }
});

test('演示模式自带的夹具可以被监控器完整读取，并标记为演示数据', () => {
  const base = buildConfig(['--port', '0', '--demo']);
  const demo = buildDemoConfig(base.config);
  try {
    const monitor = createMonitor({ ...demo, limits: DEFAULT_LIMITS });
    const list = monitor.list();
    assert.equal(list.demo, true);
    assert.ok(list.jobs.length >= 4);
    assert.ok(list.unreadable.length >= 1);
    const kinds = new Set(list.jobs.map((job) => job.status));
    for (const expected of ['running', 'completed', 'failed', 'timed_out', 'unknown']) {
      assert.equal(kinds.has(expected), true, `演示夹具应覆盖状态 ${expected}`);
    }
    const completed = list.jobs.find((job) => job.status === 'completed');
    assert.equal(completed.acceptance.status, 'pass');
    const timedOut = list.jobs.find((job) => job.status === 'timed_out');
    assert.equal(timedOut.acceptance.status, 'fail');
    const running = list.jobs.find((job) => job.status === 'running');
    assert.equal(running.acceptance.status, 'pending');
    const failed = list.jobs.find((job) => job.status === 'failed');
    assert.equal(failed.acceptance.status, 'none', '账本没有条目时必须显示未提供验收记录');
  } finally {
    if (demo.cleanup) demo.cleanup();
  }
});

test('演示夹具目录在 cleanup 后被删除，不遗留临时状态', () => {
  const base = buildConfig(['--port', '0', '--demo']);
  const demo = buildDemoConfig(base.config);
  const root = demo.stateRoot;
  assert.equal(fs.existsSync(root), true);
  demo.cleanup();
  assert.equal(fs.existsSync(root), false);
});
