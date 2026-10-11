/**
 * Read-only inspector for an Electron `app.asar` archive.
 *
 * The desktop DeepSeek Harness ships its DSH code inside `resources/app.asar`
 * (a plain file, not a directory), so the runtime's real version and CLI surface
 * can only be read by parsing the archive header. This tool never writes next to
 * the archive; it prints a listing or extracts selected entries into the bridge's
 * own `reports/asar-snapshot/` directory for evidence.
 *
 * Usage:
 *   node tools/inspect-asar.mjs list  <asar> [prefix]
 *   node tools/inspect-asar.mjs read  <asar> <entryPath>
 *   node tools/inspect-asar.mjs dump  <asar> <entryPath> <outFile>
 */
import fs from 'node:fs';
import path from 'node:path';

function parseHeader(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const sizeBuffer = Buffer.alloc(16);
    fs.readSync(fd, sizeBuffer, 0, 16, 0);
    // Electron asar layout: a Pickle holding the header payload size, then the
    // JSON header. Empirically: jsonSize = u32@4 - 8, JSON starts at byte 16,
    // and file data starts right after the JSON (8 + u32@4).
    const headerPickleSize = sizeBuffer.readUInt32LE(4);
    const jsonSize = headerPickleSize - 8;
    const jsonStart = 16;
    const headerBuffer = Buffer.alloc(jsonSize);
    fs.readSync(fd, headerBuffer, 0, jsonSize, jsonStart);
    const json = headerBuffer.toString('utf8').replace(/\0+$/, '').trim();
    return { header: JSON.parse(json), dataOffset: 8 + headerPickleSize, fd };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function findEntry(header, entryPath) {
  const parts = entryPath.split('/').filter((part) => part !== '');
  let node = header;
  for (const part of parts) {
    if (node.files === undefined || node.files[part] === undefined) return null;
    node = node.files[part];
  }
  return node;
}

function walk(node, prefix, out) {
  if (node.files === undefined) return;
  for (const [name, child] of Object.entries(node.files)) {
    const rel = `${prefix}/${name}`;
    if (child.files !== undefined) walk(child, rel, out);
    else out.push({ path: rel, size: Number(child.size ?? 0) });
  }
}

function readEntry(asarPath, fd, dataOffset, entry) {
  if (entry.offset === undefined) return null;
  const offset = Number(entry.offset);
  const size = Number(entry.size);
  const buffer = Buffer.alloc(size);
  fs.readSync(fd, buffer, 0, size, dataOffset + offset);
  return buffer;
}

const [mode, asarPath, ...rest] = process.argv.slice(2);
if (mode === undefined || asarPath === undefined) {
  process.stderr.write('usage: inspect-asar.mjs list|read|dump <asar> [args]\n');
  process.exit(2);
}
const { header, dataOffset, fd } = parseHeader(asarPath);
try {
  if (mode === 'list') {
    const prefix = rest[0] ?? '';
    const entries = [];
    const start = findEntry(header, prefix);
    if (start === null) {
      process.stderr.write(`no such prefix: ${prefix}\n`);
      process.exit(1);
    }
    if (start.files === undefined) {
      process.stdout.write(`${prefix} (file, ${start.size} bytes)\n`);
    } else {
      walk(start, prefix, entries);
      entries.sort((a, b) => (a.path < b.path ? -1 : 1));
      for (const entry of entries.slice(0, 200000)) process.stdout.write(`${entry.size}\t${entry.path}\n`);
      process.stdout.write(`# ${entries.length} files\n`);
    }
  } else if (mode === 'read') {
    const entry = findEntry(header, rest[0]);
    if (entry === null) {
      process.stderr.write(`no such entry: ${rest[0]}\n`);
      process.exit(1);
    }
    const buffer = readEntry(asarPath, fd, dataOffset, entry);
    process.stdout.write(buffer === null ? '<directory>\n' : buffer.toString('utf8'));
  } else if (mode === 'dump') {
    const entry = findEntry(header, rest[0]);
    if (entry === null) {
      process.stderr.write(`no such entry: ${rest[0]}\n`);
      process.exit(1);
    }
    const buffer = readEntry(asarPath, fd, dataOffset, entry);
    fs.mkdirSync(path.dirname(rest[1]), { recursive: true });
    fs.writeFileSync(rest[1], buffer);
    process.stdout.write(`wrote ${rest[1]} (${buffer.length} bytes)\n`);
  } else {
    process.stderr.write(`unknown mode: ${mode}\n`);
    process.exit(2);
  }
} finally {
  fs.closeSync(fd);
}
