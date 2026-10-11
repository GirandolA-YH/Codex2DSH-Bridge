/**
 * A17/A18 — the delivered package documents its own boundaries and is
 * reproducible: pinned lockfile, runnable build, example configs, reports, and a
 * verifiable source manifest.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as H from './helpers/harness.mjs';

const README = path.join(H.ROOT, 'README.md');
const CONFIG_DIR = path.join(H.ROOT, 'config');
const REPORTS = path.join(H.ROOT, 'reports');

test('A17 the documentation states the real isolation and redaction boundaries', () => {
  assert.equal(fs.existsSync(README), true, 'README.md is missing');
  const readme = fs.readFileSync(README, 'utf8');
  assert.match(readme, /不是 OS 沙箱|not an OS sandbox/i);
  assert.match(readme, /脱敏|redact/i);
  assert.match(readme, /无法识别所有|not claim|cannot recognise every/i);
  assert.match(readme, /token|成本/i, 'the token/cost guidance section is present');
  assert.match(readme, /TOKEN-ECONOMY|Token 与成本|成本与 token/i, 'README has a dedicated cost section');
  assert.match(readme, /session-id/, 'the deferred session-resume option is documented');
});

test('A18 example configs and the Codex MCP snippet exist without credentials', () => {
  const exampleConfig = path.join(CONFIG_DIR, 'bridge.config.example.json');
  const desktopConfig = path.join(CONFIG_DIR, 'bridge.config.desktop.json');
  const selftestConfig = path.join(CONFIG_DIR, 'bridge.config.selftest.json');
  const codexToml = path.join(CONFIG_DIR, 'codex-mcp.example.toml');
  for (const file of [exampleConfig, desktopConfig, selftestConfig, codexToml]) {
    assert.equal(fs.existsSync(file), true, `${path.basename(file)} is missing`);
  }

  for (const file of [exampleConfig, desktopConfig, selftestConfig]) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(typeof parsed.stateDir, 'string');
    assert.ok(Array.isArray(parsed.taskFileRoots) && parsed.taskFileRoots.length > 0);
    assert.ok(parsed.workspaces && typeof parsed.workspaces === 'object');
    assert.equal(typeof parsed.runner.command, 'undefined', 'launcher lives under runner.production/fake');
    const raw = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(raw, /sk-[A-Za-z0-9]{10,}/, 'no credential in an example config');
  }

  const toml = fs.readFileSync(codexToml, 'utf8');
  assert.match(toml, /\[mcp_servers\.dsh_bridge\]/);
  assert.match(toml, /--config/);
  assert.match(toml, /startup_timeout_sec/);
  assert.doesNotMatch(toml, /sk-[A-Za-z0-9]{10,}/);
});

test('A18 dependencies are pinned and the build artifact is present', () => {
  const pkg = H.readJson(path.join(H.ROOT, 'package.json'));
  assert.equal(fs.existsSync(path.join(H.ROOT, 'package-lock.json')), true, 'lockfile missing');
  for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
    assert.match(String(version), /^\d+\.\d+\.\d+/, `${name} is not pinned exactly (${version})`);
  }
  for (const [name, version] of Object.entries(pkg.devDependencies ?? {})) {
    assert.match(String(version), /^\d+\.\d+\.\d+/, `${name} is not pinned exactly (${version})`);
  }
  assert.equal(fs.existsSync(path.join(H.ROOT, 'dist', 'src', 'index.js')), true, 'run `npm run build` first');
});

test('A18 reports exist and the source manifest verifies', () => {
  const reportFile = path.join(REPORTS, 'IMPLEMENTATION-REPORT.md');
  const resultsFile = path.join(REPORTS, 'test-results.json');
  const manifestFile = path.join(REPORTS, 'source-manifest.json');
  for (const file of [reportFile, resultsFile, manifestFile]) {
    assert.equal(fs.existsSync(file), true, `${path.basename(file)} is missing`);
  }

  const report = fs.readFileSync(reportFile, 'utf8');
  assert.match(report, /A01/);
  assert.match(report, /待验证|pending/i, 'unverified stages are listed explicitly');
  assert.match(report, /0\.2\.0-rc\.2/, 'the desktop DSH version finding is recorded');

  const results = H.readJson(resultsFile);
  assert.ok(Array.isArray(results.tests) && results.tests.length > 0);
  for (const entry of results.tests) {
    assert.equal(typeof entry.name, 'string');
    assert.ok(['passed', 'failed', 'skipped', 'pending'].includes(entry.result), `bad result ${entry.result}`);
    assert.equal(typeof entry.mocked, 'boolean');
  }
  assert.equal(
    results.tests.some((entry) => entry.mocked === true),
    true,
    'mocked/simulated scope is declared per test',
  );

  const manifest = H.readJson(manifestFile);
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0);
  for (const entry of manifest.files) {
    const file = path.join(H.ROOT, entry.path);
    assert.equal(fs.existsSync(file), true, `manifest lists a missing file: ${entry.path}`);
    const digest = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    assert.equal(digest, entry.sha256, `hash mismatch for ${entry.path}`);
  }
});
