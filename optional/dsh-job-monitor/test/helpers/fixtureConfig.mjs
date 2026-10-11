/** 可重复的外部配置夹具：不需要使用者的真实状态目录或模型凭据。 */
import fs from 'node:fs';
import path from 'node:path';
import { makeTempRoot, rmTree, writeOwner, writeJob, makeJobRecord } from '../../baseline/test/helpers/fixture.mjs';

export function installFixtureConfig() {
  const root = makeTempRoot('dsh-monitor-publication-');
  const delivery = path.join(root, 'delivery'); fs.mkdirSync(delivery);
  fs.writeFileSync(path.join(delivery, 'report.md'), '# 模拟交付，不是业务验收\n');
  writeOwner(root);
  const a = 'job-aabbccddeeff0011', b = 'job-aabbccddeeff0022';
  writeJob(root, a, makeJobRecord(a, { workspaceId: 'mapped-example', status: 'completed', exitCode: 0, endedAt: new Date().toISOString() }), { stdout: 'DO-NOT-LEAK-LOG-BODY' });
  writeJob(root, b, makeJobRecord(b, { workspaceId: 'unmapped-example' }));
  const ledger = path.join(root, 'ledger.json');
  fs.writeFileSync(ledger, JSON.stringify({ jobs: { [a]: { status: 'pass', reviewedAt: new Date().toISOString() } } }));
  const configPath = path.join(root, 'monitor.json');
  fs.writeFileSync(configPath, JSON.stringify({ stateRoot: root, acceptanceLedger: ledger, workspaceMap: { byWorkspaceId: { 'mapped-example': delivery } }, names: { [a]: '模拟作业 A', [b]: '模拟作业 B' } }));
  process.env.DSH_JOB_MONITOR_CONFIG = configPath;
  // Node 测试结束后才清理；读取路径只属于本进程创建的隔离目录。
  process.on('exit', () => rmTree(root));
  return root;
}
