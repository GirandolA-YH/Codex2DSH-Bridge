/**
 * 中文模块导读
 * 目录边界检查：把路径规范化后，确认文件确实落在允许的目录里。
 * 不能只用字符串前缀判断，例如 work-other 不是 work 的子目录；目录链接还可能指向范围之外。
 */
/**
 * Path containment checks.
 *
 * IMPORTANT BOUNDARY (see README): these checks decide *what the bridge hands to
 * the runner*. They are not an operating-system sandbox. A DSH child process
 * still runs with the bridge's own OS user and can, in principle, reach paths
 * outside the configured directories. Round 1 therefore combines these checks
 * with one-shot audit snapshots and change detection, and never claims OS-level
 * read-only isolation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BridgeError } from './errors.js';

/**
 * Canonicalize a path for containment checks.
 *
 * The longest existing prefix is resolved with `realpath`, which also resolves
 * junctions/symlinks and repairs Windows short/long-name and case differences.
 * A non-existent suffix is appended verbatim, so a not-yet-created target under
 * an allowed root still validates.
 */
/**
 * 把路径转成可比较的真实路径；路径不存在时逐层处理父目录，兼顾待创建路径的边界检查。
 */
export function canonicalizeForCheck(target: string): string {
  const absolute = path.resolve(target);
  const suffix: string[] = [];
  let current = absolute;
  for (;;) {
    if (fs.existsSync(current)) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    suffix.unshift(path.basename(current));
    current = parent;
  }
  let resolved: string;
  try {
    resolved = fs.realpathSync.native(current);
  } catch {
    resolved = current;
  }
  return suffix.length === 0 ? resolved : path.join(resolved, ...suffix);
}

/** True when `target` is `root` itself or lies underneath it (segment based). */
/**
 * 使用相对路径判断父子关系，防止同名前缀或不同盘符造成误判。
 */
export function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  if (relative === '') return true;
  if (path.isAbsolute(relative)) return false;
  return !relative.startsWith('..');
}

/**
 * 通过目录边界检查后的目标路径信息。
 */
export interface ContainedPathResult {
  /** Canonical path that passed the check. */
  path: string;
  /** Canonical root it was matched against. */
  root: string;
}

/**
 * Assert that `target` lives under one of `roots`.
 *
 * Rejects: `..` traversal, absolute escapes, junctions/symlinks that resolve
 * outside the roots, and name-prefix confusion (`<root>-evil` is not inside
 * `<root>`) because containment is decided per path segment.
 */
/**
 * 核对目标路径确实在已允许的目录内；需要现有文件时也检查其存在性。
 */
export function assertWithinRoots(
  roots: readonly string[],
  target: string,
  context: { code?: 'PATH_NOT_ALLOWED'; label: string; requireExists?: boolean },
): ContainedPathResult {
  if (typeof target !== 'string' || target.trim() === '') {
    throw new BridgeError('INVALID_ARGUMENT', `${context.label} must be a non-empty string`);
  }
  const canonicalRoots = roots.map((root) => canonicalizeForCheck(root));
  const canonicalTarget = canonicalizeForCheck(target);
  for (const root of canonicalRoots) {
    if (isWithin(root, canonicalTarget)) {
      if (context.requireExists === true && !fs.existsSync(canonicalTarget)) {
        throw new BridgeError('TASK_FILE_NOT_FOUND', `${context.label} does not exist`, {
          taskFile: canonicalTarget,
        });
      }
      return { path: canonicalTarget, root };
    }
  }
  throw new BridgeError('PATH_NOT_ALLOWED', `${context.label} is outside every allowed directory`, {
    resolved: canonicalTarget,
    allowedRoots: canonicalRoots,
  });
}
