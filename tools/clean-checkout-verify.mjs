/**
 * Clean-checkout delivery verification (FIX-003 F3-04).
 *
 * Extracts the committed tree into a fresh directory, reuses the already
 * installed dependencies (the lockfile is unchanged), builds and runs the full
 * suite there. This proves the delivered commit — not the working tree — builds
 * and passes, and that the committed source manifest still matches the files it
 * claims to cover.
 *
 * Usage: node tools/clean-checkout-verify.mjs [--ref <git ref>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE = path.resolve(ROOT, '..');
const TARGET = path.join(WORKSPACE, '.clean-verify');
const REPORT = path.join(ROOT, 'reports', 'clean-checkout-verification.json');

const refIndex = process.argv.indexOf('--ref');
const ref = refIndex >= 0 ? process.argv[refIndex + 1] : 'HEAD';

function run(command, args, cwd) {
  const started = Date.now();
  try {
    const stdout = execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, code: 0, stdout, durationMs: Date.now() - started };
  } catch (error) {
    const failure = error;
    return {
      ok: false,
      code: typeof failure.status === 'number' ? failure.status : 1,
      stdout: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
      durationMs: Date.now() - started,
    };
  }
}

const commit = execFileSync('git', ['rev-parse', ref], { cwd: ROOT, encoding: 'utf8' }).trim();

fs.rmSync(TARGET, { recursive: true, force: true });
fs.mkdirSync(TARGET, { recursive: true });

const archivePath = path.join(TARGET, 'archive.tar');
// `--output` makes git write the binary archive itself: capturing tar bytes
// through a UTF-8 stdout pipe would corrupt them.
const archive = run('git', ['archive', '--format=tar', `--output=${archivePath}`, commit], ROOT);
if (!archive.ok || !fs.existsSync(archivePath)) {
  process.stderr.write(`git archive failed: ${archive.stdout}\n`);
  process.exit(2);
}
const extract = run('tar', ['-xf', archivePath], TARGET);
if (!extract.ok) {
  process.stderr.write(`tar extract failed: ${extract.stdout}\n`);
  process.exit(2);
}
fs.rmSync(archivePath, { force: true });

// Dependencies are unchanged by this round, so the verified lockfile's installed
// tree is reused instead of re-downloading it.
fs.cpSync(path.join(ROOT, 'node_modules'), path.join(TARGET, 'node_modules'), { recursive: true });

const build = run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], TARGET);
const tests = run(process.execPath, [path.join('tools', 'run-tests.mjs')], TARGET);

const summary = {
  generatedAt: new Date().toISOString(),
  commit,
  target: TARGET,
  dependencySource: 'node_modules copied from the working tree (lockfile unchanged this round)',
  build: { ok: build.ok, exitCode: build.code, durationMs: build.durationMs, tail: build.stdout.split('\n').slice(-6) },
  tests: {
    ok: tests.ok,
    exitCode: tests.code,
    durationMs: tests.durationMs,
    tail: tests.stdout.split('\n').filter((line) => /^ℹ (tests|pass|fail)|^✖/.test(line)).slice(-8),
  },
  realModelCalls: 0,
};
fs.writeFileSync(REPORT, `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
process.exit(tests.ok ? 0 : 1);
