import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMonitor } from '../src/monitor.mjs';
import { createRequestHandler, startServer } from '../src/http.mjs';
import { DEFAULT_LIMITS } from '../src/constants.mjs';
import { materializeDemoState } from '../fixtures/demo.mjs';
import { makeTempRoot, rmTree, snapshotTree } from './helpers/fixture.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');

let ctx;

function rawRequest(port, requestPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: requestPath, method }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  const stateRoot = makeTempRoot('dsh-monitor-http-');
  const demo = materializeDemoState(stateRoot, { now: Date.now() });
  const monitor = createMonitor({
    stateRoot: demo.root,
    acceptanceLedger: demo.ledgerPath,
    workspaceMap: { byWorkspaceId: { 'demo-workspace': demo.workspaceDir } },
  });
  const handler = createRequestHandler({ monitor, publicDir: PUBLIC_DIR, limits: DEFAULT_LIMITS });
  const started = await startServer({ host: '127.0.0.1', port: 0, handler });
  ctx = { stateRoot, demo, monitor, ...started, before: snapshotTree(demo.root) };
});

after(async () => {
  if (ctx?.server) await new Promise((resolve) => ctx.server.close(resolve));
  if (ctx?.stateRoot) rmTree(ctx.stateRoot);
});

test('仅绑定 loopback，端口由内核分配', () => {
  const address = ctx.server.address();
  assert.equal(typeof address, 'object');
  assert.equal(address.address, '127.0.0.1');
  assert.ok(ctx.port > 0);
});

test('GET 数据接口与静态资源正常返回', async () => {
  const meta = await fetch(`${ctx.url}api/meta`);
  assert.equal(meta.status, 200);
  const metaJson = await meta.json();
  assert.equal(metaJson.readOnly, true);
  assert.equal(metaJson.demo, false, '生产只读模式默认不填演示数据');

  const list = await fetch(`${ctx.url}api/jobs`);
  assert.equal(list.status, 200);
  const listJson = await list.json();
  assert.ok(listJson.jobs.length >= 4);
  assert.ok(listJson.unreadable.length >= 1, '损坏记录必须单独列出');

  const firstId = listJson.jobs[0].jobId;
  const detail = await fetch(`${ctx.url}api/jobs/${firstId}`);
  assert.equal(detail.status, 200);
  const detailJson = await detail.json();
  assert.equal(detailJson.jobId, firstId);
  assert.ok(detailJson.activity);
  assert.ok(detailJson.acceptance);

  const page = await fetch(ctx.url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') ?? '', /text\/html/);
  const html = await page.text();
  assert.match(html, /DSH 作业监控/);

  const css = await fetch(`${ctx.url}styles.css`);
  assert.equal(css.status, 200);
  const js = await fetch(`${ctx.url}app.js`);
  assert.equal(js.status, 200);
});

test('非 GET 一律 405，且不带跨源共享头', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'TRACE']) {
    const response = await rawRequest(ctx.port, '/api/jobs', method);
    assert.equal(response.status, 405, `${method} 应返回 405`);
    assert.equal(response.headers.allow, 'GET, HEAD');
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    assert.match(response.body, /METHOD_NOT_ALLOWED/);
  }
});

test('HEAD 只返回头，不返回正文', async () => {
  const response = await rawRequest(ctx.port, '/api/jobs', 'HEAD');
  assert.equal(response.status, 200);
  assert.equal(response.body, '');
  assert.ok(Number(response.headers['content-length']) > 0);
});

test('非法 jobId、未知接口、路径遍历都被拒绝', async () => {
  const bad = await fetch(`${ctx.url}api/jobs/not-a-job`);
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, 'INVALID_JOB_ID');

  const traversalId = await fetch(`${ctx.url}api/jobs/${encodeURIComponent('..%2F..%2Fetc%2Fpasswd')}`);
  assert.ok([400, 404].includes(traversalId.status));

  const unknown = await fetch(`${ctx.url}api/jobs/job-zzzzzzzzzzzzzzzz`);
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error.code, 'JOB_NOT_FOUND');

  const unknownApi = await fetch(`${ctx.url}api/nope`);
  assert.equal(unknownApi.status, 404);

  const rawTraversal = await rawRequest(ctx.port, '/api/jobs/%2e%2e%2f%2e%2e%2fetc%2fpasswd');
  assert.equal(rawTraversal.status, 400);
  assert.match(rawTraversal.body, /PATH_TRAVERSAL/);

  const staticTraversal = await rawRequest(ctx.port, '/..%2f..%2fserver.mjs');
  assert.equal(staticTraversal.status, 400);

  const missingStatic = await rawRequest(ctx.port, '/nope.js');
  assert.equal(missingStatic.status, 404);
  assert.equal(missingStatic.body.includes('404'), true);
});

test('安全响应头：无 CORS、无 nosniff 缺失、HTML 有严格 CSP', async () => {
  const api = await fetch(`${ctx.url}api/jobs`);
  assert.equal(api.headers.get('access-control-allow-origin'), null);
  assert.equal(api.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(api.headers.get('cache-control'), 'no-store');

  const page = await fetch(ctx.url);
  const csp = page.headers.get('content-security-policy') ?? '';
  assert.match(csp, /default-src 'self'/);
  assert.equal(csp.includes('unsafe-inline'), false);
  assert.equal(csp.includes('unsafe-eval'), false);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
});

test('响应大小与读取上限有界', async () => {
  const list = await fetch(`${ctx.url}api/jobs`);
  const text = await list.text();
  assert.ok(text.length < 200000, `列表响应应有界，实际 ${text.length}`);
  const meta = await fetch(`${ctx.url}api/meta`);
  const metaText = await meta.text();
  assert.equal(metaText.includes('maxJobJsonBytes'), true);
});

test('GET 采样前后夹具内容哈希与 mtime 完全不变', async () => {
  const requests = ['api/meta', 'api/jobs', 'api/jobs/job-demo000000000001', 'api/jobs/job-demo000000000003', 'app.js', 'styles.css', ''];
  for (const relative of requests) {
    const response = await fetch(`${ctx.url}${relative}`);
    assert.ok(response.status >= 200 && response.status < 500, `${relative} 意外状态 ${response.status}`);
    await response.text();
  }
  const after = snapshotTree(ctx.demo.root);
  assert.equal(after.digest, ctx.before.digest, 'HTTP 只读采样不得改动状态夹具');
});

test('端口被占用时给出明确错误（EADDRINUSE）', async () => {
  const handler = createRequestHandler({ monitor: ctx.monitor, publicDir: PUBLIC_DIR, limits: DEFAULT_LIMITS });
  await assert.rejects(
    () => startServer({ host: '127.0.0.1', port: ctx.port, handler }),
    (error) => {
      assert.match(error.message, /已被占用/);
      assert.equal(error.code, 'EADDRINUSE');
      return true;
    },
  );
});
