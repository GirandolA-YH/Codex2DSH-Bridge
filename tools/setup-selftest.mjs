/** Generate a credential-free offline config confined to this checkout. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configFile = path.join(root, 'config/bridge.config.json');
if (fs.existsSync(configFile)) {
  process.stderr.write('config/bridge.config.json already exists; inspect it manually. No config was overwritten.\n');
  process.exit(2);
}
const config = JSON.parse(fs.readFileSync(path.join(root, 'config/bridge.config.selftest.json'), 'utf8'));
const base = path.join(root, 'sandbox/selftest');
for (const name of ['state', 'tasks', 'impl', 'audit-snapshot', 'audit-reports']) {
  fs.mkdirSync(path.join(base, name), { recursive: true });
}
config.stateDir = '../sandbox/selftest/state';
config.taskFileRoots = ['../sandbox/selftest/tasks'];
config.workspaces.impl.dir = '../sandbox/selftest/impl';
config.workspaces.audit.dir = '../sandbox/selftest/audit-snapshot';
config.workspaces.audit.audit.reportDir = '../sandbox/selftest/audit-reports';
config.runner.fake.command = process.execPath;
config.runner.production.command = process.execPath;
config._comment = ['Generated offline config; fixed fake runner only, no model calls.', 'All runtime paths are inside this checkout. The absolute Node path is from the process running this generator.'];
fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
const task = path.join(base, 'tasks/demo.md');
if (!fs.existsSync(task)) fs.writeFileSync(task, 'FAKE_EXIT=0\n', { flag: 'wx' });
console.log(JSON.stringify({ configFile, runtimeRoot: base, runner: 'fake', modelJobs: 0 }));
