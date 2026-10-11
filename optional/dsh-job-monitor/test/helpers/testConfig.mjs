/**
 * 测试用配置：优先用环境变量 DSH_JOB_MONITOR_CONFIG 指向的配置，
 * 否则用插件目录内的 config/monitor.json。
 * 发布版仓库里不含真实配置（config/monitor.json 被 .gitignore 排除），
 * 因此依赖真实状态根的测试在配置缺失时自动跳过，不会误报失败。
 */
import fs from 'node:fs';
import { loadPluginConfig, CONFIG_PATH } from '../../host/monitorConfig.mjs';

// CONFIG_PATH 会应用环境变量；默认文件路径本身不会应用该覆盖。
export const TEST_CONFIG_PATH = CONFIG_PATH;
export const testCfg = loadPluginConfig(TEST_CONFIG_PATH);
export const hasRealConfig = Boolean(testCfg.options.stateRoot) && fs.existsSync(testCfg.options.stateRoot);

export function skipReason() {
  return '未提供只读配置（设置 DSH_JOB_MONITOR_CONFIG 指向含 stateRoot 的 config/monitor.json 后才会跑真实数据测试）';
}
