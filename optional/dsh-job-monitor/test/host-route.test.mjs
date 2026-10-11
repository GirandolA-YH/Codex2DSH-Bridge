/**
 * 宿主同源路由契约测试（全部使用隔离夹具，不接触真实桥状态、不启动任何端口）。
 *
 * 覆盖：GET-only 契约、detail() {ok,value} 到 HTTP 状态的映射、非法 jobId、未知作业、
 * 非挂载路径（宿主上没有可被 iframe 的 HTML）、路径遍历、超长 URL、HEAD、
 * 无 CORS、只读（夹具哈希与 mtime 前后一致）、敏感文本不外泄、
 * 状态 / 身份 / 验收三者分离、终态用时冻结。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createMonitor } from '../baseline/src/monitor.mjs';
import { createHostHandler, MOUNT, API_PREFIX } from '../host/route.mjs';
import {
  makeTempRoot,
  rmTree,
  writeOwner,
  makeJobRecord,
  writeJob,
  writeRawJobFile,
  snapshotTree,
  collectStrings,
  FAKE_SECRET,
  FAKE_BEARER,
  FAKE_TASK_BODY,
} from '../baseline/test/helpers/fixture.mjs';

/** 最小响应替身：只提供 writeHead / end，形状与宿主适配器要求的 SidebarHttpResponse 一致。 */
function fakeRes() {
  const res = { statusCode: 0, headers: {}, body: null, ended: false };
  res.writeHead = (status, headers) => {
    res.statusCode = status;
    Object.assign(res.headers, headers ?? {});
    return res;
  };
  res.end = (body) => {
    if (body !== undefined && body !== null) res.body = body;
    res.ended = true;
  };
  return res;
}

/** 进程内直接调用 handler（不启动端口、不发真实 HTTP 请求），返回状态/头/正文。 */
async function call(handler, method, url) {
  const res = fakeRes();
  await handler({ method, url, headers: {} }, res);
  const raw = res.body === null ? '' : Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.body);
  return { status: res.statusCode, headers: res.headers, body: raw };
}

function jsonOf(r) {
  return r.body ? JSON.parse(r.body) : null;
}

/**
 * 隔离夹具：一个临时状态根 + 白名单交付目录 + 验收账本。
 * 夹具里刻意放入假凭据与假任务正文（FAKE_SECRET / FAKE_BEARER / FAKE_TASK_BODY），
 * 用于证明这些内容不会出现在任何接口响应里。
 */
function buildFixture() {
  const root = makeTempRoot('dsh-job-monitor-embed-');
  const wsDir = path.join(root, 'ws', 'impl');
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(wsDir, 'report.md'), '# 夹具报告\n');
  fs.writeFileSync(path.join(wsDir, 'notes.txt'), FAKE_TASK_BODY);
  const now = Date.now();
  writeOwner(root, { startedAt: now - 60000, heartbeatAt: now });

  writeJob(
    root,
    'job-aabbccddeeff0011',
    makeJobRecord('job-aabbccddeeff0011', {
      workspaceId: 'ws-a',
      status: 'completed',
      exitCode: 0,
      startedAt: new Date(now - 60000).toISOString(),
      endedAt: new Date(now - 30000).toISOString(),
      bytes: { stdout: 12, stderr: 3 },
      rawBytes: { stdout: 12, stderr: 3 },
    }),
    { stdout: `stdout ${FAKE_SECRET}\n`, stderr: `stderr ${FAKE_BEARER}\n` },
  );
  writeJob(root, 'job-aabbccddeeff0012', makeJobRecord('job-aabbccddeeff0012', { workspaceId: 'ws-b', status: 'running' }), {
    stdout: 'x',
    stderr: 'y',
  });
  writeJob(
    root,
    'job-aabbccddeeff0014',
    makeJobRecord('job-aabbccddeeff0014', {
      workspaceId: 'ws-c',
      status: 'completed',
      exitCode: 0,
      startedAt: new Date(now - 50000).toISOString(),
      endedAt: new Date(now - 20000).toISOString(),
    }),
    { stdout: 'done', stderr: '' },
  );
  writeRawJobFile(root, 'job-aabbccddeeff0013', '{ not json');

  const ledgerPath = path.join(root, 'ledger.json');
  fs.writeFileSync(
    ledgerPath,
    `${JSON.stringify(
      {
        schema: 'dsh-monitor/acceptance-ledger/v1',
        updatedAt: '2026-10-10',
        jobs: {
          'job-aabbccddeeff0011': { status: 'pass', reviewedAt: '2026-10-10' },
          'job-aabbccddeeff0012': { status: 'fail', reviewedAt: '2026-10-10' },
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return { root, wsDir, ledgerPath };
}

/** 用夹具构造一个"和线上完全同形"的宿主 handler：同一份基线契约 + 同一份适配器。 */
function makeHandler(fx) {
  const monitor = createMonitor({
    stateRoot: fx.root,
    acceptanceLedger: fx.ledgerPath,
    workspaceMap: {
      byWorkspaceId: { 'ws-a': fx.wsDir },
      byJobId: {},
      names: { 'job-aabbccddeeff0011': '夹具面板' },
      workspaceNames: { 'ws-a': '夹具实施' },
    },
    version: '1.0.0 (测试)',
  });
  const handler = createHostHandler({
    monitor,
    limits: undefined,
    logger: () => {},
    configStatus: () => ({ app: 'dsh-job-monitor', readOnly: true, listens: false, configSource: 'fixture', configWarnings: [] }),
    publicDir: path.join(fx.root, 'static-disabled'),
  });
  return { monitor, handler };
}

test('meta：200、只读声明、无 CORS 头', async () => {
  const fx = buildFixture();
  const { handler } = makeHandler(fx);
  const r = await call(handler, 'GET', `${API_PREFIX}/meta`);
  assert.equal(r.status, 200);
  const m = jsonOf(r);
  assert.equal(m.app, 'dsh-monitor');
  assert.equal(m.readOnly, true);
  assert.ok(m.stateRoot.configured);
  assert.equal(m.stateRoot.exists, true);
  assert.ok(!('Access-Control-Allow-Origin' in r.headers));
  assert.equal(r.headers['Cache-Control'], 'no-store');
  assert.equal(r.headers['X-Content-Type-Options'], 'nosniff');
  rmTree(fx.root);
});

test('jobs：200、计数、验收标签与展示名映射', async () => {
  const fx = buildFixture();
  const { handler } = makeHandler(fx);
  const r = await call(handler, 'GET', `${API_PREFIX}/jobs`);
  assert.equal(r.status, 200);
  const l = jsonOf(r);
  assert.equal(l.counts.totalJobDirectories, 4);
  assert.equal(l.counts.listed, 3);
  assert.equal(l.counts.unreadable, 1);
  const byId = Object.fromEntries(l.jobs.map((j) => [j.jobId, j]));
  assert.equal(byId['job-aabbccddeeff0011'].name, '夹具面板');
  assert.equal(byId['job-aabbccddeeff0011'].acceptance.status, 'pass');
  assert.equal(byId['job-aabbccddeeff0011'].acceptance.label, '验收通过');
  assert.equal(byId['job-aabbccddeeff0012'].acceptance.status, 'fail');
  // 退出码 0 + 正常结束，账本没有条目 -> 验收必须仍是"未提供"
  assert.equal(byId['job-aabbccddeeff0014'].status, 'completed');
  assert.equal(byId['job-aabbccddeeff0014'].exitCode, 0);
  assert.equal(byId['job-aabbccddeeff0014'].acceptance.status, 'none');
  assert.equal(byId['job-aabbccddeeff0014'].acceptance.label, '未提供验收记录');
  assert.equal(l.executionDisclaimer, '“正常结束”只表示进程退出码为 0，不代表工作被接受。');
  rmTree(fx.root);
});

test('detail：交付白名单命中 / 未配置目录显示未配置 / 不读取正文', async () => {
  const fx = buildFixture();
  const { handler } = makeHandler(fx);
  const r = await call(handler, 'GET', `${API_PREFIX}/jobs/job-aabbccddeeff0011`);
  assert.equal(r.status, 200);
  const d = jsonOf(r);
  assert.equal(d.readOnly, true);
  assert.equal(d.delivery.configured, true);
  assert.equal(d.delivery.match, 'byWorkspaceId');
  assert.equal(d.delivery.label, '按工作区映射（ws-a）');
  assert.equal(d.delivery.testResult.status, 'not-provided');
  assert.equal(d.delivery.testResult.label, '未提供');
  const paths = d.delivery.recentFiles.map((f) => f.path);
  assert.ok(paths.includes('report.md'));
  // 夹具日志正文里的敏感串绝不能出现在任何响应里
  const strings = collectStrings(d);
  assert.ok(!strings.some((s) => s.includes(FAKE_SECRET)));
  assert.ok(!strings.some((s) => s.includes(FAKE_TASK_BODY)));
  assert.ok(!('command' in d.job));
  assert.ok(!('errorMessage' in d.job));

  const r2 = await call(handler, 'GET', `${API_PREFIX}/jobs/job-aabbccddeeff0014`);
  const d2 = jsonOf(r2);
  assert.equal(d2.delivery.configured, false);
  assert.equal(d2.delivery.label, '未配置交付目录');
  assert.match(d2.delivery.note, /未配置交付目录/);
  rmTree(fx.root);
});

test('非法 jobId -> 400；未知作业 -> 404；损坏记录 -> 200 且单独说明', async () => {
  const fx = buildFixture();
  const { handler } = makeHandler(fx);
  const bad = await call(handler, 'GET', `${API_PREFIX}/jobs/not-a-job`);
  assert.equal(bad.status, 400);
  assert.equal(jsonOf(bad).error.code, 'INVALID_JOB_ID');

  const missing = await call(handler, 'GET', `${API_PREFIX}/jobs/job-cccccccccccc0001`);
  assert.equal(missing.status, 404);
  assert.equal(jsonOf(missing).error.code, 'JOB_NOT_FOUND');

  const broken = await call(handler, 'GET', `${API_PREFIX}/jobs/job-aabbccddeeff0013`);
  assert.equal(broken.status, 200);
  const b = jsonOf(broken);
  assert.equal(b.job, null);
  assert.ok(b.recordError);
  assert.match(b.notes[0], /不会把它当作/);
  rmTree(fx.root);
});

test('只读契约：非 GET/HEAD 一律 405 + Allow', async () => {
  const fx = buildFixture();
  const { handler } = makeHandler(fx);
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const r = await call(handler, method, `${API_PREFIX}/jobs`);
    assert.equal(r.status, 405, method);
    assert.equal(r.headers.Allow, 'GET, HEAD');
    assert.equal(jsonOf(r).error.code, 'METHOD_NOT_ALLOWED');
    assert.match(jsonOf(r).error.message, /不提供提交\/取消\/删除\/重试\/配置编辑/);
  }
  const cfg = await call(handler, 'POST', `${API_PREFIX}/config-status`);
  assert.equal(cfg.status, 405);
  rmTree(fx.root);
});

test('宿主上没有可被 iframe 的 HTML：非 /api 路径 404，静态资源不可达', async () => {
  const fx = buildFixture();
  const { handler } = makeHandler(fx);
  for (const url of [MOUNT, `${MOUNT}/`, `${MOUNT}/index.html`, `${MOUNT}/app.js`, `${MOUNT}/styles.css`, `${MOUNT}/favicon.ico`]) {
    const r = await call(handler, 'GET', url);
    assert.equal(r.status, 404, url);
    assert.equal(jsonOf(r).error.code, 'NOT_FOUND');
    assert.ok(!r.headers['Content-Type']?.includes('text/html'));
  }
  rmTree(fx.root);
});

test('路径遍历与超长 URL 被拒绝（永远读不到白名单外的文件）', async () => {
  const fx = buildFixture();
  const { handler } = makeHandler(fx);
  // 原始 ".." 会被 URL 规范化掉：结果不在挂载前缀内 -> 404，绝不会去读文件
  const trav = await call(handler, 'GET', `${API_PREFIX}/../state/owner.lock`);
  assert.ok([400, 404].includes(trav.status));
  assert.ok(!trav.body.includes('lockId'));
  // 编码过的 ".." 被 URL 规范化掉 -> 404；带编码斜杠的变体在解码后被显式拒绝
  const enc = await call(handler, 'GET', `${API_PREFIX}/%2e%2e/state`);
  assert.ok([400, 404].includes(enc.status));
  assert.ok(!enc.body.includes('lockId'));
  const enc2 = await call(handler, 'GET', `${API_PREFIX}/%2e%2e%2fstate`);
  assert.equal(enc2.status, 400);
  assert.equal(jsonOf(enc2).error.code, 'PATH_TRAVERSAL');
  const long = await call(handler, 'GET', `${API_PREFIX}/jobs/${'a'.repeat(3000)}`);
  assert.equal(long.status, 414);
  assert.equal(jsonOf(long).error.code, 'URI_TOO_LONG');
  rmTree(fx.root);
});

test('HEAD 只返回头，不返回正文', async () => {
  const fx = buildFixture();
  const { handler } = makeHandler(fx);
  const r = await call(handler, 'HEAD', `${API_PREFIX}/meta`);
  assert.equal(r.status, 200);
  assert.equal(r.body, '');
  assert.ok(r.headers['Content-Length'] > 0);
  rmTree(fx.root);
});

test('config-status：只读、声明不监听、暴露配置来源与诊断', async () => {
  const fx = buildFixture();
  const { handler } = makeHandler(fx);
  const r = await call(handler, 'GET', `${API_PREFIX}/config-status`);
  assert.equal(r.status, 200);
  const c = jsonOf(r);
  assert.equal(c.app, 'dsh-job-monitor');
  assert.equal(c.readOnly, true);
  assert.equal(c.listens, false);
  assert.equal(c.configSource, 'fixture');
  rmTree(fx.root);
});

test('只读证明：连续 6 次采样后夹具哈希与 mtime 完全不变', async () => {
  const fx = buildFixture();
  const { handler } = makeHandler(fx);
  const before = snapshotTree(fx.root);
  for (let i = 0; i < 6; i += 1) {
    await call(handler, 'GET', `${API_PREFIX}/meta`);
    await call(handler, 'GET', `${API_PREFIX}/jobs`);
    await call(handler, 'GET', `${API_PREFIX}/jobs/job-aabbccddeeff0011`);
    await call(handler, 'GET', `${API_PREFIX}/jobs/job-aabbccddeeff0012`);
  }
  const after = snapshotTree(fx.root);
  assert.equal(after.digest, before.digest);
  assert.equal(after.entries.length, before.entries.length);
  rmTree(fx.root);
});

test('终态用时按 endedAt 冻结，不显示完成百分比', async () => {
  const fx = buildFixture();
  const { handler } = makeHandler(fx);
  const r = await call(handler, 'GET', `${API_PREFIX}/jobs/job-aabbccddeeff0011`);
  const d = jsonOf(r);
  assert.equal(d.job.elapsedFrozen, true);
  assert.equal(d.job.elapsedMs, 30000);
  assert.ok(!('completionPercent' in d.job));
  rmTree(fx.root);
});

test('挂载前缀不与 DSH 保留前缀冲突', () => {
  assert.equal(MOUNT, '/dsh-job-monitor');
  for (const reserved of ['/api', '/plugins', '/sidebar']) {
    assert.ok(!MOUNT.startsWith(reserved), MOUNT);
  }
});
