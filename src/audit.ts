/**
 * 中文模块导读
 * 审计输入准备：按统一筛选规则复制一份固定源码快照，再计算内容指纹。
 * 复制范围与指纹范围要一致；否则审计者看到的文件可能没有受到变化检查。
 * 快照用于固定输入和事后检查，不是操作系统沙箱；同一系统用户仍可能访问其他路径。
 */
/**
 * Audit isolation helpers (FIX-001 R02).
 *
 * `audit` never runs in the implementation directory. Each audit job gets a
 * fresh one-shot copy of the source tree (the snapshot), the child runs with the
 * snapshot as cwd, and both the source and the snapshot are hashed before and
 * after the run. If either moved, the audit is reported as failed — the bridge
 * never claims a clean read-only audit it cannot prove.
 *
 * The copy and the manifest share one compiled policy, so the set of files the
 * auditor can see is exactly the set covered by change detection. Credentials,
 * real configuration, previous implementation sessions and earlier reviewer
 * conclusions are denied by default; if the policy selects nothing, the audit is
 * refused instead of running against an empty or unverifiable snapshot.
 *
 * This is *not* an OS sandbox: the child still runs as the same OS user and
 * could reach other paths. See README "Known boundaries".
 */
import fs from 'node:fs';
import path from 'node:path';
import { BridgeError } from './errors.js';
import { ensureDir } from './atomic.js';
import { buildManifest, compilePolicy, diffManifests, type CompiledPolicy, type Manifest, type ManifestDiff } from './hashing.js';
import type { ManifestSummary } from './types.js';

/**
 * 快照筛选规则、最多文件数和最多字节数。
 */
export interface SnapshotLimits {
  /** Allowlist globs; empty means "everything not denied". */
  include?: readonly string[];
  /** Deny globs; always win over include. */
  exclude: readonly string[];
  maxFiles: number;
  maxBytes: number;
}

/**
 * 从快照限制中生成统一的文件筛选规则。
 */
export function policyOf(limits: SnapshotLimits): CompiledPolicy {
  return compilePolicy({ include: limits.include, exclude: limits.exclude });
}

/**
 * 计算审计目录的清单；把扫描/容量问题转成快照失败错误，不把失败当成空清单。
 */
export function manifestOf(dir: string, limits: SnapshotLimits): Manifest {
  try {
    return buildManifest(dir, {
      include: limits.include,
      exclude: limits.exclude,
      maxFiles: limits.maxFiles,
      maxBytes: limits.maxBytes,
    });
  } catch (error) {
    const marker = (error as { manifestLimit?: string }).manifestLimit;
    throw new BridgeError('SNAPSHOT_FAILED', `cannot build manifest for ${dir}: ${error instanceof Error ? error.message : String(error)}`, {
      dir,
      limit: marker ?? null,
    });
  }
}

/**
 * 保存清单摘要、文件数、总字节和记录时间，方便状态查询。
 */
export function summarizeManifest(manifest: Manifest): ManifestSummary {
  return {
    digest: manifest.digest,
    fileCount: manifest.fileCount,
    totalBytes: manifest.totalBytes,
    capturedAt: new Date().toISOString(),
  };
}

/**
 * 本次复制的范围、计数和内容清单。
 */
export interface SnapshotResult {
  manifest: Manifest;
  copiedFiles: number;
  copiedBytes: number;
  copiedPaths: string[];
  excludedByRule: number;
  skippedReparsePoints: number;
  capturedAt: string;
  policy: {
    include: readonly string[];
    exclude: readonly string[];
    mode: 'deny-list' | 'allowlist';
  };
}

/**
 * Replace the snapshot directory with a fresh, policy-filtered copy of the
 * source tree. Copy and manifest use the same compiled policy.
 */
/**
 * 清空指定快照目录，再复制被规则选中的文件，并检查复制范围与指纹范围一致。快照目录必须在配置阶段与实施目录分离。
 */
export function refreshSnapshot(sourceDir: string, snapshotDir: string, limits: SnapshotLimits): SnapshotResult {
  if (!fs.existsSync(sourceDir)) {
    throw new BridgeError('SNAPSHOT_FAILED', `audit source directory does not exist: ${sourceDir}`, { sourceDir });
  }
  const policy = policyOf(limits);
  const copiedPaths: string[] = [];
  let copiedBytes = 0;
  let skippedReparsePoints = 0;
  let excludedByRule = 0;

  const walk = (src: string, dst: string, relDir: string): void => {
    ensureDir(dst);
    const entries = fs.readdirSync(src, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      const from = path.join(src, entry.name);
      const to = path.join(dst, entry.name);
      let stats: fs.Stats;
      try {
        stats = fs.lstatSync(from);
      } catch {
        excludedByRule += 1;
        continue;
      }
      if (stats.isSymbolicLink()) {
        skippedReparsePoints += 1;
        continue;
      }
      if (stats.isDirectory()) {
        if (!policy.descends(rel, entry.name)) {
          excludedByRule += 1;
          continue;
        }
        walk(from, to, rel);
        continue;
      }
      if (!stats.isFile()) {
        excludedByRule += 1;
        continue;
      }
      if (!policy.selects(rel, entry.name)) {
        excludedByRule += 1;
        continue;
      }
      if (copiedPaths.length + 1 > limits.maxFiles) {
        throw new BridgeError('SNAPSHOT_FAILED', `snapshot exceeds maxSnapshotFiles=${limits.maxFiles}`, { source: sourceDir });
      }
      copiedBytes += stats.size;
      if (copiedBytes > limits.maxBytes) {
        throw new BridgeError('SNAPSHOT_FAILED', `snapshot exceeds maxSnapshotBytes=${limits.maxBytes}`, { source: sourceDir });
      }
      fs.copyFileSync(from, to);
      copiedPaths.push(rel);
    }
  };

  try {
    fs.rmSync(snapshotDir, { recursive: true, force: true });
  } catch (error) {
    throw new BridgeError('SNAPSHOT_FAILED', `cannot clear snapshot directory: ${error instanceof Error ? error.message : String(error)}`, {
      snapshotDir,
    });
  }

  walk(sourceDir, snapshotDir, '');

  if (copiedPaths.length === 0) {
    throw new BridgeError('SNAPSHOT_FAILED', 'the snapshot policy selected no files; refusing to run an unverifiable audit', {
      sourceDir,
      include: [...(limits.include ?? [])],
      exclude: [...limits.exclude],
    });
  }

  const manifest = manifestOf(snapshotDir, limits);
  const copiedSet = new Set(copiedPaths);
  const manifestSet = new Set(manifest.files.map((file) => file.path));
  const missing = [...copiedSet].filter((rel) => !manifestSet.has(rel));
  const unexpected = [...manifestSet].filter((rel) => !copiedSet.has(rel));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new BridgeError('SNAPSHOT_FAILED', 'snapshot copy and snapshot manifest disagree; refusing an audit with undetected input', {
      copiedButUnhashed: missing.slice(0, 20),
      hashedButNotCopied: unexpected.slice(0, 20),
    });
  }

  copiedPaths.sort();
  return {
    manifest,
    copiedFiles: copiedPaths.length,
    copiedBytes,
    copiedPaths,
    excludedByRule,
    skippedReparsePoints,
    capturedAt: new Date().toISOString(),
    policy: { include: limits.include ?? [], exclude: limits.exclude, mode: policy.mode },
  };
}

/**
 * 前后清单比较结果，表示内容稳定性而非功能正确性。
 */
export interface StabilityCheck {
  stable: boolean;
  diff: ManifestDiff;
  after: Manifest;
}

/**
 * 重新计算清单，与开始时的清单比较，判断选定内容是否发生变化。
 */
export function checkStability(before: Manifest, dir: string, limits: SnapshotLimits): StabilityCheck {
  const after = manifestOf(dir, limits);
  const diff = diffManifests(before, after);
  return { stable: diff.same, diff, after };
}
