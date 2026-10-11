/** 只读复核：对配置里的状态根连续 2 轮采样后比对哈希摘要（证明面板不写被监控目录）。 */
import fs from 'node:fs';
import { snapshotTree } from '../baseline/test/helpers/fixture.mjs';
import { createHostHandler } from '../host/route.mjs';
import { createMonitor } from '../baseline/src/monitor.mjs';
import { loadPluginConfig } from '../host/monitorConfig.mjs';

// 无配置时优雅跳过：发布版仓库不含真实配置，这条证明只在有真实只读配置的环境里跑
const cfg = loadPluginConfig();
if (!cfg.options.stateRoot || !fs.existsSync(cfg.options.stateRoot)) {
  console.log('跳过：未提供只读配置（写 config/monitor.json，或设置 DSH_JOB_MONITOR_CONFIG 指向含 stateRoot 的配置）');
  process.exit(2); // 未执行只读核验不能当作通过
}
const monitor = createMonitor({ ...cfg.options });
const handler = createHostHandler({
  monitor,
  limits: cfg.options.limits,
  logger: () => {},
  configStatus: () => cfg.status,
  publicDir: 'X:/no-static',
});

// 进程内调用宿主 handler（不启动端口）；publicDir 指向不存在的路径，宿主上没有 HTML 面
function res() {
  return {
    statusCode: 0,
    headers: {},
    body: null,
    writeHead(s, x) {
      this.statusCode = s;
      Object.assign(this.headers, x ?? {});
      return this;
    },
    end(b) {
      this.body = b;
    },
  };
}

async function get(url) {
  const r = res();
  await handler({ method: 'GET', url, headers: {} }, r);
  return JSON.parse(String(r.body));
}

// 采样前后各做一次整树快照（相对路径 + 大小 + mtime + 内容 sha256）；
// 摘要一致 = 面板没有写入被监控目录。两次运行之间摘要变化来自桥自己的写入，与本插件无关。
const root = cfg.options.stateRoot;
const before = snapshotTree(root);
let meta = null;
let list = null;
for (let i = 0; i < 2; i += 1) {
  meta = await get('/dsh-job-monitor/api/meta');
  list = await get('/dsh-job-monitor/api/jobs');
  for (const job of list.jobs.slice(0, 4)) {
    await get(`/dsh-job-monitor/api/jobs/${job.jobId}`);
  }
}
const after = snapshotTree(root);
console.log('meta stateRoot exists:', meta.stateRoot.exists, 'owner stale:', meta.owner.stale);
console.log('jobs listed:', list.counts.listed, 'unreadable:', list.counts.unreadable);
console.log('digest before:', before.digest.slice(0, 20));
console.log('digest after :', after.digest.slice(0, 20));
console.log('identical:', before.digest === after.digest, 'entries:', before.entries.length, '->', after.entries.length);
