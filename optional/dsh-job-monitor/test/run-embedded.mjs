/**
 * 嵌入版新增测试入口（与基线 test/run-all.mjs 同样的"同进程导入"方式，
 * 避免受限沙箱里 node --test 的 spawn EPERM）。
 * 用法：node test/run-embedded.mjs
 */
import './host-route.test.mjs';
import './host-lifecycle.test.mjs';
import './client-render.test.mjs';

import './publication-regressions.test.mjs';
