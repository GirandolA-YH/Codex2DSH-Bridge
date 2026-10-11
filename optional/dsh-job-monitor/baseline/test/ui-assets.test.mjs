import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(PROJECT_ROOT, relative), 'utf8');

test('交付文件齐全', () => {
  const required = [
    'package.json',
    'server.mjs',
    'README.md',
    'public/index.html',
    'public/app.js',
    'public/styles.css',
    'config/monitor.example.json',
    // 发布版不含 M01 内部报告与哈希清单（reports/ 被 .gitignore 排除）
  ];
  for (const relative of required) {
    const file = path.join(PROJECT_ROOT, relative);
    assert.equal(fs.existsSync(file), true, `缺少 ${relative}`);
    assert.ok(fs.statSync(file).size > 0, `${relative} 为空`);
  }
});

test('无外部依赖、无外部资源、不联网', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.deepEqual(pkg.dependencies ?? {}, {});
  assert.deepEqual(pkg.devDependencies ?? {}, {});

  const sources = ['public/index.html', 'public/app.js', 'public/styles.css'];
  for (const relative of sources) {
    const text = read(relative);
    assert.equal(/https?:\/\//i.test(text), false, `${relative} 不应引用外部地址`);
    assert.equal(/cdn\./i.test(text), false, `${relative} 不应引用 CDN`);
  }

  const server = read('server.mjs');
  assert.equal(/\bfetch\(/.test(server), false, '服务端不应发起网络请求');
  assert.equal(/child_process/.test(server), false, '服务端不应 spawn 子进程（不得拉起桥或模型）');
  for (const relative of ['src/config.mjs', 'src/state.mjs', 'src/monitor.mjs', 'src/http.mjs', 'src/activity.mjs']) {
    assert.equal(/child_process/.test(read(relative)), false, `${relative} 不应 spawn 子进程`);
  }
});

test('只依赖 Node 内置模块', () => {
  const files = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(PROJECT_ROOT, rel), { withFileTypes: true })) {
      const next = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (['node_modules', '.git', 'test', 'fixtures'].includes(entry.name)) continue;
        walk(next);
      } else if (/\.(mjs|js)$/.test(entry.name)) {
        files.push(next);
      }
    }
  };
  walk('src');
  files.push('server.mjs');
  for (const relative of files) {
    const text = read(relative);
    for (const match of text.matchAll(/from\s+'([^']+)'/g)) {
      const specifier = match[1];
      assert.ok(
        specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../'),
        `${relative} 引入了非内置模块：${specifier}`,
      );
    }
  }
});

test('页面使用 textContent，不用 innerHTML 注入数据', () => {
  const app = read('public/app.js');
  assert.equal(/\binnerHTML\s*=/.test(app), false, 'app.js 不得写入 innerHTML');
  assert.equal(/\bouterHTML\s*=/.test(app), false, 'app.js 不得写入 outerHTML');
  assert.equal(/insertAdjacentHTML\s*\(/.test(app), false);
  assert.equal(/setAttribute\(\s*['"]on[a-z]+/.test(app), false, '不得用 setAttribute 挂事件');
  assert.equal(/document\.write\s*\(/.test(app), false);
  assert.equal(/new Function\s*\(/.test(app), false);
  assert.equal(/eval\s*\(/.test(app), false);
  assert.ok(app.includes('textContent'));
  assert.ok(app.includes('replaceChildren'));
  assert.ok(app.includes('createElement'));
  assert.ok(app.includes('AbortController'), '刷新需要超时控制');
  assert.ok(app.includes('visibilitychange'), '页面隐藏/恢复需要处理');
  assert.ok(app.includes('encodeURIComponent'));
});

test('中文任务台视觉方案落地：色板、字体、无障碍、窄屏、reduced-motion', () => {
  const css = read('public/styles.css');
  for (const color of ['#f6f8fc', '#ffffff', '#1c2c45', '#2f5fb6', '#2d806a', '#a06917', '#ad4054']) {
    assert.ok(css.toLowerCase().includes(color), `缺少任务书指定颜色 ${color}`);
  }
  assert.ok(/Microsoft YaHei UI/.test(css));
  assert.ok(/Cascadia Code/.test(css));
  assert.ok(/prefers-reduced-motion/.test(css));
  assert.ok(/:focus-visible/.test(css));
  assert.ok(/max-width: 900px/.test(css));
  assert.ok(/max-width: 380px/.test(css));

  const html = read('public/index.html');
  assert.ok(html.includes('lang="zh-CN"'));
  assert.ok(html.includes('时限已用'));
  assert.ok(html.includes('验收状态') || html.includes('独立验收状态'));
  assert.ok(html.includes('role="progressbar"'));
  assert.ok(html.includes('aria-live'));
  assert.ok(html.includes('演示数据'));
  assert.ok(html.includes('delivery-test'), '交付区必须有“测试结果”占位行');
  assert.ok(read('public/app.js').includes('测试结果：'), '页面必须显式展示“测试结果：未提供”');
  assert.equal(/<script>(?=[\s\S])/.test(html), false, '不应有内联脚本');
});

test('服务端错误文案不包含未经筛选的原始异常', () => {
  const httpSource = read('src/http.mjs');
  assert.equal(/error\.message/.test(httpSource), false, 'HTTP 层不得回显异常 message');
  assert.equal(/\.stack\b/.test(httpSource), false, 'HTTP 层不得回显堆栈');
  const monitorSource = read('src/monitor.mjs');
  assert.equal(/\.errorMessage\b/.test(monitorSource), false, '监控层不得访问 record.errorMessage');
  assert.equal(/\.command\b/.test(monitorSource), false, '监控层不得访问 record.command');
});
