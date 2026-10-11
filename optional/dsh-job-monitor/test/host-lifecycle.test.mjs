/**
 * 宿主生命周期与"无新增服务"证明（隔离夹具 + 真实状态根的只读采样）。
 *
 * 覆盖：单次挂载只注册一条同源路由、重复挂载不产生重复服务、前缀冲突时优雅降级、
 * 插件激活路径不创建任何监听端口、客户端 bundle 契约、基线副本逐字节未被改动、
 * 对配置状态根连续采样后哈希与 mtime 完全不变。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { apply } from '../lib/index.js';
import { MOUNT, API_PREFIX } from '../host/route.mjs';
import { snapshotTree } from '../baseline/test/helpers/fixture.mjs';
import { hasRealConfig, skipReason, testCfg } from './helpers/testConfig.mjs';

const PLUGIN_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * 宿主替身：模拟 webServer.register（同前缀二次注册抛冲突）与 ctx.effect。
 * effect 只**保存** disposer 不立刻调用——真实宿主是在卸载时才调用 disposer，
 * 立刻调用会让路由在断言前就被卸载。
 */
function makeFakeCtx() {
  const routes = [];
  const logs = [];
  const disposers = [];
  return {
    routes,
    logs,
    disposers,
    log(m) {
      logs.push(String(m));
    },
    effect(fn) {
      const d = fn();
      if (typeof d === 'function') disposers.push(d);
    },
    webServer: {
      register(route, label) {
        for (const r of routes) {
          if (r.route.path === route.path) throw new Error('prefix conflict');
        }
        routes.push({ route, label });
        return () => {
          const i = routes.findIndex((x) => x.route.path === route.path);
          if (i >= 0) routes.splice(i, 1);
        };
      },
    },
  };
}

function fakeRes() {
  const res = { statusCode: 0, headers: {}, body: null };
  res.writeHead = (status, headers) => {
    res.statusCode = status;
    Object.assign(res.headers, headers ?? {});
    return res;
  };
  res.end = (body) => {
    if (body !== undefined && body !== null) res.body = body;
  };
  return res;
}

async function call(handler, method, url) {
  const res = fakeRes();
  await handler({ method, url, headers: {} }, res);
  const raw = res.body === null ? '' : Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.body);
  return { status: res.statusCode, headers: res.headers, body: raw };
}

test('单次挂载只注册一条同源路由，并返回 disposer', () => {
  const ctx = makeFakeCtx();
  apply(ctx);
  assert.equal(ctx.routes.length, 1);
  assert.equal(ctx.routes[0].route.kind, 'prefix');
  assert.equal(ctx.routes[0].route.path, MOUNT);
  assert.ok(ctx.routes[0].label.includes('dsh-job-monitor'));
  assert.equal(ctx.disposers.length, 1);
  assert.equal(typeof ctx.disposers[0], 'function');
});

test('卸载后路由归零；重挂载（HMR）后仍只有一条', () => {
  const ctx = makeFakeCtx();
  apply(ctx);
  for (const d of ctx.disposers) d();
  assert.equal(ctx.routes.length, 0);
  apply(ctx);
  assert.equal(ctx.routes.length, 1);
});

test('前缀冲突时优雅降级：不抛异常、不创建第二条服务、记录诊断', () => {
  const ctx = makeFakeCtx();
  apply(ctx);
  apply(ctx); // 模拟重复打开 / 未先卸载
  assert.equal(ctx.routes.length, 1);
  assert.ok(ctx.logs.some((l) => l.includes('同源路由挂载失败')));
});

test('宿主路由端到端可用（配置数据（默认使用模拟夹具），只读）', async (t) => {
  if (!hasRealConfig) { t.skip(skipReason()); return; }
  const ctx = makeFakeCtx();
  apply(ctx);
  const handler = ctx.routes[0].route.handler;

  const meta = await call(handler, 'GET', `${API_PREFIX}/meta`);
  assert.equal(meta.status, 200);
  const m = JSON.parse(meta.body);
  assert.equal(m.readOnly, true);
  assert.ok(m.stateRoot.configured);
  assert.equal(m.stateRoot.exists, true);

  const cfg = await call(handler, 'GET', `${API_PREFIX}/config-status`);
  const c = JSON.parse(cfg.body);
  assert.equal(c.listens, false);
  assert.equal(c.readOnly, true);
  assert.ok(Array.isArray(c.workspaceMap.byWorkspaceId));

  const list = await call(handler, 'GET', `${API_PREFIX}/jobs`);
  const l = JSON.parse(list.body);
  assert.ok(l.counts.totalJobDirectories >= 1);
  assert.equal(l.readOnly, true);

  const post = await call(handler, 'POST', `${API_PREFIX}/jobs`);
  assert.equal(post.status, 405);
});

test('对配置状态根连续采样后，所有文件哈希与 mtime 完全不变', async (t) => {
  if (!hasRealConfig) { t.skip(skipReason()); return; }
  const ctx = makeFakeCtx();
  apply(ctx);
  const handler = ctx.routes[0].route.handler;
  const realRoot = testCfg.options.stateRoot;
  if (!fs.existsSync(realRoot)) return;
  const before = snapshotTree(realRoot);
  for (let i = 0; i < 3; i += 1) {
    await call(handler, 'GET', `${API_PREFIX}/meta`);
    const l = JSON.parse((await call(handler, 'GET', `${API_PREFIX}/jobs`)).body);
    for (const job of l.jobs.slice(0, 4)) {
      await call(handler, 'GET', `${API_PREFIX}/jobs/${job.jobId}`);
    }
  }
  const after = snapshotTree(realRoot);
  assert.equal(after.digest, before.digest);
  assert.equal(after.entries.length, before.entries.length);
});

test('插件激活路径不创建任何监听端口（静态证明）', () => {
  const files = ['lib/index.js', 'host/route.mjs', 'host/monitorConfig.mjs', 'lib/client.js'];
  for (const f of files) {
    const text = fs.readFileSync(path.join(PLUGIN_DIR, f), 'utf8');
    assert.ok(!text.includes('createServer'), f);
    assert.ok(!text.includes('startServer'), f);
    assert.ok(!text.includes('.listen('), f);
    assert.ok(!text.includes('node:http'), f);
  }
  // 基线里的 server.mjs 是逐字节副本，插件激活路径不导入它
  const hostText = fs.readFileSync(path.join(PLUGIN_DIR, 'lib/index.js'), 'utf8');
  assert.ok(!hostText.includes('server.mjs'));
});

test('客户端 bundle 契约：id 与包名一致、只 require react、无 innerHTML、只访问同源挂载点', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'package.json'), 'utf8'));
  const text = fs.readFileSync(path.join(PLUGIN_DIR, 'lib/client.js'), 'utf8');
  assert.ok(text.includes(`window.__ModuleLoader__.load({`));
  assert.ok(text.includes(`id: '${pkg.name}'`));
  assert.ok(text.includes("var inject = ['betterSidebar'];"));
  assert.ok(text.includes('module.exports.apply = apply'));
  assert.ok(text.includes('module.exports.inject = inject'));
  assert.ok(text.includes('ctx.betterSidebar.registerTab'));
  assert.ok(text.includes("title: '作业监控'"));
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!code.includes('innerHTML'));
  assert.ok(!code.includes('document.write'));
  const requires = text.match(/require\(['"]([^'"]+)['"]\)/g) ?? [];
  assert.deepEqual(requires, ["require('react')"]);
  const fetches = code.match(/fetchJson\([^)]*\)/g) ?? [];
  assert.ok(fetches.length >= 4, '客户端必须通过统一入口请求宿主路由');
  for (const f of fetches) {
    if (f.startsWith('fetchJson(url')) continue; // 函数定义
    assert.ok(f.includes('API +'), f);
  }
  assert.ok(text.includes("var API = '/dsh-job-monitor/api'"));
  assert.ok(!code.includes('http://'));
  assert.ok(!code.includes('https://'));
  assert.ok(!code.includes("fetchJson('/api"));
  assert.ok(text.includes('props.visible'));
  assert.ok(text.includes('AbortController'));
  assert.ok(text.includes('inFlight'));
});

test('基线快照未被改动（与 test/baseline-hashes.json 全部一致）', () => {
  // 发布版对 baseline/ 做过脱敏（路径改占位、reports/ 不入库），因此这里校验的是
  // 脱敏后快照的自洽清单，不再声称与 M01 原始交付逐字节一致。
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'test', 'baseline-hashes.json'), 'utf8'));
  assert.equal(manifest.fileCount, manifest.files.length);
  for (const entry of manifest.files) {
    const p = path.join(PLUGIN_DIR, 'baseline', entry.path.replace(/\//g, path.sep));
    assert.ok(fs.existsSync(p), entry.path);
    const buf = fs.readFileSync(p);
    assert.equal(buf.length, entry.sizeBytes, entry.path);
    assert.equal(crypto.createHash('sha256').update(buf).digest('hex'), entry.sha256, entry.path);
  }
});

test('插件不写入任何被监控的目录（配置与代码里无写操作目标）', () => {
  const texts = ['lib/index.js', 'host/route.mjs', 'host/monitorConfig.mjs', 'lib/client.js'].map((f) => fs.readFileSync(path.join(PLUGIN_DIR, f), 'utf8'));
  const joined = texts.join('\n');
  for (const bad of ['writeFileSync', 'appendFile', 'mkdirSync', 'rmSync', 'unlinkSync', 'chmod', 'renameSync']) {
    assert.ok(!joined.includes(bad), bad);
  }
});
