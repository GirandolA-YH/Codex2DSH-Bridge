/**
 * dsh-job-monitor —— DSH 宿主侧插件（作业监控只读面板）
 *
 * 生命周期：
 *   apply(ctx) 只在插件挂载时执行一次（HMR 重挂载时旧 effect 的 disposer 先被调用）。
 *   每次挂载创建 1 个 createMonitor 实例，注册 1 条同源前缀路由，注册即返回 disposer。
 *   插件不启动任何监听端口、不启动桥、不启动模型作业、不写状态目录。
 *   关闭面板 / 重复打开面板都不会触发以上任何行为。
 */
import path from 'node:path';
import { createMonitor } from '../baseline/src/monitor.mjs';
import { createHostHandler, MOUNT } from '../host/route.mjs';
import { loadPluginConfig, PLUGIN_DIR } from '../host/monitorConfig.mjs';

export const name = 'dsh-job-monitor';
export const inject = ['webServer'];

export const PLUGIN_VERSION = '0.1.0';

/** 宿主日志面形状不固定（log / warn 都可能没有），这里统一成"有就用、没有就静默"，绝不因日志失败影响采样。 */
function makeLogger(ctx) {
  return function log(message) {
    const text = `dsh-job-monitor: ${message}`;
    try {
      if (typeof ctx.log === 'function') ctx.log(text);
      else if (typeof ctx.warn === 'function') ctx.warn(text);
      else console.log(text);
    } catch {
      /* 宿主日志面不可用时静默，不影响采样 */
    }
  };
}

export function apply(ctx) {
  const log = makeLogger(ctx);
  // 配置只在宿主进程内读取（浏览器无法传入路径）；诊断逐条写日志，同时进面板横幅
  const cfg = loadPluginConfig();
  for (const w of cfg.warnings) log(`配置诊断：${w}`);

  // 只有明确配置状态根后才创建采样器，避免空路径被基线解释成当前目录。
  const monitor = cfg.status.configured ? createMonitor({
    ...cfg.options,
    version: `1.0.0 (DSH 嵌入版 ${PLUGIN_VERSION})`,
  }) : null;

  const handler = createHostHandler({
    monitor,
    limits: cfg.options.limits,
    logger: log,
    configStatus: () => cfg.status,
    // 静态资源在宿主上永不可达（适配器只放行 /api/*）；这里指向不存在的目录作为第二道防线
    publicDir: path.join(PLUGIN_DIR, 'static-disabled'),
  });

  // 没有注册面时优雅退出：不抛异常、不创建任何服务，面板显示断连
  if (!ctx.webServer || typeof ctx.webServer.register !== 'function') {
    log('宿主没有提供 webServer 注册面，作业监控路由不可用。');
    return;
  }

  ctx.effect(() => {
    // 前缀冲突（例如与其它插件撞挂载点）时不崩溃挂载：记录诊断，前端会显示断连并保留上次采样
    let disposer;
    try {
      disposer = ctx.webServer.register(
        { kind: 'prefix', path: MOUNT, handler },
        'dsh-job-monitor: 作业监控只读路由',
      );
      log(`同源路由已挂载：${MOUNT}/api/*（只读，无新增端口）`);
    } catch (error) {
      log(`同源路由挂载失败（${String((error && error.code) || (error && error.message) || '未知原因')}）：面板将显示断连，不重复创建服务。`);
      return undefined;
    }
    return typeof disposer === 'function' ? disposer : undefined;
  });
}
