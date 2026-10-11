/**
 * Read-only access to the bridge state directory.
 *
 * The only things ever opened here are:
 *   - `owner.lock` / `owner.heartbeat.<lockId>` (metadata)
 *   - `jobs/<validated jobId>/job.json` (bounded)
 *   - the *stat* of `jobs/<validated jobId>/stdout.log` and `stderr.log`
 *
 * `task.accepted.md`, the `requests/` index, bridge config and DSH home are not
 * referenced by any code path in this project.
 */
import fs from 'node:fs';
import {
  JOB_FILE_NAME,
  JOBS_DIR_NAME,
  LOG_FILE_NAMES,
  resolveRoot,
  safeResolve,
  normalizeFsCode,
} from './paths.mjs';
import { isValidJobId } from './constants.mjs';
import { readJsonBounded } from './jsonRead.mjs';
import { extractJobRecord } from './jobRecord.mjs';

export function createStateReader(config = {}) {
  const fsImpl = config.fs ?? fs;
  const rootInfo = resolveRoot(config.stateRoot ?? '.');
  const limits = config.limits ?? {};
  const maxJobJsonBytes = Number.isFinite(limits.maxJobJsonBytes) ? limits.maxJobJsonBytes : 256 * 1024;
  const maxJobs = Number.isFinite(limits.maxJobs) ? limits.maxJobs : 50;
  const rootReal = rootInfo.real;

  function listJobIds() {
    const base = {
      ids: [],
      jobDirExists: false,
      errorCode: null,
      ignoredEntries: 0,
      rejectedReparse: 0,
      totalDirectories: 0,
    };

    const jobsDir = safeResolve(rootReal, [JOBS_DIR_NAME]);
    if (!jobsDir.ok) {
      return { ...base, errorCode: jobsDir.code === 'ENOENT' ? null : jobsDir.code };
    }
    if (!jobsDir.stat.isDirectory()) {
      return { ...base, jobDirExists: true, errorCode: 'NOT_A_DIRECTORY' };
    }

    let entries;
    try {
      entries = fsImpl.readdirSync(jobsDir.path, { withFileTypes: true });
    } catch (error) {
      return { ...base, jobDirExists: true, errorCode: normalizeFsCode(error) };
    }

    const ids = [];
    let ignoredEntries = 0;
    let rejectedReparse = 0;
    let totalDirectories = 0;

    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        rejectedReparse += 1;
        continue;
      }
      if (!entry.isDirectory()) {
        ignoredEntries += 1;
        continue;
      }
      totalDirectories += 1;
      if (!isValidJobId(entry.name)) {
        ignoredEntries += 1;
        continue;
      }
      ids.push(entry.name);
    }

    ids.sort();
    return {
      ids,
      jobDirExists: true,
      errorCode: null,
      ignoredEntries,
      rejectedReparse,
      totalDirectories,
    };
  }

  function readJobRecord(jobId) {
    if (!isValidJobId(jobId)) {
      return { ok: false, code: 'INVALID_JOB_ID', reason: 'jobId 不合法，已拒绝' };
    }
    if (!rootInfo.exists) {
      return { ok: false, code: 'ENOENT', reason: '状态根目录不存在' };
    }
    const resolved = safeResolve(rootReal, [JOBS_DIR_NAME, jobId, JOB_FILE_NAME]);
    if (!resolved.ok) {
      if (resolved.code === 'ENOENT') {
        return { ok: false, code: 'ENOENT', reason: 'job.json 不存在' };
      }
      if (resolved.code === 'REPARSE' || resolved.code === 'ESCAPE') {
        return { ok: false, code: resolved.code, reason: '路径越界或为重解析点，已拒绝' };
      }
      return { ok: false, code: resolved.code, reason: 'job.json 不可读' };
    }

    const read = readJsonBounded(resolved.path, maxJobJsonBytes, fsImpl);
    if (!read.ok) {
      return { ok: false, code: read.code, reason: 'job.json 读取失败' };
    }

    const extracted = extractJobRecord(read.value, jobId);
    if (!extracted.ok) {
      return { ok: false, code: extracted.code, reason: extracted.reason };
    }
    return {
      ok: true,
      job: extracted.job,
      warnings: extracted.warnings,
      sizeBytes: read.size,
      mtimeMs: read.mtimeMs,
    };
  }

  function statLog(jobId, name) {
    if (!isValidJobId(jobId) || !LOG_FILE_NAMES.includes(name)) {
      return { exists: false, code: 'INVALID_JOB_ID' };
    }
    const resolved = safeResolve(rootReal, [JOBS_DIR_NAME, jobId, name]);
    if (!resolved.ok) {
      return {
        exists: false,
        code: resolved.code === 'REPARSE' || resolved.code === 'ESCAPE' ? resolved.code : resolved.code,
      };
    }
    if (!resolved.stat.isFile()) return { exists: false, code: 'NOT_A_FILE' };
    return {
      exists: true,
      code: null,
      sizeBytes: resolved.stat.size,
      mtimeMs: resolved.stat.mtimeMs,
    };
  }

  return {
    rootInfo,
    limits: { maxJobJsonBytes, maxJobs },
    listJobIds,
    readJobRecord,
    statLog,
  };
}
