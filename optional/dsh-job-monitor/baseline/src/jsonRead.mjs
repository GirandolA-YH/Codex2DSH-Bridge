/**
 * Bounded, leak-free JSON reading.
 *
 * Two rules are enforced here and depended on everywhere else:
 *  1. A file above the configured byte cap is never read at all.
 *  2. A parse failure yields a *code*, never the exception text: `JSON.parse`
 *     errors quote a fragment of the input, which could be a credential, a task
 *     body or internal reasoning. That text must not reach an API response.
 */
import fs from 'node:fs';
import { normalizeFsCode } from './paths.mjs';

/**
 * @returns {{ok:true,value:unknown,size:number,mtimeMs:number}}
 *        | {{ok:false,code:string,size?:number}}
 */
export function readJsonBounded(filePath, maxBytes, fsImpl = fs) {
  let stat;
  try {
    stat = fsImpl.statSync(filePath);
  } catch (error) {
    return { ok: false, code: normalizeFsCode(error) };
  }
  if (!stat.isFile()) return { ok: false, code: 'NOT_A_FILE', size: stat.size };
  if (stat.size > maxBytes) return { ok: false, code: 'TOO_LARGE', size: stat.size };

  let text;
  try {
    text = fsImpl.readFileSync(filePath, 'utf8');
  } catch (error) {
    return { ok: false, code: normalizeFsCode(error), size: stat.size };
  }
  // Defensive re-check against a concurrent append.
  if (typeof text === 'string' && Buffer.byteLength(text, 'utf8') > maxBytes) {
    return { ok: false, code: 'TOO_LARGE', size: stat.size };
  }

  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, code: 'INVALID_JSON', size: stat.size };
  }
  return { ok: true, value, size: stat.size, mtimeMs: stat.mtimeMs };
}

/** True for a plain (non-array, non-null) object. */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse a JSON string with the same no-leak guarantee as readJsonBounded. */
export function parseJsonBounded(text, maxBytes) {
  if (typeof text !== 'string') return { ok: false, code: 'INVALID_JSON' };
  if (Buffer.byteLength(text, 'utf8') > maxBytes) return { ok: false, code: 'TOO_LARGE' };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, code: 'INVALID_JSON' };
  }
}
