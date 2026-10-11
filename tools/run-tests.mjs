/**
 * Deterministic test entry point.
 *
 * Node's default discovery also picks up helper modules under `test/`, so the
 * bridge runs the `*.test.mjs` files explicitly, sequentially, with a per-test
 * timeout and a forced exit (a stuck child can otherwise keep a file process
 * alive forever). The JUnit report feeds `tools/collect-test-results.mjs`.
 *
 * Usage: node tools/run-tests.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reports = path.join(ROOT, 'reports');
fs.mkdirSync(reports, { recursive: true });

const files = fs
  .readdirSync(path.join(ROOT, 'test'))
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => path.join('test', name));

if (files.length === 0) {
  process.stderr.write('no test files found under test/\n');
  process.exit(2);
}

const args = [
  '--test',
  '--test-concurrency=1',
  '--test-timeout=60000',
  '--test-force-exit',
  '--test-reporter=spec',
  '--test-reporter-destination=stdout',
  '--test-reporter=junit',
  '--test-reporter-destination=reports/junit.xml',
  ...files,
];

const startedAt = new Date().toISOString();
const started = Date.now();
const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
const durationMs = Date.now() - started;

fs.writeFileSync(
  path.join(reports, 'last-run.json'),
  `${JSON.stringify(
    {
      startedAt,
      durationMs,
      exitCode: result.status,
      files,
      command: `node ${args.join(' ')}`,
    },
    null,
    2,
  )}\n`,
);

process.exit(result.status ?? 1);
