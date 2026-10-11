/**
 * Delivery observation: file metadata only.
 *
 * Contract (M06 / product goal 4):
 *   - the root comes from the operator whitelist, never from record paths,
 *   - only `lstat` metadata (relative name, size, mtime) is reported,
 *   - file *contents* are never opened, so nothing here can be attributed to a
 *     model action or a "PASS" string in a log,
 *   - entries, depth and output lists are capped, and a cap that is hit is
 *     reported instead of silently truncating.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  resolveRoot,
  normalizeFsCode,
} from './paths.mjs';
import {
  SCAN_IGNORED_DIRS,
  SCAN_IGNORED_FILE_SUFFIXES,
  SCAN_IGNORED_FILE_NAMES,
  DEFAULT_LIMITS,
} from './constants.mjs';

const REPORT_HINT = /report|总结|结论/i;

function isReportCandidate(relPath) {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1);
  if (REPORT_HINT.test(base)) return true;
  return relPath.toLowerCase().startsWith('reports/');
}

function ageMsOf(mtimeMs, now) {
  return Math.max(0, now - mtimeMs);
}

export function scanWorkspace(rootInput, options = {}) {
  const now = typeof options.now === 'number' ? options.now : Date.now();
  const fsImpl = options.fs ?? fs;
  const maxEntries = Number.isFinite(options.maxScanEntries)
    ? Math.max(1, Math.floor(options.maxScanEntries))
    : DEFAULT_LIMITS.maxScanEntries;
  const maxDepth = Number.isFinite(options.maxScanDepth)
    ? Math.max(1, Math.floor(options.maxScanDepth))
    : DEFAULT_LIMITS.maxScanDepth;
  const maxRecentFiles = Number.isFinite(options.maxRecentFiles)
    ? Math.max(1, Math.floor(options.maxRecentFiles))
    : DEFAULT_LIMITS.maxRecentFiles;
  const maxReportCandidates = Number.isFinite(options.maxReportCandidates)
    ? Math.max(1, Math.floor(options.maxReportCandidates))
    : DEFAULT_LIMITS.maxReportCandidates;

  const rootInfo = resolveRoot(rootInput);
  const result = {
    ok: false,
    root: rootInfo.configured,
    rootReal: rootInfo.ok ? rootInfo.real : null,
    errorCode: rootInfo.ok ? null : rootInfo.code,
    isReparse: rootInfo.isReparse,
    files: [],
    reportCandidates: [],
    latestMtimeAt: null,
    counts: {
      files: 0,
      dirs: 0,
      entriesVisited: 0,
      ignored: 0,
      rejectedReparse: 0,
    },
    truncated: false,
    truncatedReason: null,
    maxEntries,
    maxDepth,
    ignoredDirs: [...SCAN_IGNORED_DIRS],
    note: '仅基于文件元数据（相对路径 / 大小 / 修改时间），未打开任何文件内容。',
  };

  if (!rootInfo.ok) return result;
  if (rootInfo.isReparse) {
    return { ...result, errorCode: 'REPARSE' };
  }
  if (!rootInfo.isDirectory) {
    return { ...result, errorCode: 'NOT_A_DIRECTORY' };
  }

  let entriesVisited = 0;
  let truncated = false;
  let truncatedReason = null;

  /** @type {Array<{abs:string, rel:string, depth:number}>} */
  const stack = [{ abs: rootInfo.real, rel: '', depth: 0 }];

  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fsImpl.readdirSync(current.abs, { withFileTypes: true });
    } catch (error) {
      if (current.rel === '') {
        return { ...result, errorCode: normalizeFsCode(error) };
      }
      result.counts.ignored += 1;
      continue;
    }
    result.counts.dirs += 1;

    for (const entry of entries) {
      if (entriesVisited >= maxEntries) {
        truncated = true;
        truncatedReason = '达到扫描条目上限';
        break;
      }
      const abs = path.join(current.abs, entry.name);
      const rel = current.rel === '' ? entry.name : `${current.rel}/${entry.name}`;
      entriesVisited += 1;

      if (entry.isSymbolicLink()) {
        result.counts.rejectedReparse += 1;
        continue;
      }

      if (entry.isDirectory()) {
        if (SCAN_IGNORED_DIRS.includes(entry.name.toLowerCase())) {
          result.counts.ignored += 1;
          continue;
        }
        if (current.depth + 1 > maxDepth) {
          result.counts.ignored += 1;
          truncated = true;
          truncatedReason = truncatedReason ?? '达到目录深度上限';
          continue;
        }
        stack.push({ abs, rel, depth: current.depth + 1 });
        continue;
      }

      if (!entry.isFile()) {
        result.counts.ignored += 1;
        continue;
      }
      if (SCAN_IGNORED_FILE_NAMES.includes(entry.name)) {
        result.counts.ignored += 1;
        continue;
      }
      if (SCAN_IGNORED_FILE_SUFFIXES.some((suffix) => entry.name.toLowerCase().endsWith(suffix))) {
        result.counts.ignored += 1;
        continue;
      }

      // Metadata only: never open the file.
      let stat;
      try {
        stat = fsImpl.lstatSync(abs);
      } catch {
        result.counts.ignored += 1;
        continue;
      }
      if (stat.isSymbolicLink() || !stat.isFile()) {
        result.counts.rejectedReparse += 1;
        continue;
      }

      result.counts.files += 1;
      const record = {
        path: rel,
        sizeBytes: stat.size,
        mtimeMs: Math.round(stat.mtimeMs),
        ageMs: ageMsOf(stat.mtimeMs, now),
      };
      result.files.push(record);
      if (result.latestMtimeAt === null || record.mtimeMs > Date.parse(result.latestMtimeAt)) {
        result.latestMtimeAt = new Date(record.mtimeMs).toISOString();
      }
      if (isReportCandidate(rel)) result.reportCandidates.push(record);
    }

    if (truncated && truncatedReason === '达到扫描条目上限') break;
  }

  result.counts.entriesVisited = entriesVisited;
  result.files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
  result.reportCandidates.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
  result.files = result.files.slice(0, maxRecentFiles);
  result.reportCandidates = result.reportCandidates.slice(0, maxReportCandidates);
  result.truncated = truncated;
  result.truncatedReason = truncatedReason;
  result.ok = true;
  return result;
}
