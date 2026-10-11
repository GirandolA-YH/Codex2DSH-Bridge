/**
 * 在受限沙箱中 `node --test` 可能 spawn EPERM；该入口把每个测试文件导入同一进程运行。
 * 用法：node test/run-all.mjs  （等价于 npm run test:files）
 */
import './paths.test.mjs';
import './config.test.mjs';
import './job-record.test.mjs';
import './acceptance.test.mjs';
import './activity.test.mjs';
import './workspace-scan.test.mjs';
import './monitor.test.mjs';
import './server-entry.test.mjs';
import './http.test.mjs';
import './ui-assets.test.mjs';
