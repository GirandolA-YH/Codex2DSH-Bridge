/** 发布回归：用模拟作业与受控异步请求验证路径边界、卸载、选择竞争和断连保留。无需 DSH 或模型。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { apply } from '../lib/index.js';
import { loadPluginConfig } from '../host/monitorConfig.mjs';
import { createHostHandler } from '../host/route.mjs';
import { makeTempRoot, rmTree, makeJobRecord, writeJob } from '../baseline/test/helpers/fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = process.env.DSH_MONITOR_REVIEW_TARGET || ROOT;
const response = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify(data) });
const drain = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function text(n) {
  if (n == null) return '';
  if (typeof n !== 'object') return String(n);
  if (Array.isArray(n)) return n.map(text).join(' ');
  if (n.tag === 'style') return '';
  return (n.children || []).map(text).join(' ');
}
function find(n, predicate) {
  if (!n || typeof n !== 'object') return null;
  if (predicate(n)) return n;
  for (const child of Array.isArray(n) ? n : (n.children || [])) { const hit = find(child, predicate); if (hit) return hit; }
  return null;
}
function client(fetch) {
  const hooks = [], timers = new Map(); let index = 0, serial = 0, definition;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const React = {
    createElement: (tag, props, ...children) => ({ tag, props: props || {}, children }),
    useState(init) { const i = index++; if (!(i in hooks)) hooks[i] = { value: typeof init === 'function' ? init() : init }; return [hooks[i].value, v => { hooks[i].value = typeof v === 'function' ? v(hooks[i].value) : v; }]; },
    useRef(value) { const i = index++; if (!(i in hooks)) hooks[i] = { current: value }; return hooks[i]; },
    useCallback(fn, deps) { const i = index++; if (!hooks[i] || !same(deps, hooks[i].deps)) hooks[i] = { fn, deps }; return hooks[i].fn; },
    useEffect(fn, deps) { const i = index++; if (hooks[i] && same(deps, hooks[i].deps)) return; if (hooks[i]?.cleanup) hooks[i].cleanup(); hooks[i] = { deps, cleanup: fn() }; },
  };
  const context = {
    window: { __ModuleLoader__: { load(def) { definition = def; } } },
    AbortController, fetch, console,
    setTimeout(fn, ms) { const id = ++serial; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn, ms) { const id = ++serial; timers.set(id, { fn, ms }); return id; },
    clearInterval(id) { timers.delete(id); },
  };
  vm.runInNewContext(fs.readFileSync(path.join(TARGET, 'lib/client.js'), 'utf8'), context);
  const mod = definition.factory(name => { assert.equal(name, 'react'); return React; });
  let component;
  mod.apply({ effect(fn) { fn(); }, betterSidebar: { registerTab(tab) { component = tab.component; } } });
  const expand = n => n && typeof n.tag === 'function' ? expand(n.tag(n.props)) : n;
  return {
    render(visible = true) { index = 0; return expand(component({ visible })); },
    unmount() { for (const hook of hooks) if (hook?.cleanup) { hook.cleanup(); hook.cleanup = null; } },
    timers,
  };
}
const jobs = [
  { jobId: 'job-aabbccddeeff0011', name: '作业 A', statusLabel: '运行中', acceptance: {} },
  { jobId: 'job-aabbccddeeff0022', name: '作业 B', statusLabel: '运行中', acceptance: {} },
];
const detail = job => ({ job: { ...job, name: `详情 ${job.name}` }, activity: null, delivery: null });
function api(url, { meta = {}, list = { jobs }, getDetail = id => detail(jobs.find(j => j.jobId === id)) } = {}) {
  if (url.endsWith('/config-status')) return response({ configWarnings: [] });
  if (url.endsWith('/meta')) return response(meta);
  if (url.endsWith('/jobs')) return response(list);
  return response(getDetail(url.split('/').pop()));
}
async function call(handler, method, url) {
  const res = { writeHead(s, headers) { this.status = s; this.headers = headers; }, end(body) { this.body = body; } };
  await handler({ method, url }, res); return res;
}

test('未配置时不读取 cwd 中的假作业；诊断可用、数据接口 503、写接口 405', async () => {
  const dir = makeTempRoot(); const cwd = process.cwd();
  writeJob(dir, jobs[0].jobId, makeJobRecord(jobs[0].jobId));
  const cfg = loadPluginConfig(path.join(dir, 'absent.json'));
  assert.equal(cfg.status.configured, false);
  const h = createHostHandler({ monitor: null, limits: cfg.options.limits, configStatus: () => cfg.status });
  process.chdir(dir);
  try {
    const r = await call(h, 'GET', '/dsh-job-monitor/api/jobs');
    assert.equal(r.status, 503); assert.equal(JSON.parse(String(r.body)).error.code, 'CONFIG_NOT_CONFIGURED');
    assert.equal((await call(h, 'GET', '/dsh-job-monitor/api/config-status')).status, 200);
    assert.equal((await call(h, 'POST', '/dsh-job-monitor/api/jobs')).status, 405);
    // 实际插件激活时也不建立默认采样器。
    if (!process.env.DSH_JOB_MONITOR_CONFIG) {
      let route; apply({ log() {}, effect(fn) { fn(); }, webServer: { register(r) { route = r; } } });
      assert.equal((await call(route.handler, 'GET', '/dsh-job-monitor/api/jobs')).status, 503);
    }
  } finally { process.chdir(cwd); rmTree(dir); }
});

test('非法 JSON 配置保持未配置，不从当前目录补猜路径', () => {
  const dir = makeTempRoot();
  try { const file = path.join(dir, 'bad.json'); fs.writeFileSync(file, '{bad'); const cfg = loadPluginConfig(file); assert.equal(cfg.ok, false); assert.equal(cfg.status.configured, false); }
  finally { rmTree(dir); }
});

test('HEAD 配置状态、错误响应都没有正文，配置状态允许查询参数', async () => {
  const h = createHostHandler({ monitor: null, configStatus: () => ({ configured: false }) });
  for (const url of ['/dsh-job-monitor/api/config-status?x=1', '/dsh-job-monitor/api/jobs', '/dsh-job-monitor/missing']) {
    const r = await call(h, 'HEAD', url); assert.equal(r.body, undefined);
  }
  assert.equal((await call(h, 'GET', '/dsh-job-monitor/api/config-status?x=1')).status, 200);
});

test('卸载期间未完成的刷新不得复活轮询，也不继续读取 jobs', async () => {
  const pending = deferred(), calls = [];
  const c = client(async url => { calls.push(url); if (url.endsWith('/meta')) return pending.promise; return api(url); });
  c.render(); c.unmount(); pending.resolve(response({})); await drain();
  assert.equal(c.timers.size, 0); assert.ok(!calls.some(url => url.endsWith('/jobs')));
});

test('请求失败及时清理超时定时器；面板卸载后没有残留定时器', async () => {
  const c = client(async () => { throw new Error('offline'); });
  c.render(); await drain();
  assert.equal([...c.timers.values()].filter(t => t.ms === 4000 || t.ms === 6000).length, 0);
  c.unmount(); assert.equal(c.timers.size, 0);
});

test('切换选择后旧详情不得覆盖新作业，并补发新选择的详情请求', async () => {
  const pending = deferred(); let delayA = false; const calls = [];
  const c = client(async url => { calls.push(url); if (delayA && url.endsWith(jobs[0].jobId)) return pending.promise; return api(url); });
  try {
    c.render(); await drain(); const first = c.render();
    delayA = true; find(first, n => n.tag === 'button' && text(n) === '立即刷新').props.onClick(); await drain();
    const row = find(c.render(), n => n.tag === 'tr' && n.props.onClick && text(n).includes(jobs[1].jobId));
    row.props.onClick(); pending.resolve(response(detail(jobs[0]))); await drain();
    const output = text(c.render()); assert.ok(output.includes('详情 作业 B')); assert.ok(!output.includes('详情 作业 A'));
    assert.ok(calls.some(url => url.endsWith(jobs[1].jobId)));
  } finally { c.unmount(); }
});

test('中途断连保留上一轮完整列表和详情，不发布半轮新数据', async () => {
  let failure = false;
  const c = client(async url => {
    if (!failure) return api(url);
    if (url.endsWith(jobs[0].jobId)) throw new Error('detail offline');
    return api(url, { list: { jobs: [{ ...jobs[0], name: '不应出现的新数据' }, jobs[1]] } });
  });
  try {
    c.render(); await drain(); const first = c.render(); failure = true;
    find(first, n => n.tag === 'button' && text(n) === '立即刷新').props.onClick(); await drain();
    const output = text(c.render()); assert.ok(output.includes('保留上次成功采样')); assert.ok(output.includes('详情 作业 A')); assert.ok(!output.includes('不应出现的新数据'));
  } finally { c.unmount(); }
});

test('选择消失时保留回落提示，避免成功刷新擦掉提示', async () => {
  let missing = false;
  const c = client(async url => api(url, { list: { jobs: missing ? [jobs[1]] : jobs } }));
  try {
    c.render(); await drain(); const first = c.render(); missing = true;
    find(first, n => n.tag === 'button' && text(n) === '立即刷新').props.onClick(); await drain();
    assert.ok(text(c.render()).includes('已切换到最新作业'));
  } finally { c.unmount(); }
});
