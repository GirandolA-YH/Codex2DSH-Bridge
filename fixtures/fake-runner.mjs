/**
 * Fake DSH child used by the offline test suite.
 *
 * It behaves like `dsh --profile headless "<task>"` from the bridge's point of
 * view: one positional argument carrying the task, output on stdout/stderr, an
 * exit code. Behaviour is selected by `FAKE_*` directive lines inside the task
 * text so that a single configured runner can exercise success, failure,
 * timeout, cancellation, large output and secret redaction.
 *
 * It always echoes the exact bytes it received between markers, which is how the
 * suite proves shell-free, byte-exact task delivery.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const task = process.argv[2] ?? '';
// Survive a broken pipe: when the bridge is killed abruptly the child must stay
// alive so the orphan-recovery policy can be verified with a real process.
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
process.on('uncaughtException', () => {});
// In pointer handoff mode the bridge sends a short pointer instead of the task
// body, so directives are also read from the frozen accepted copy.
const acceptedPath = process.env.DSH_BRIDGE_TASK_FILE ?? '';
let acceptedText = '';
if (acceptedPath !== '' && fs.existsSync(acceptedPath)) {
  try {
    acceptedText = fs.readFileSync(acceptedPath, 'utf8');
  } catch {
    acceptedText = '';
  }
}

function directive(name, fallback = null) {
  const pattern = new RegExp(`^${name}=(.*)$`, 'm');
  const fromTask = pattern.exec(task);
  if (fromTask !== null) return fromTask[1];
  const fromAccepted = pattern.exec(acceptedText);
  return fromAccepted === null ? fallback : fromAccepted[1];
}

const here = path.dirname(fileURLToPath(import.meta.url));

process.stdout.write('<<<PROMPT_BEGIN>>>\n');
process.stdout.write(task);
process.stdout.write('\n<<<PROMPT_END>>>\n');

if (directive('FAKE_PRINT_CWD') === '1') {
  process.stdout.write(`<<<CWD>>>${process.cwd()}\n`);
}
if (directive('FAKE_PRINT_TASKFILE') === '1') {
  const content = acceptedPath === '' ? '<no DSH_BRIDGE_TASK_FILE>' : acceptedText;
  process.stdout.write(`<<<TASKFILE_BEGIN>>>\n${content}\n<<<TASKFILE_END>>>\n`);
}
if (directive('FAKE_PRINT_ENV') === '1') {
  process.stdout.write(`<<<MODE>>>${process.env.DSH_BRIDGE_MODE ?? ''}\n`);
}
if (directive('FAKE_SECRET') === '1') {
  process.stdout.write('api_key=sk-FAKEsecretVALUE0123456789\n');
  process.stdout.write('Authorization: Bearer FAKEBearerTokenVALUE0123456789\n');
  process.stderr.write('password: FAKEPasswordVALUE0123456789\n');
}
const createFile = directive('FAKE_CREATE');
if (createFile !== null && createFile !== '') {
  fs.mkdirSync(path.dirname(path.resolve(createFile)), { recursive: true });
  fs.writeFileSync(path.resolve(createFile), 'created by fake runner\n');
}

const spawnChildFile = directive('FAKE_SPAWN_CHILD');
if (spawnChildFile !== null && spawnChildFile !== '') {
  const child = spawn(process.execPath, [path.join(here, 'fake-grandchild.mjs'), spawnChildFile], {
    env: process.env,
    stdio: 'ignore',
    detached: false,
  });
  process.stdout.write(`<<<CHILD_PID>>>${child.pid ?? -1}\n`);
}

const hogBytes = Number(directive('FAKE_HOG_BYTES', '0'));
if (Number.isFinite(hogBytes) && hogBytes > 0) {
  const lineTerminated = directive('FAKE_HOG_LINED') === '1';
  const chunk = Buffer.alloc(64 * 1024, 'x');
  if (lineTerminated) chunk[chunk.length - 1] = 0x0a;
  let written = 0;
  while (written < hogBytes) {
    process.stdout.write(chunk);
    process.stderr.write(chunk);
    written += chunk.length;
  }
  process.stderr.write('\n');
}

const stderrText = directive('FAKE_STDERR');
if (stderrText !== null && stderrText !== '') {
  process.stderr.write(`${stderrText}\n`);
}

const sleepMs = Number(directive('FAKE_SLEEP_MS', '0'));
const exitCode = Number(directive('FAKE_EXIT', '0'));

const finish = () => {
  process.stdout.write(`<<<FAKE_DONE exit=${Number.isFinite(exitCode) ? exitCode : 0}>>>\n`);
  process.exit(Number.isFinite(exitCode) ? exitCode : 0);
};

if (Number.isFinite(sleepMs) && sleepMs > 0) {
  // Keep the event loop alive; cancellation must kill this via process tree.
  setTimeout(finish, sleepMs);
} else {
  finish();
}
