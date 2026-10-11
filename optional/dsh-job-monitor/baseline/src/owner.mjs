/**
 * Owner-lock heartbeat metadata (read-only).
 *
 * Only the fields needed to answer "is a bridge owning this state directory, and
 * how fresh is its heartbeat" are extracted. `pid` and `hostname` from the raw
 * lock file are deliberately dropped: they are not needed by the panel and are
 * not part of the agreed whitelist.
 */
import { OWNER_LOCK_NAME, safeResolve } from './paths.mjs';
import { readJsonBounded, isPlainObject } from './jsonRead.mjs';
import { LOCK_ID_PATTERN, DEFAULT_STALE_HEARTBEAT_MS } from './constants.mjs';

const ISO_PREFIX = /^\d{4}-\d{2}-\d{2}T/;
const VERSION_PATTERN = /^[A-Za-z0-9.+_-]{1,40}$/;

function isoOrNull(value) {
  if (typeof value !== 'string' || !ISO_PREFIX.test(value)) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

export function readOwner(stateRootReal, options = {}) {
  const now = typeof options.now === 'function' ? options.now() : Date.now();
  const staleAfterMs =
    Number.isFinite(options.staleHeartbeatMs) && options.staleHeartbeatMs > 0
      ? Math.floor(options.staleHeartbeatMs)
      : DEFAULT_STALE_HEARTBEAT_MS;
  const maxBytes = options.maxOwnerBytes ?? 64 * 1024;

  const base = {
    present: false,
    lockId: null,
    startedAt: null,
    bridgeVersion: null,
    heartbeatAt: null,
    heartbeatAgeMs: null,
    stale: null,
    staleAfterMs,
    errorCode: null,
  };

  const lockPath = safeResolve(stateRootReal, [OWNER_LOCK_NAME]);
  if (!lockPath.ok) {
    return { ...base, errorCode: lockPath.code === 'ENOENT' ? null : lockPath.code };
  }

  const read = readJsonBounded(lockPath.path, maxBytes);
  if (!read.ok) return { ...base, errorCode: read.code };
  if (!isPlainObject(read.value)) return { ...base, errorCode: 'INVALID_JSON' };

  const lockId =
    typeof read.value.lockId === 'string' && LOCK_ID_PATTERN.test(read.value.lockId)
      ? read.value.lockId
      : null;

  const bridgeVersion =
    typeof read.value.bridgeVersion === 'string' && VERSION_PATTERN.test(read.value.bridgeVersion)
      ? read.value.bridgeVersion
      : null;

  const result = {
    ...base,
    present: true,
    lockId,
    startedAt: isoOrNull(read.value.startedAt),
    bridgeVersion,
    heartbeatAt: isoOrNull(read.value.heartbeatAt),
  };

  if (lockId === null) {
    return { ...result, errorCode: 'LOCK_ID_INVALID' };
  }

  // Heartbeat sidecar name is derived from the *validated* lock id, never from
  // arbitrary text found in the file.
  const heartbeatPath = safeResolve(stateRootReal, [`owner.heartbeat.${lockId}`]);
  if (!heartbeatPath.ok) {
    return { ...result, errorCode: heartbeatPath.code === 'ENOENT' ? 'HEARTBEAT_MISSING' : heartbeatPath.code };
  }
  const heartbeat = readJsonBounded(heartbeatPath.path, maxBytes);
  if (!heartbeat.ok) {
    return { ...result, errorCode: heartbeat.code === 'ENOENT' ? 'HEARTBEAT_MISSING' : heartbeat.code };
  }
  if (!isPlainObject(heartbeat.value) || heartbeat.value.lockId !== lockId) {
    return { ...result, errorCode: 'HEARTBEAT_LOCK_MISMATCH' };
  }
  const heartbeatAt = isoOrNull(heartbeat.value.heartbeatAt);
  if (heartbeatAt === null) {
    return { ...result, errorCode: 'HEARTBEAT_TIME_INVALID' };
  }
  const ageMs = Math.max(0, now - Date.parse(heartbeatAt));
  return {
    ...result,
    heartbeatAt,
    heartbeatAgeMs: ageMs,
    stale: ageMs > staleAfterMs,
  };
}
