/**
 * Workspace whitelist + local display-name mapping.
 *
 * The browser can never influence which directory is observed. The root comes
 * from the operator's config file only, and a job is matched by its `jobId`
 * override first, then by its `workspaceId`.
 */
import { JOB_ID_PATTERN, MAX_DISPLAY_NAME_LENGTH } from './constants.mjs';

const WORKSPACE_ID = /^[A-Za-z0-9._-]{1,64}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

export function sanitizeDisplayName(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(CONTROL_CHARS, '').trim();
  if (cleaned === '') return null;
  return cleaned.length > MAX_DISPLAY_NAME_LENGTH
    ? `${cleaned.slice(0, MAX_DISPLAY_NAME_LENGTH)}…`
    : cleaned;
}

export function createWorkspaceMap(config = {}) {
  const byWorkspaceId = new Map();
  const byJobId = new Map();
  const names = new Map();
  const workspaceNames = new Map();
  const rejected = [];

  const rawWorkspaces = config.byWorkspaceId;
  if (rawWorkspaces !== undefined) {
    if (typeof rawWorkspaces !== 'object' || rawWorkspaces === null || Array.isArray(rawWorkspaces)) {
      rejected.push({ kind: 'byWorkspaceId', reason: '必须是对象' });
    } else {
      for (const [key, value] of Object.entries(rawWorkspaces)) {
        if (!WORKSPACE_ID.test(key) || typeof value !== 'string' || value.trim() === '') {
          rejected.push({ kind: 'byWorkspaceId', reason: '条目非法，已忽略' });
          continue;
        }
        byWorkspaceId.set(key, value);
      }
    }
  }

  const rawJobs = config.byJobId;
  if (rawJobs !== undefined) {
    if (typeof rawJobs !== 'object' || rawJobs === null || Array.isArray(rawJobs)) {
      rejected.push({ kind: 'byJobId', reason: '必须是对象' });
    } else {
      for (const [key, value] of Object.entries(rawJobs)) {
        if (!JOB_ID_PATTERN.test(key) || typeof value !== 'string' || value.trim() === '') {
          rejected.push({ kind: 'byJobId', reason: '条目非法，已忽略' });
          continue;
        }
        byJobId.set(key, value);
      }
    }
  }

  const rawNames = config.names;
  if (rawNames !== undefined && rawNames !== null && typeof rawNames === 'object' && !Array.isArray(rawNames)) {
    for (const [key, value] of Object.entries(rawNames)) {
      const name = sanitizeDisplayName(value);
      if (!JOB_ID_PATTERN.test(key) || name === null) continue;
      names.set(key, name);
    }
  }

  const rawWorkspaceNames = config.workspaceNames;
  if (
    rawWorkspaceNames !== undefined &&
    rawWorkspaceNames !== null &&
    typeof rawWorkspaceNames === 'object' &&
    !Array.isArray(rawWorkspaceNames)
  ) {
    for (const [key, value] of Object.entries(rawWorkspaceNames)) {
      const name = sanitizeDisplayName(value);
      if (!WORKSPACE_ID.test(key) || name === null) continue;
      workspaceNames.set(key, name);
    }
  }

  const configured = byWorkspaceId.size > 0 || byJobId.size > 0;

  function resolve(job) {
    const jobId = job?.jobId;
    const workspaceId = job?.workspaceId ?? null;

    if (typeof jobId === 'string' && byJobId.has(jobId)) {
      return { configured: true, root: byJobId.get(jobId), match: 'byJobId', label: `按作业覆盖（${jobId}）` };
    }
    if (typeof workspaceId === 'string' && byWorkspaceId.has(workspaceId)) {
      return {
        configured: true,
        root: byWorkspaceId.get(workspaceId),
        match: 'byWorkspaceId',
        label: `按工作区映射（${workspaceId}）`,
      };
    }
    return { configured: false, root: null, match: 'none', label: '未配置交付目录' };
  }

  function displayName(job) {
    const byJob = typeof job?.jobId === 'string' ? names.get(job.jobId) : undefined;
    if (byJob !== undefined) return { name: byJob, source: 'jobId-mapping' };
    const workspaceId = job?.workspaceId;
    const byWorkspace = typeof workspaceId === 'string' ? workspaceNames.get(workspaceId) : undefined;
    if (byWorkspace !== undefined) return { name: byWorkspace, source: 'workspace-mapping' };
    return { name: null, source: 'derived' };
  }

  return {
    configured,
    byWorkspaceId,
    byJobId,
    names,
    workspaceNames,
    rejected,
    resolve,
    displayName,
  };
}
