/**
 * 生成源码哈希清单（reports/source-hashes.json）。
 *
 * 用法：node scripts/hash-sources.mjs
 * 清单本身不把自己算进去；路径按字典序，结果可复现。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.join(PROJECT_ROOT, 'reports', 'source-hashes.json');
const SKIP_DIRS = new Set(['node_modules', '.git', '.tmp', 'demo-state']);

function collect(rel, out) {
  const absolute = path.join(PROJECT_ROOT, rel);
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) continue;
    const next = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collect(next, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (next.replace(/\\/g, '/') === 'reports/source-hashes.json') continue;
    out.push(next.replace(/\\/g, '/'));
  }
}

const files = [];
collect('', files);
files.sort();

const entries = files.map((relative) => {
  const content = fs.readFileSync(path.join(PROJECT_ROOT, relative));
  return {
    path: relative,
    sizeBytes: content.length,
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
  };
});

const digest = crypto
  .createHash('sha256')
  .update(entries.map((entry) => `${entry.path} ${entry.sha256}`).join('\n'))
  .digest('hex');

const manifest = {
  schema: 'dsh-monitor/source-hashes/v1',
  generatedAt: new Date().toISOString(),
  generator: 'node scripts/hash-sources.mjs',
  fileCount: entries.length,
  totalBytes: entries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
  digestSha256: digest,
  note: '本清单不包含自身；哈希覆盖交付目录内除 node_modules/.git/.tmp/demo-state 以外的全部文件。',
  files: entries,
};

fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
fs.writeFileSync(OUTPUT, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
process.stdout.write(`已写入 ${path.relative(PROJECT_ROOT, OUTPUT)}：${entries.length} 个文件，digest ${digest}\n`);
