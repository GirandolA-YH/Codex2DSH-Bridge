/**
 * Filesystem path safety.
 *
 * Contract (M06): every path this panel touches is built from an operator
 * supplied root plus a *validated* segment (a jobId matching
 * `/^job-[0-9a-zA-Z]{6,32}$/`, or a fixed file name). Browser input is never a
 * path. Symlinks / Windows junctions / reparse points are refused, and the
 * canonical (realpath) target must stay inside the canonical root.
 */
import fs from 'node:fs';
import path from 'node:path';

const FS_CODE_PATTERN = /^[A-Z0-9_]{2,40}$/;

/** Normalise an errno into a short stable code; never leak the message. */
export function normalizeFsCode(error) {
  const code = error && typeof error === 'object' ? error.code : null;
  return typeof code === 'string' && FS_CODE_PATTERN.test(code) ? code : 'UNKNOWN';
}

/** Resolve an operator supplied root. A missing root is not an exception here. */
export function resolveRoot(input) {
  const abs = path.resolve(String(input));
  try {
    const real = fs.realpathSync.native(abs);
    let stat = null;
    try {
      stat = fs.lstatSync(abs);
    } catch {
      stat = null;
    }
    const isLink = !samePath(abs, real);
    return {
      ok: true,
      configured: abs,
      real,
      exists: true,
      isDirectory: stat !== null && stat.isDirectory(),
      isReparse: isLink || (stat !== null && stat.isSymbolicLink()),
      code: null,
    };
  } catch (error) {
    return {
      ok: false,
      configured: abs,
      real: abs,
      exists: false,
      isDirectory: false,
      isReparse: false,
      code: normalizeFsCode(error),
    };
  }
}

export function isInside(rootReal, candidateReal) {
  const rel = path.relative(rootReal, candidateReal);
  if (rel === '') return true;
  if (rel.startsWith('..')) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}
/**
 * Join validated segments onto a canonical root and prove the result is a real
 * path inside that root.
 *
 * @returns {{ok:true,path:string,real:string,stat:fs.Stats}}
 *        | {{ok:false,code:string,path:string}}
 */
export function safeResolve(rootReal, segments) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return { ok: false, code: 'ESCAPE', path: rootReal };
  }
  for (const segment of segments) {
    if (typeof segment !== 'string' || segment.length === 0) {
      return { ok: false, code: 'ESCAPE', path: rootReal };
    }
    if (segment.includes('/') || segment.includes('\\') || segment.includes('\0')) {
      return { ok: false, code: 'ESCAPE', path: rootReal };
    }
    if (segment === '.' || segment === '..') {
      return { ok: false, code: 'ESCAPE', path: rootReal };
    }
  }

  const joined = path.join(rootReal, ...segments);

  // Cheap syntactic containment check first (works even if nothing exists).
  if (!isInside(rootReal, path.resolve(joined))) {
    return { ok: false, code: 'ESCAPE', path: joined };
  }

  let real;
  try {
    real = fs.realpathSync.native(joined);
  } catch (error) {
    return { ok: false, code: normalizeFsCode(error), path: joined };
  }

  if (!isInside(rootReal, real)) return { ok: false, code: 'ESCAPE', path: joined, real };
  // A canonical target that differs from the literal join means a link was
  // traversed -- refuse it rather than reporting through it.
  if (!samePath(joined, real)) return { ok: false, code: 'REPARSE', path: joined, real };

  let stat;
  try {
    stat = fs.lstatSync(joined);
  } catch (error) {
    return { ok: false, code: normalizeFsCode(error), path: joined };
  }
  if (stat.isSymbolicLink()) return { ok: false, code: 'REPARSE', path: joined, real };

  return { ok: true, path: joined, real, stat };
}

/** lstat without following links; returns a stable code instead of throwing. */
export function statNoFollow(target) {
  try {
    const stat = fs.lstatSync(target);
    return { ok: true, stat, isReparse: stat.isSymbolicLink() };
  } catch (error) {
    return { ok: false, code: normalizeFsCode(error) };
  }
}

/** Build the fixed log path for a validated job id: <root>/jobs/<jobId>/<name>. */
export const LOG_FILE_NAMES = Object.freeze(['stdout.log', 'stderr.log']);
export const JOB_FILE_NAME = 'job.json';
export const JOBS_DIR_NAME = 'jobs';
export const OWNER_LOCK_NAME = 'owner.lock';
