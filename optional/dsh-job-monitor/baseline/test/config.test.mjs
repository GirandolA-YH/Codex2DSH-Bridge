import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConfig, parseArgs, DEFAULT_STATE_ROOT } from '../src/config.mjs';
import { createWorkspaceMap } from '../src/workspaceMap.mjs';
import { makeTempRoot, rmTree } from './helpers/fixture.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('默认值：只读状态根、loopback、4178、无账本', () => {
  const result = buildConfig([]);
  assert.equal(result.ok, true);
  assert.equal(result.config.port, 4178);
  assert.equal(result.config.host, '127.0.0.1');
  assert.equal(result.config.stateRoot, path.resolve(DEFAULT_STATE_ROOT));
  assert.equal(result.config.acceptanceLedger, null);
  assert.equal(result.config.demo, false);
  assert.equal(result.config.refreshIntervalMs, 5000);
});

test('拒绝非 loopback 监听地址', () => {
  for (const host of ['0.0.0.0', '192.168.1.5', '::', 'example.com']) {
    const result = buildConfig(['--host', host]);
    assert.equal(result.ok, false, `${host} 应被拒绝`);
    assert.match(result.message, /loopback/);
  }
  assert.equal(buildConfig(['--host', 'localhost']).config.host, '127.0.0.1');
  assert.equal(buildConfig(['--host', '::1']).config.host, '::1');
});

test('未知参数、缺值、越界上限都报错', () => {
  assert.equal(parseArgs(['--nope']).ok, false);
  assert.equal(parseArgs(['--port']).ok, false);
  assert.equal(parseArgs(['--port', 'abc']).ok, false);
  assert.equal(parseArgs(['--port', '70000']).ok, false);
  assert.equal(parseArgs(['--max-jobs', '99999']).ok, false, '超过硬上限应拒绝');
  assert.equal(parseArgs(['--help']).help, true);
});

test('命令行覆盖配置文件', () => {
  const root = makeTempRoot();
  try {
    const file = path.join(root, 'config.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        stateRoot: 'E:/from-file',
        acceptanceLedger: 'E:/ledger.json',
        port: 5000,
        workspaceMap: { byWorkspaceId: { 'from-file': 'E:/ws' } },
        limits: { maxJobs: 7, bogus: 1, maxScanEntries: 999999 },
      }),
      'utf8',
    );
    const result = buildConfig(['--config', file, '--port', '5100', '--state-root', 'E:/from-cli']);
    assert.equal(result.ok, true);
    assert.equal(result.config.port, 5100);
    assert.equal(result.config.stateRoot, path.resolve('E:/from-cli'));
    assert.equal(result.config.acceptanceLedger, path.resolve('E:/ledger.json'));
    assert.equal(result.config.limits.maxJobs, 7);
    assert.equal(result.config.limits.maxScanEntries, 300, '超过硬上限的配置被夹到硬上限');
    assert.equal('bogus' in result.config.limits, false);
    assert.equal(result.config.workspaceMap.byWorkspaceId['from-file'], 'E:/ws');
  } finally {
    rmTree(root);
  }
});

test('示例配置可被完整加载，也可单独作为白名单映射', () => {
  const example = path.join(PROJECT_ROOT, 'config', 'monitor.example.json');
  const full = buildConfig(['--config', example]);
  assert.equal(full.ok, true, full.message);
  assert.equal(full.config.workspaceMap.byWorkspaceId['ws-demo'].includes('REPLACE'), true);
  assert.equal(full.config.workspaceMap.byJobId['job-0000000000000000'].includes('REPLACE'), true);

  const mapOnly = buildConfig(['--workspace-map', example]);
  assert.equal(mapOnly.ok, true, mapOnly.message);
  assert.equal(mapOnly.config.workspaceMap.byWorkspaceId['ws-demo'].includes('REPLACE'), true);
  assert.equal(mapOnly.config.acceptanceLedger, null, '纯映射用法不应顺带改状态根/账本');
});

test('坏配置文件给出可读错误而不是异常', () => {
  const root = makeTempRoot();
  try {
    const broken = path.join(root, 'broken.json');
    fs.writeFileSync(broken, '{ "stateRoot": ', 'utf8');
    const result = buildConfig(['--config', broken]);
    assert.equal(result.ok, false);
    assert.match(result.message, /无法读取|不是合法 JSON/);

    const arrayFile = path.join(root, 'array.json');
    fs.writeFileSync(arrayFile, '[]', 'utf8');
    assert.equal(buildConfig(['--config', arrayFile]).ok, false);
  } finally {
    rmTree(root);
  }
});

test('工作区映射：非法条目被拒绝且可解释', () => {
  const map = createWorkspaceMap({
    byWorkspaceId: { 'ws-demo': 'E:/ws', 'bad id': 'E:/x', empty: '' },
    byJobId: { 'job-aaaaaaaaaaaa': 'E:/ws', nope: 'E:/x' },
    names: { 'job-aaaaaaaaaaaa': '  本地名  ', 'job-bbbbbbbbbbbb': '' },
  });
  assert.equal(map.configured, true);
  assert.equal(map.byWorkspaceId.size, 1);
  assert.equal(map.byJobId.size, 1);
  assert.equal(map.names.get('job-aaaaaaaaaaaa'), '本地名');
  assert.equal(map.names.has('job-bbbbbbbbbbbb'), false);
  assert.ok(map.rejected.length >= 3);

  assert.deepEqual(map.resolve({ jobId: 'job-aaaaaaaaaaaa', workspaceId: 'ws-demo' }), {
    configured: true,
    root: 'E:/ws',
    match: 'byJobId',
    label: '按作业覆盖（job-aaaaaaaaaaaa）',
  });
  assert.equal(map.resolve({ jobId: 'job-zzzzzzzzzzzz', workspaceId: 'unknown' }).configured, false);
  assert.equal(map.displayName({ jobId: 'job-aaaaaaaaaaaa' }).source, 'jobId-mapping');
  assert.equal(map.displayName({ jobId: 'job-zzzzzzzzzzzz' }).name, null);
});

test('控制字符与超长名称被清洗', () => {
  const map = createWorkspaceMap({ names: { 'job-aaaaaaaaaaaa': 'a'.repeat(200) + '\u0007' } });
  const name = map.names.get('job-aaaaaaaaaaaa');
  assert.equal(name.length <= 81, true);
  assert.equal(name.includes('\u0007'), false);
});
