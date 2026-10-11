/**
 * 客户端离线渲染测试：在 Node 里装载 lib/client.js 的手写 bundle，
 * 用最小 React hooks 桩 + 真宿主路由（真实配置、真实状态根，只读）跑通面板，
 * 断言渲染出的文字与基线面板语义一致。
 *
 * 这不替代浏览器视觉验收（色板/窄屏/屏幕阅读器仍未验证），但证明：
 * 组件能装载、标签注册参数正确、刷新链能跑完、断连与暂停路径的文案正确、
 * 面板不显示"没有作业"的空态、验收与执行状态分离、不外泄敏感文本。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMonitor } from '../baseline/src/monitor.mjs';
import { createHostHandler } from '../host/route.mjs';
import { loadPluginConfig, PLUGIN_DIR } from '../host/monitorConfig.mjs';
import { hasRealConfig, skipReason } from './helpers/testConfig.mjs';

const CLIENT_PATH = path.join(PLUGIN_DIR, 'lib', 'client.js');

// 记录客户端创建的定时器，测试结束时全部清除：
// 客户端的 schedule() 是自我续链的 5 秒定时器，promise 链尾的 schedule() 在
// effect cleanup 之后才执行，所以必须在这里兜底清除，否则 Node 事件循环永不退出。
const timers = new Set();
const cleanups = new Set();
const rawSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...rest) => {
  const t = rawSetTimeout(fn, ms, ...rest);
  // 客户端的 schedule() 是自我续链的 5 秒定时器；unref 让它不会把 Node 事件循环吊住
  if (t && typeof t.unref === 'function') t.unref();
  timers.add(t);
  return t;
};
function clearAllTimers() {
  for (const cleanup of cleanups) cleanup();
  cleanups.clear();
  for (const t of timers) clearTimeout(t);
  timers.clear();
}

function makeStubReact() {
  const hooks = [];
  let idx = 0;
  const React = {
    createElement: (tag, props, ...children) => ({ tag, props: props ?? {}, children }),
    useState(init) {
      const i = idx++;
      if (!(i in hooks)) hooks[i] = typeof init === 'function' ? init() : init;
      return [
        hooks[i],
        (v) => {
          hooks[i] = typeof v === 'function' ? v(hooks[i]) : v;
        },
      ];
    },
    useRef(v) {
      const i = idx++;
      if (!(i in hooks)) hooks[i] = { current: v };
      return hooks[i];
    },
    // effect 只在依赖变化时执行；测试结束才调用 cleanup。
    useEffect(fn, deps) {
      const i = idx++;
      const old = hooks[i];
      if (old && deps && old.deps && deps.length === old.deps.length && deps.every((v, n) => Object.is(v, old.deps[n]))) return;
      if (old && old.cleanup) { old.cleanup(); cleanups.delete(old.cleanup); }
      const cleanup = fn();
      hooks[i] = { deps, cleanup };
      if (typeof cleanup === 'function') cleanups.add(cleanup);
    },
    useCallback(fn) {
      const i = idx++;
      if (!(i in hooks)) hooks[i] = fn;
      return hooks[i];
    },
  };
  return { React, beginRender: () => (idx = 0) };
}

/** 在 Node 里装载手写 bundle：模拟 window.__ModuleLoader__.load，并断言只允许 require('react')。 */
function loadBundle() {
  const code = fs.readFileSync(CLIENT_PATH, 'utf8');
  const captured = {};
  const fakeWindow = {
    __ModuleLoader__: {
      load: (def) => {
        captured.def = def;
      },
    },
  };
  new Function('window', code)(fakeWindow);
  const { React, beginRender } = makeStubReact();
  const mod = captured.def.factory((name) => {
    assert.equal(name, 'react', '客户端只允许 require react');
    return React;
  });
  return { mod, React, beginRender, def: captured.def };
}

/** fetch 替身：直接调用真宿主 handler（配置数据（默认使用模拟夹具），只读 GET），不启动端口、不发真实 HTTP。 */
function makeFetchStub() {
  const cfg = loadPluginConfig();
  const monitor = createMonitor({ ...cfg.options, version: '1.0.0 (DSH 嵌入版 0.1.0)' });
  const handler = createHostHandler({
    monitor,
    limits: cfg.options.limits,
    logger: () => {},
    configStatus: () => cfg.status,
    publicDir: path.join(PLUGIN_DIR, 'static-disabled'),
  });
  const calls = [];
  const stub = async function (url, opts) {
    const rawUrl = String(url);
    calls.push(rawUrl);
    if (!rawUrl.startsWith('/dsh-job-monitor/api')) {
      return { ok: false, status: 404, text: async () => JSON.stringify({ error: { code: 'NOT_FOUND', message: '非挂载路径' } }) };
    }
    const res = { statusCode: 0, headers: {}, body: null, writeHead(s, x) { this.statusCode = s; Object.assign(this.headers, x ?? {}); return this; }, end(b) { this.body = b; } };
    await handler({ method: (opts && opts.method) || 'GET', url: rawUrl, headers: {} }, res);
    const body = res.body === null ? '' : Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.body);
    return { ok: res.statusCode === 200, status: res.statusCode, text: async () => body };
  };
  stub.calls = calls;
  return stub;
}

function expand(node) {
  // 真实渲染器会调用函数组件；本桩必须自己展开，否则 h(Panel, props) 只是元素对象
  if (node && typeof node.tag === 'function') return expand(node.tag(node.props));
  return node;
}

/** 收集渲染树里的可见文字（跳过 <style>），用于断言面板文案与基线语义一致。 */
function collectText(node, out = []) {
  if (node === null || node === undefined) return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const n of node) collectText(n, out);
    return out;
  }
  if (typeof node === 'object') {
    if (node.tag === 'style') return out; // CSS 文本不参与断言
    for (const child of node.children ?? []) collectText(child, out);
  }
  return out;
}

/** 侧边栏替身：记录 registerTab 的参数；disposer 只保存不立刻调用（真实宿主在卸载时才调用）。 */
function fakeCtx() {
  const tabs = [];
  const disposers = [];
  return {
    tabs,
    disposers,
    effect(fn) {
      const d = fn();
      if (typeof d === 'function') disposers.push(d);
    },
    betterSidebar: {
      registerTab: (tab) => {
        tabs.push(tab);
        return () => {
          const i = tabs.indexOf(tab);
          if (i >= 0) tabs.splice(i, 1);
        };
      },
    },
  };
}

async function flush(ms = 60) {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((r) => setTimeout(r, ms / 6));
  }
}

test('客户端 bundle 可装载，标签注册参数正确', () => {
  const { mod, def } = loadBundle();
  assert.equal(def.id, 'dsh-job-monitor');
  assert.deepEqual(mod.inject, ['betterSidebar']);
  const ctx = fakeCtx();
  mod.apply(ctx);
  assert.equal(ctx.tabs.length, 1);
  assert.equal(ctx.tabs[0].id, 'dsh-job-monitor:jobs');
  assert.equal(ctx.tabs[0].title, '作业监控');
  assert.equal(ctx.tabs[0].single, true);
  assert.equal(typeof ctx.tabs[0].component, 'function');
});

test('面板在配置数据上渲染：列表、执行状态、验收状态、交付白名单、免责文案', async (t) => {
  if (!hasRealConfig) { t.skip(skipReason()); return; }
  const originalFetch = globalThis.fetch;
  const stub = makeFetchStub();
  globalThis.fetch = stub;
  try {
    const list = JSON.parse(await (await stub('/dsh-job-monitor/api/jobs')).text());
    const first = list.jobs[0];
    const detail = JSON.parse(await (await stub(`/dsh-job-monitor/api/jobs/${first.jobId}`)).text());

    const { mod, beginRender } = loadBundle();
    const ctx = fakeCtx();
    mod.apply(ctx);
    const component = ctx.tabs[0].component;
    const props = { visible: true };
    beginRender();
    expand(component(props)); // 展开函数组件，effect 才会跑（真实渲染器会调用它）
    await flush();
    beginRender();
    const tree = expand(component(props));
    const text = collectText(tree).join('\n');

    assert.ok(text.includes('作业监控'), '标题');
    assert.ok(text.includes('状态根可访问'), '状态根');
    assert.match(text, /owner 心跳 \d+ 秒前（新鲜|已过期）/);
    assert.ok(text.includes('刷新成功（初始化）'), '刷新成功文案');
    assert.ok(text.includes(first.name), '列表展示名（来自配置映射）');
    assert.ok(text.includes(first.jobId), 'jobId');
    assert.ok(text.includes(first.statusLabel), '执行状态标签');
    assert.ok(text.includes('时限已用'), '时限比例（不是完成百分比）');
    assert.ok(text.includes('测试结果：未提供'), '不给出测试通过结论');
    assert.ok(text.includes('“正常结束”只表示进程退出码为 0，不代表工作被接受'), '执行免责常驻');
    assert.ok(text.includes('不读取日志正文、任务正文、请求正文、凭据'), '只读边界说明');
    assert.ok(!text.includes('没有作业'), '不得出现"没有作业"的空态');
    // 验收与交付：断言与配置一致，不写死具体作业
    if (detail.acceptance) assert.ok(text.includes(detail.acceptance.label), '验收状态只来自账本');
    if (detail.delivery && detail.delivery.configured) {
      assert.ok(text.includes('白名单来源'), '交付白名单来源');
      assert.ok(text.includes(detail.delivery.label), '交付白名单标签');
    } else {
      assert.ok(text.includes('未配置交付目录'), '未授权目录显示未配置');
    }
    assert.ok(stub.calls.every((u) => u.startsWith('/dsh-job-monitor/api')), '只访问同源挂载点');
  } finally {
    clearAllTimers();
    globalThis.fetch = originalFetch;
  }
});

function findRow(node, jobId, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const r = findRow(n, jobId, found);
      if (r) return r;
    }
    return null;
  }
  if (node.tag === 'tr' && node.props && node.props.onClick) {
    const text = collectText(node).join('');
    if (text.includes(jobId)) return node;
  }
  for (const child of node.children ?? []) {
    const r = findRow(child, jobId, found);
    if (r) return r;
  }
  return null;
}

test('未映射工作区显示"未配置交付目录"，不猜测目录', async (t) => {
  if (!hasRealConfig) { t.skip(skipReason()); return; }
  const originalFetch = globalThis.fetch;
  const stub = makeFetchStub();
  globalThis.fetch = stub;
  try {
    const list = JSON.parse(await (await stub('/dsh-job-monitor/api/jobs')).text());
    let unmapped = null;
    for (const j of list.jobs) {
      const d = JSON.parse(await (await stub(`/dsh-job-monitor/api/jobs/${j.jobId}`)).text());
      if (d.delivery && !d.delivery.configured) {
        unmapped = j;
        break;
      }
    }
    if (!unmapped) { t.skip('配置内没有未映射作业样本'); return; }

    const { mod, beginRender } = loadBundle();
    const ctx = fakeCtx();
    mod.apply(ctx);
    const component = ctx.tabs[0].component;
    const props = { visible: true };

    beginRender();
    const first = expand(component(props));
    await flush();
    beginRender();
    const tree = expand(component(props));
    const row = findRow(tree, unmapped.jobId);
    assert.ok(row, `列表里应能找到 ${unmapped.jobId} 行`);
    row.props.onClick();
    await flush();
    beginRender();
    const after = expand(component(props));
    const text = collectText(after).join('\n');
    assert.ok(text.includes(unmapped.name), '展示名渲染（不猜测展示名）');
    assert.ok(text.includes('未配置交付目录'), '未授权目录显示未配置');
    assert.ok(text.includes('未配置交付目录：请在配置文件中为该工作区或该作业指定只读白名单目录'), '未配置时给出可操作说明（基线 noteNode）');
  } finally {
    clearAllTimers();
    globalThis.fetch = originalFetch;
  }
});

test('断连：显示失败与"保留上次成功采样"，不显示空列表', async (t) => {
  if (!hasRealConfig) { t.skip(skipReason()); return; }
  const originalFetch = globalThis.fetch;
  const good = makeFetchStub();
  globalThis.fetch = good;
  try {
    const list = JSON.parse(await (await good('/dsh-job-monitor/api/jobs')).text());
    const firstName = list.jobs[0].name;

    const { mod, beginRender } = loadBundle();
    const ctx = fakeCtx();
    mod.apply(ctx);
    const component = ctx.tabs[0].component;
    const props = { visible: true };

    beginRender();
    expand(component(props));
    await flush(); // 第一次成功采样

    globalThis.fetch = async () => {
      throw new Error('模拟断连');
    };
    beginRender();
    const controls = expand(component(props));
    function manual(n) {
      if (!n || typeof n !== 'object') return null;
      if (n.tag === 'button' && collectText(n).join('') === '立即刷新') return n;
      for (const x of n.children || []) { const r = manual(x); if (r) return r; }
      return null;
    }
    manual(controls).props.onClick();
    await flush(); // 刷新失败

    beginRender();
    const tree = expand(component(props));
    const text = collectText(tree).join('\n');
    assert.ok(text.includes('刷新失败'), '断连横幅');
    assert.ok(text.includes('保留上次成功采样'), '保留上次成功采样');
    assert.ok(text.includes(firstName), '断连后保留上次数据，不空列表');
    assert.ok(text.includes('刷新失败（连续 1 次，NETWORK）'), '错误码为 NETWORK');
  } finally {
    clearAllTimers();
    globalThis.fetch = originalFetch;
  }
});

test('标签不可见时暂停轮询并给出提示', async () => {
  const originalFetch = globalThis.fetch;
  const stub = makeFetchStub();
  globalThis.fetch = stub;
  try {
    const { mod, beginRender } = loadBundle();
    const ctx = fakeCtx();
    mod.apply(ctx);
    const component = ctx.tabs[0].component;
    beginRender();
    expand(component({ visible: false })); // 本次渲染里的 effect 设置暂停提示
    beginRender();
    const tree = expand(component({ visible: false }));
    const text = collectText(tree).join('\n');
    assert.ok(text.includes('标签不可见，已暂停自动刷新'), '暂停提示');
  } finally {
    clearAllTimers();
    globalThis.fetch = originalFetch;
  }
});
