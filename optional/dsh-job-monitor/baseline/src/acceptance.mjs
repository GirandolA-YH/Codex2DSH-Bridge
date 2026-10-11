/**
 * Independent acceptance ledger (operator supplied, read-only).
 *
 * The verdict is *never* inferred from exit code 0, from a report file existing,
 * or from log text. If the ledger is absent, unreadable, or has no entry for a
 * job, the verdict is `none` -> "未提供验收记录".
 *
 * Only `status` (pass/fail/pending) and a validated date are copied out; any
 * note, path, reviewer name or free text in the ledger is dropped.
 */
import fs from 'node:fs';
import path from 'node:path';
import { JOB_ID_PATTERN } from './constants.mjs';
import { readJsonBounded, isPlainObject } from './jsonRead.mjs';
import { normalizeFsCode } from './paths.mjs';

const STATUSES = new Set(['pass', 'fail', 'pending']);
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_PREFIX = /^\d{4}-\d{2}-\d{2}T/;

function dateOrNull(value) {
  if (typeof value !== 'string') return null;
  if (DATE_ONLY.test(value) || ISO_PREFIX.test(value)) {
    if (!Number.isNaN(Date.parse(value))) return value;
  }
  return null;
}

export function createAcceptanceReader(config = {}) {
  const configuredPath = typeof config.path === 'string' && config.path !== '' ? config.path : null;
  const maxBytes = Number.isFinite(config.maxBytes) ? config.maxBytes : 512 * 1024;
  const fsImpl = config.fs ?? fs;

  if (configuredPath === null) {
    return {
      configured: false,
      path: null,
      read: () => ({
        configured: false,
        readable: false,
        errorCode: null,
        updatedAt: null,
        entryCount: 0,
        invalidEntries: 0,
        ignoredKeys: 0,
        byJobId: new Map(),
        note: '未指定独立验收账本（--acceptance-ledger）',
      }),
    };
  }

  const abs = path.resolve(configuredPath);

  return {
    configured: true,
    path: abs,
    read: () => {
      const base = {
        configured: true,
        readable: false,
        errorCode: null,
        updatedAt: null,
        entryCount: 0,
        invalidEntries: 0,
        ignoredKeys: 0,
        byJobId: new Map(),
        note: null,
      };

      let stat;
      try {
        stat = fsImpl.statSync(abs);
      } catch (error) {
        return { ...base, errorCode: normalizeFsCode(error) };
      }
      if (stat.isDirectory()) return { ...base, errorCode: 'NOT_A_FILE' };

      const read = readJsonBounded(abs, maxBytes, fsImpl);
      if (!read.ok) return { ...base, errorCode: read.code };
      if (!isPlainObject(read.value)) return { ...base, errorCode: 'INVALID_JSON' };
      if (!isPlainObject(read.value.jobs)) return { ...base, errorCode: 'LEDGER_SHAPE_INVALID' };

      const byJobId = new Map();
      let invalidEntries = 0;
      let ignoredKeys = 0;

      for (const [key, value] of Object.entries(read.value.jobs)) {
        if (!JOB_ID_PATTERN.test(key)) {
          ignoredKeys += 1;
          continue;
        }
        if (!isPlainObject(value)) {
          invalidEntries += 1;
          continue;
        }
        const status = typeof value.status === 'string' ? value.status.toLowerCase() : null;
        if (status === null || !STATUSES.has(status)) {
          invalidEntries += 1;
          continue;
        }
        byJobId.set(key, { status, reviewedAt: dateOrNull(value.reviewedAt) });
      }

      return {
        ...base,
        readable: true,
        updatedAt: dateOrNull(read.value.updatedAt),
        entryCount: byJobId.size,
        invalidEntries,
        ignoredKeys,
        byJobId,
      };
    },
  };
}

/** Verdict for one job; never throws and never infers. */
export function acceptanceFor(ledgerRead, jobId) {
  const entry = ledgerRead?.byJobId instanceof Map ? ledgerRead.byJobId.get(jobId) : undefined;
  if (entry === undefined) {
    return {
      status: 'none',
      reviewedAt: null,
      source: ledgerRead?.configured ? 'ledger-missing-entry' : 'no-ledger',
      ledgerReadable: Boolean(ledgerRead?.readable),
      ledgerErrorCode: ledgerRead?.errorCode ?? null,
    };
  }
  return {
    status: entry.status,
    reviewedAt: entry.reviewedAt,
    source: 'ledger',
    ledgerReadable: true,
    ledgerErrorCode: null,
  };
}
