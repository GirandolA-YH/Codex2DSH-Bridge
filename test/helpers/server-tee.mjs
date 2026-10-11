/**
 * Test-side wrapper: runs the bridge as a child process and tees its raw stdout
 * and stderr to files.
 *
 * The MCP client still talks to the wrapper, so the protocol stream is
 * unchanged — but the suite can afterwards prove that stdout carried only
 * JSON-RPC frames and no log lines.
 *
 * The server pid is written to SERVER_PID_FILE so a test can kill the bridge
 * abruptly to exercise restart recovery.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const args = process.argv.slice(2);
const stdoutLog = process.env.SERVER_STDOUT_LOG ?? '';
const stderrLog = process.env.SERVER_STDERR_LOG ?? '';
const pidFile = process.env.SERVER_PID_FILE ?? '';

if (stdoutLog !== '') fs.writeFileSync(stdoutLog, '');
if (stderrLog !== '') fs.writeFileSync(stderrLog, '');

const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
if (pidFile !== '' && child.pid !== undefined) fs.writeFileSync(pidFile, String(child.pid));

child.stdout.on('data', (chunk) => {
  if (stdoutLog !== '') fs.appendFileSync(stdoutLog, chunk);
  process.stdout.write(chunk);
});
child.stderr.on('data', (chunk) => {
  if (stderrLog !== '') fs.appendFileSync(stderrLog, chunk);
  process.stderr.write(chunk);
});
child.on('exit', (code) => {
  process.exit(code ?? 0);
});

process.stdin.pipe(child.stdin);
