/**
 * Convert the JUnit report of a test run into `reports/test-results.json`.
 *
 * The output records, per test: name, file, acceptance item(s), result, the
 * exact command, duration, environment and — explicitly — whether the test was
 * simulated (fake child process) and what that simulation covers. Nothing is
 * reported as a real model call.
 *
 * Node's JUnit reporter writes flat `<testcase>` elements carrying a `file`
 * attribute, so no suite nesting has to be reconstructed.
 *
 * Usage:
 *   node tools/run-tests.mjs                 # writes reports/junit.xml + last-run.json
 *   node tools/collect-test-results.mjs [--junit <xml>] [--command <cmd>]
 *        [--started-at <iso>] [--duration-ms <n>] [--exit-code <n>] [--note <text>]…
 *
 * `--note` appends an environment note (repeatable). It exists so a run that
 * could not use the normal entry point can say so in the record instead of
 * presenting itself as a plain `npm test` run.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = {
    junit: path.join(ROOT, 'reports', 'junit.xml'),
    command: 'npm test',
    startedAt: null,
    durationMs: null,
    exitCode: null,
    notes: [],
  };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === '--junit') out.junit = value;
    else if (key === '--command') out.command = value;
    else if (key === '--started-at') out.startedAt = value;
    else if (key === '--duration-ms') out.durationMs = Number(value);
    else if (key === '--exit-code') out.exitCode = Number(value);
    else if (key === '--note') out.notes.push(value);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

const decodeXml = (text) =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#10;/g, '\n')
    .replace(/&amp;/g, '&');

function attribute(attributes, name) {
  const found = new RegExp(`${name}="([^"]*)"`).exec(attributes);
  return found === null ? null : decodeXml(found[1]);
}

function parseJUnit(xml) {
  const cases = [];
  const casePattern = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let match;
  while ((match = casePattern.exec(xml)) !== null) {
    const attributes = match[1];
    const body = match[3] ?? '';
    const failure = /<failure\b[^>]*message="([^"]*)"/.exec(body);
    cases.push({
      name: attribute(attributes, 'name') ?? '<unnamed>',
      file: attribute(attributes, 'file'),
      className: attribute(attributes, 'classname'),
      timeSeconds: Number(attribute(attributes, 'time') ?? '0'),
      failed: /<failure\b/.test(body),
      skipped: /<skipped\b/.test(body),
      failureMessage: failure === null ? null : decodeXml(failure[1]),
    });
  }
  return cases;
}

function relativeFile(file) {
  if (file === null || file === '') return null;
  const normalised = file.replace(/\\/g, '/');
  // The entry point reports `<root>/test/x.test.mjs`; a per-file run from a
  // scratch directory reports `<root>/test/.tmp/<dir>/x.test.mjs`. Both must
  // resolve to the same `test/...` path.
  const marker = normalised.lastIndexOf('/test/');
  if (marker >= 0) return normalised.slice(marker + 1);
  const first = normalised.indexOf('test/');
  return first >= 0 ? normalised.slice(first) : normalised;
}

function acceptanceItems(name) {
  return [...new Set([...name.matchAll(/\bA(\d{2})\b/g)].map((entry) => `A${entry[1]}`))];
}

const MOCKED_SCOPE =
  'fake child process (fixtures/fake-runner.mjs): success, failure, timeout, cancellation, descendants, large output and secret fixtures — no model call and no real DSH run';
const UNIT_SCOPE = 'pure in-process functions; no subprocess, no model call';
const READONLY_PROTOCOL_SCOPE = 'real MCP protocol over stdio with a live bridge process; the DSH child is the fake runner — no model call';
const READONLY_INSPECT_SCOPE = 'read-only inspection of installed DSH files and the app.asar archive; no process started, no model call';
const ARTIFACT_SCOPE = 'artifact and documentation checks only; no subprocess, no model call';
const BLOCKED_SCOPE =
  'NOT EXECUTED IN THIS ENVIRONMENT: this testcase needs a real subprocess (a live MCP stdio bridge or a second bridge), and the sandbox denied spawning one (EPERM). It was not run; no model call was made and no result is claimed for it.';

/**
 * A testcase whose failure is "could not spawn at all" proves nothing about the
 * bridge, so it must not be reported with the simulation scope of a test that
 * actually ran a fake child. The distinction is recorded per testcase.
 */
function couldNotRun(failureMessage) {
  if (typeof failureMessage !== 'string' || failureMessage === '') return false;
  return /EPERM/.test(failureMessage) && /spawn/i.test(failureMessage);
}

function classify(file, name) {
  if (file === null) return { mocked: true, scope: MOCKED_SCOPE };
  if (/22-r4-persistence|23-r4-contracts|24-r4-audit-risks/.test(file)) {
    if (/native/.test(name)) return { mocked: true, scope: 'native Windows processes and offline stdio where named; fixed fake child only; state-write faults injected where named; no DSH/model call' };
    if (/simulated|injected/.test(name)) return { mocked: true, scope: 'in-process controlled runner or targeted filesystem fault injection; no OS child or model call' };
    return { mocked: false, scope: 'pure functions or local filesystem checks; no subprocess/model call' };
  }
  if (file.endsWith('00-units.test.mjs')) return { mocked: false, scope: UNIT_SCOPE };
  if (file.endsWith('08-deliverables.test.mjs')) return { mocked: false, scope: ARTIFACT_SCOPE };
  if (file.endsWith('01-protocol-and-environment.test.mjs')) {
    if (/raw stdio/.test(name)) return { mocked: false, scope: READONLY_PROTOCOL_SCOPE };
    if (/real MCP protocol round trip/.test(name)) return { mocked: true, scope: MOCKED_SCOPE };
    return { mocked: false, scope: READONLY_INSPECT_SCOPE };
  }
  return { mocked: true, scope: MOCKED_SCOPE };
}

const xml = fs.readFileSync(args.junit, 'utf8');
const tests = parseJUnit(xml).map((entry) => {
  const file = relativeFile(entry.file);
  const classified = classify(file, entry.name);
  const blocked = couldNotRun(entry.failureMessage);
  return {
    name: entry.name,
    file,
    acceptanceItems: acceptanceItems(entry.name),
    result: entry.failed ? 'failed' : entry.skipped ? 'skipped' : 'passed',
    command: args.command,
    durationMs: Math.round(entry.timeSeconds * 1000),
    mocked: blocked ? false : classified.mocked,
    mockedScope: blocked ? BLOCKED_SCOPE : classified.scope,
    failureMessage: entry.failureMessage,
  };
});

let powershell = null;
try {
  powershell = execFileSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' }).trim();
} catch {
  powershell = null;
}

const results = {
  schema: 'dsh-codex-bridge/test-results/v1',
  generatedAt: new Date().toISOString(),
  runStartedAt: args.startedAt,
  runDurationMs: Number.isFinite(args.durationMs) ? args.durationMs : null,
  command: args.command,
  exitCode: Number.isFinite(args.exitCode) ? args.exitCode : null,
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    powershell,
    cwd: ROOT,
  },
  summary: {
    total: tests.length,
    passed: tests.filter((test) => test.result === 'passed').length,
    failed: tests.filter((test) => test.result === 'failed').length,
    skipped: tests.filter((test) => test.result === 'skipped').length,
    simulated: tests.filter((test) => test.mocked).length,
    realModelCalls: 0,
  },
  notes: [
    'Every simulated test uses fixtures/fake-runner.mjs: no real model call, no real DSH headless run and no Codex integration took place.',
    'The real MCP protocol round trip and the raw-stdio framing check speak the real MCP protocol over real stdio child processes; only the DSH child is simulated.',
    'The A01 checks read installed DSH package metadata and parse the desktop app.asar read-only.',
    ...args.notes,
  ],
  tests,
};

const output = path.join(ROOT, 'reports', 'test-results.json');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(results, null, 2)}\n`);
process.stdout.write(
  `wrote ${output}: ${results.summary.total} tests, ${results.summary.passed} passed, ${results.summary.failed} failed, ${results.summary.skipped} skipped, ${results.summary.simulated} simulated\n`,
);
if (results.summary.failed > 0) process.exitCode = 1;
