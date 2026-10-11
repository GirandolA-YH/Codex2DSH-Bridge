/**
 * 中文模块导读
 * 文件内容指纹：用 SHA-256 检查内容是否改变，并比较整个文件清单。
 * 哈希是内容的摘要，不是“代码正确”的证明；它只能帮助确认审阅前后看到的是同一份内容。
 * 过滤规则供快照复制和变化检查共用，排除规则优先于包含规则。
 */
/**
 * Hashing, manifests and the single path-matching policy (FIX-001 R02).
 *
 * The same matcher drives the snapshot copy and the snapshot manifest, so a file
 * can never be "visible to the auditor but invisible to change detection".
 *
 * Rule semantics:
 *  - a pattern containing `/` is matched against the root-relative POSIX path;
 *  - any other pattern is matched against the entry basename, so `*.log` and
 *    `.env` behave as expected instead of being literal file names;
 *  - `*` matches within a path segment, `**` matches across segments;
 *  - deny (exclude) always wins over allow (include).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 计算文字或字节的 SHA-256 摘要，同样的内容会得到同样的指纹。
 */
export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * 读取一个文件并计算内容指纹，供清单和快照比较使用。
 */
export function sha256File(file: string): { sha256: string; size: number } {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let size = 0;
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      size += read;
      hash.update(buffer.subarray(0, read));
    }
    return { sha256: hash.digest('hex'), size };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 把通配路径规则转换成可匹配的表达式，让包含/排除规则能统一执行。
 */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i] as string;
    if (char === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') {
          i += 1;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(char)) {
      out += `\\${char}`;
    } else {
      out += char;
    }
  }
  // Copy, manifest, include validation and directory pruning share this rule.
  return new RegExp(`^${out}$`, process.platform === 'win32' ? 'i' : '');
}

/**
 * 用于选择或排除文件的路径规则。
 */
export interface PathPolicy {
  /** Allowlist globs. Empty means "allow everything not denied". */
  include?: readonly string[];
  /** Deny globs. Always evaluated first and always win. */
  exclude?: readonly string[];
}

/**
 * 已预处理的规则，包含遍历目录与选择文件的统一判定。
 */
export interface CompiledPolicy {
  mode: 'deny-list' | 'allowlist';
  include: readonly string[];
  exclude: readonly string[];
  /** True when the path is denied outright. */
  denies(relPath: string, name: string): boolean;
  /** True when the path is selected (deny rules already applied). */
  selects(relPath: string, name: string): boolean;
  /** True when a directory may contain selected files (only deny rules matter). */
  descends(relPath: string, name: string): boolean;
}

/**
 * 预处理一组路径规则，避免扫描每个文件时都重新解释规则。
 */
function compilePatterns(patterns: readonly string[]): Array<(relPath: string, name: string) => boolean> {
  return patterns
    .filter((pattern) => pattern !== '')
    .map((pattern) => {
      const normalised = pattern.replace(/^\.\//, '').replace(/\\/g, '/');
      if (normalised.includes('/')) {
        const regex = globToRegExp(normalised);
        return (relPath: string) => regex.test(relPath);
      }
      const regex = globToRegExp(normalised);
      return (_relPath: string, name: string) => regex.test(name);
    });
}

/**
 * 生成同一套“是否进入目录、是否选择文件”的判断，供复制和指纹计算共同使用。
 */
export function compilePolicy(policy: PathPolicy): CompiledPolicy {
  const include = (policy.include ?? []).filter((entry) => entry !== '');
  const exclude = (policy.exclude ?? []).filter((entry) => entry !== '');
  const denyMatchers = compilePatterns(exclude);
  const includeMatchers = compilePatterns(include);
  const mode: CompiledPolicy['mode'] = include.length > 0 ? 'allowlist' : 'deny-list';
  const denies = (relPath: string, name: string): boolean => denyMatchers.some((matcher) => matcher(relPath, name));
  return {
    mode,
    include,
    exclude,
    denies,
    selects(relPath: string, name: string): boolean {
      if (denyMatchers.some((matcher) => matcher(relPath, name))) return false;
      if (includeMatchers.length === 0) return true;
      return includeMatchers.some((matcher) => matcher(relPath, name));
    },
    descends(relPath: string, name: string): boolean {
      return !denyMatchers.some((matcher) => matcher(relPath, name));
    },
  };
}

/**
 * 一个普通文件的相对路径、大小和内容指纹。
 */
export interface ManifestEntry {
  path: string;
  size: number;
  sha256: string;
}

/**
 * 一组文件的指纹清单及汇总，用于审计前后比较。
 */
export interface Manifest {
  root: string;
  digest: string;
  fileCount: number;
  totalBytes: number;
  skippedReparsePoints: number;
  files: ManifestEntry[];
}

/**
 * 生成清单时使用的筛选与容量约束。
 */
export interface ManifestOptions {
  /** Deny globs. An entry without `/` matches any basename. */
  exclude?: readonly string[];
  /** Allowlist globs; empty means "everything not denied". */
  include?: readonly string[];
  maxFiles?: number;
  maxBytes?: number;
}

/** Build a manifest of `root`, skipping reparse points (never following them). */
/**
 * 扫描被规则选中的普通文件，记录路径、大小和内容指纹；超出数量或字节限制时报告失败。
 */
export function buildManifest(root: string, options: ManifestOptions = {}): Manifest {
  const policy = compilePolicy({ include: options.include, exclude: options.exclude });
  const files: ManifestEntry[] = [];
  let skippedReparsePoints = 0;
  let totalBytes = 0;
  const maxFiles = options.maxFiles ?? Number.POSITIVE_INFINITY;
  const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;

  const walk = (dir: string, relDir: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      const abs = path.join(dir, entry.name);
      let stats: fs.Stats;
      try {
        stats = fs.lstatSync(abs);
      } catch {
        continue;
      }
      if (stats.isSymbolicLink()) {
        skippedReparsePoints += 1;
        continue;
      }
      if (stats.isDirectory()) {
        if (!policy.descends(rel, entry.name)) continue;
        walk(abs, rel);
        continue;
      }
      if (!stats.isFile()) continue;
      if (!policy.selects(rel, entry.name)) continue;
      if (files.length + 1 > maxFiles) {
        throw Object.assign(new Error(`manifest exceeds maxFiles=${maxFiles} under ${root}`), { manifestLimit: 'files' });
      }
      totalBytes += stats.size;
      if (totalBytes > maxBytes) {
        throw Object.assign(new Error(`manifest exceeds maxBytes=${maxBytes} under ${root}`), { manifestLimit: 'bytes' });
      }
      const { sha256 } = sha256File(abs);
      files.push({ path: rel, size: stats.size, sha256 });
    }
  };

  walk(root, '');
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const digest = sha256Hex(files.map((file) => `${file.path}\u0000${file.size}\u0000${file.sha256}`).join('\n'));
  return { root, digest, fileCount: files.length, totalBytes, skippedReparsePoints, files };
}

/**
 * 两份清单的新增、删除、变化列表。
 */
export interface ManifestDiff {
  same: boolean;
  changed: string[];
  added: string[];
  removed: string[];
}

/**
 * 比较两份清单，分开列出新增、删除和内容改变的文件。
 */
export function diffManifests(before: Manifest, after: Manifest): ManifestDiff {
  const beforeMap = new Map(before.files.map((file) => [file.path, file]));
  const afterMap = new Map(after.files.map((file) => [file.path, file]));
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  for (const [rel, entry] of afterMap) {
    const previous = beforeMap.get(rel);
    if (previous === undefined) added.push(rel);
    else if (previous.sha256 !== entry.sha256 || previous.size !== entry.size) changed.push(rel);
  }
  for (const rel of beforeMap.keys()) {
    if (!afterMap.has(rel)) removed.push(rel);
  }
  changed.sort();
  added.sort();
  removed.sort();
  return {
    same: changed.length === 0 && added.length === 0 && removed.length === 0,
    changed,
    added,
    removed,
  };
}
