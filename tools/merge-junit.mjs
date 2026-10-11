/**
 * Merge several JUnit XML reports into one `reports/junit.xml`.
 *
 * Needed only where the normal entry point cannot run: `tools/run-tests.mjs`
 * asks Node's test runner to spawn one child process per test file, and a
 * restricted sandbox denies pipe-stdio spawns (EPERM). Running each file as a
 * plain script keeps `node:test` in-process, and `--test-reporter=junit` then
 * produces one XML per file; this tool concatenates them so
 * `tools/collect-test-results.mjs` can consume the result unchanged.
 *
 * The merge is byte-faithful for `<testcase>` elements (including their
 * `<failure>` bodies) and refuses to invent results: if an input file cannot be
 * read, the tool fails instead of silently reporting fewer tests.
 *
 * Usage:
 *   node tools/merge-junit.mjs <inputDir> [outputFile]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inputDir = process.argv[2] ?? path.join(ROOT, 'test', '.tmp', 'junit');
const output = process.argv[3] ?? path.join(ROOT, 'reports', 'junit.xml');

if (!fs.existsSync(inputDir)) {
  process.stderr.write(`merge-junit: input directory does not exist: ${inputDir}\n`);
  process.exit(2);
}

const inputs = fs
  .readdirSync(inputDir)
  .filter((name) => name.endsWith('.xml'))
  .sort();
if (inputs.length === 0) {
  process.stderr.write(`merge-junit: no XML reports found under ${inputDir}\n`);
  process.exit(2);
}

const cases = [];
for (const name of inputs) {
  const xml = fs.readFileSync(path.join(inputDir, name), 'utf8');
  const pattern = /<testcase\b[\s\S]*?(?:\/>|<\/testcase>)/g;
  const found = xml.match(pattern) ?? [];
  if (found.length === 0) {
    process.stderr.write(`merge-junit: ${name} contains no <testcase> elements\n`);
    process.exit(2);
  }
  cases.push(...found);
}

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `<?xml version="1.0" encoding="utf-8"?>\n<testsuites>\n${cases.map((entry) => `\t${entry}`).join('\n')}\n</testsuites>\n`);
process.stdout.write(`wrote ${output} (${cases.length} testcases from ${inputs.length} files)\n`);
