/**
 * Build `reports/source-manifest.json`: SHA-256 for every delivered file.
 *
 * Excluded on purpose: `node_modules`, `dist` (build output), `state` (runtime
 * job records), `test/.tmp` (per-test sandboxes) and `logs`. The manifest covers
 * source, tests, fixtures, configs, tools and reports, so a later audit can
 * detect that the reviewed bytes changed.
 *
 * Usage: node tools/source-manifest.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.join(ROOT, 'reports', 'source-manifest.json');

const INCLUDE_FILES = ['README.md', 'LICENSE', 'package.json', 'package-lock.json', 'tsconfig.json', '.gitignore', '.gitattributes'];
const INCLUDE_DIRS = ['src', 'test', 'fixtures', 'config', 'tools', 'audits', 'reports'];
const EXCLUDE_DIR_NAMES = new Set(['node_modules', 'dist', 'state', '.tmp', 'logs', '.git']);
const EXCLUDE_FILE_NAMES = new Set(['source-manifest.json', 'junit.xml', 'last-run.json', 'clean-checkout-verification.json', 'r4-exit-order.json', 'r4-spawn-window.json']);
/** Fixture directories created by the copied Codex evidence scripts at run time. */
const EXCLUDE_DIR_PREFIXES = ['probe-fixtures-', 'host-fixtures-', 'boundary-fixtures-', 'process-fixtures-', 'new-host-fixtures-', 'ownership-fixtures-', 'heartbeat-host-fixtures-', 'guard-fixtures-', 'pid-query-fixtures-', 'denied-release-host-fixtures-'];

/** Directories that must never be hashed, even when nested. */
function isExcluded(relPath) {
  const parts = relPath.split('/');
  if (parts.some((part) => EXCLUDE_DIR_NAMES.has(part))) return true;
  if (parts.some((part) => EXCLUDE_DIR_PREFIXES.some((prefix) => part.startsWith(prefix)))) return true;
  const name = parts[parts.length - 1];
  if (EXCLUDE_FILE_NAMES.has(name)) return true;
  // Run logs are produced by the verification steps themselves; they are never
  // part of the delivered set (FIX-003 F3-04).
  if (name.endsWith('.log')) return true;
  return false;
}

function collect(dir, prefix, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (isExcluded(rel)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collect(abs, rel, out);
      continue;
    }
    if (!entry.isFile()) continue;
    out.push(rel);
  }
}

const files = [];
for (const file of INCLUDE_FILES) {
  if (fs.existsSync(path.join(ROOT, file))) files.push(file);
}
for (const dir of INCLUDE_DIRS) {
  const abs = path.join(ROOT, dir);
  if (fs.existsSync(abs)) collect(abs, dir, files);
}

files.sort();
const entries = files.map((rel) => {
  const abs = path.join(ROOT, rel);
  const data = fs.readFileSync(abs);
  return { path: rel, size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
});

const digest = createHash('sha256')
  .update(entries.map((entry) => `${entry.path}\u0000${entry.size}\u0000${entry.sha256}`).join('\n'))
  .digest('hex');

const manifest = {
  schema: 'dsh-codex-bridge/source-manifest/v1',
  generatedAt: new Date().toISOString(),
  algorithm: 'sha256',
  root: ROOT,
  fileCount: entries.length,
  digest,
  note:
    'Hashes cover the delivered source, tests, fixtures, config samples and reports. dist/, node_modules/, state/ and test/.tmp/ are build or runtime artifacts and are excluded.',
  files: entries,
};

fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
fs.writeFileSync(OUTPUT, JSON.stringify(manifest, null, 2) + '\n');
process.stdout.write(`wrote ${OUTPUT} (${entries.length} files, digest ${digest.slice(0, 16)}…)\n`);
