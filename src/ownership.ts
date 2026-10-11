/**
 * 中文模块导读
 * 状态目录的使用权：避免两个桥实例同时改写同一份任务档案。
 * owner.lock 是使用权凭据，heartbeat 是定期更新的心跳；lockId 用来区分不同次启动。
 * 仲裁锁保护接管和释放操作。仲裁持有者的生死无法判断时，拒绝抢占；不能凭心跳日期就认定进程死亡。
 */
/**
 * State-directory ownership (FIX-001 R04, FIX-002 F2-03, FIX-003 F3-01,
 * FIX-004 F4-01).
 *
 * Layout under the state directory:
 *
 *   owner.lock                 immutable owner identity for the current
 *                              generation: {lockId, pid, hostname, startedAt}
 *   owner.heartbeat.<lockId>   freshness for exactly that generation
 *   owner.arb/                 arbitration lock (directory) + guard.json
 *
 * Invariants that make every interleaving safe:
 *
 *  1. `owner.lock` is written **only** by claim/takeover, only while holding the
 *     arbitration lock, and only after re-reading the current lock inside the
 *     critical section. A paused or resumed operation can therefore never
 *     displace a winner: it either still sees its own identity, or it aborts.
 *  2. A heartbeat never writes a shared path. It writes only its own
 *     `owner.heartbeat.<lockId>` file, and only after verifying that
 *     `owner.lock` still names this handle. An old owner that resumes after a
 *     takeover can at worst refresh a heartbeat that nobody trusts (readers
 *     match it against the lock's lockId), so it cannot affect the winner.
 *  3. `release` runs under the arbitration lock and removes the lock only when
 *     it still names this handle; it can never delete a newer winner's lock.
 *  4. The arbitration guard records the holder pid. An `owner.arb` directory is
 *     reclaimed only when the recorded holder cannot be alive (dead pid, or no
 *     usable guard after a long grace period) — never from age alone, so a
 *     paused takeover keeps its exclusivity.
 *
 * Ownership is a dynamic property: `owned` re-reads the lock and the matching
 * heartbeat. Loss, release or a failed heartbeat write revoke execution and
 * persistence rights in the job manager.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createFileExclusive, ensureDir, removeIfExists, writeFileAtomic } from './atomic.js';
import { queryProcessLiveness } from './proctree.js';

/**
 * 状态目录使用权凭据；lockId 区分代次，pid 记录持有者进程。
 */
export interface OwnershipRecord {
  schema: 'dsh-codex-bridge/owner-lock/v1';
  lockId: string;
  pid: number;
  hostname: string;
  startedAt: string;
  /** Kept for readers of the previous layout; freshness lives in the sidecar. */
  heartbeatAt: string;
  bridgeVersion: string;
}

/**
 * 本次启动的心跳侧文件，表示最近一次刷新。
 */
interface HeartbeatRecord {
  schema: 'dsh-codex-bridge/owner-heartbeat/v1';
  lockId: string;
  pid: number;
  heartbeatAt: string;
}

/**
 * 使用权管理所需时限、版本及失去使用权时的回调。
 */
export interface OwnershipOptions {
  /** A heartbeat older than this (or missing) makes the lock takeable. */
  staleHeartbeatMs: number;
  /** How often the owner refreshes the heartbeat. */
  heartbeatMs: number;
  bridgeVersion: string;
  /** Called once when this handle definitively loses/renounces ownership. */
  onLost?: (reason: string) => void;
}

/**
 * 使用权查询视图，报告本实例和观察到的持有者情况。
 */
export interface OwnershipView {
  owned: boolean;
  mode: 'acquired' | 'acquired-stale' | 'foreign' | 'lost';
  lockFile: string;
  lockId: string;
  lostReason: string | null;
  existingOwner: {
    pid: number;
    hostname: string;
    startedAt: string;
    heartbeatAt: string;
    heartbeatAgeMs: number;
    pidAlive: boolean;
  /** Tri-state liveness of the recorded holder pid (FIX-006 F6-01). */
  pidLiveness: 'alive' | 'dead' | 'unknown';
  } | null;
  diagnostic: string | null;
}

/**
 * 取得使用权后的操作句柄，提供实时检查、心跳和释放。
 */
export interface OwnershipHandle {
  /** Live check: true only while this handle still holds the lock. */
  readonly owned: boolean;
  readonly mode: OwnershipView['mode'];
  readonly lockId: string;
  readonly lockFile: string;
  view(): OwnershipView;
  heartbeat(): void;
  release(): void;
}

const ARB_GRACE_MS = 60000;

/**
 * 取得共享使用权锁文件的位置。
 */
function lockFileOf(stateDir: string): string {
  return path.join(stateDir, 'owner.lock');
}

/**
 * 按 lockId 找本次启动自己的心跳文件；不同次启动使用不同心跳，避免互相覆盖。
 */
function heartbeatFileOf(stateDir: string, lockId: string): string {
  return path.join(stateDir, `owner.heartbeat.${lockId}`);
}

/**
 * 取得接管/释放锁时使用的仲裁目录位置。
 */
function arbitrationDirOf(stateDir: string): string {
  return path.join(stateDir, 'owner.arb');
}

/**
 * 尝试读取锁相关 JSON；读取或解析失败时返回 null，交由上层决定是否拒绝接管。
 */
function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * 读取并检查使用权锁的基本格式。
 */
function readLock(file: string): OwnershipRecord | null {
  const record = readJsonFile<OwnershipRecord>(file);
  if (record === null || typeof record !== 'object') return null;
  if (typeof record.lockId !== 'string' || record.lockId === '') return null;
  if (typeof record.pid !== 'number' || !Number.isInteger(record.pid)) return null;
  return record;
}

/**
 * 读取心跳记录，为判断锁的活跃程度提供依据。
 */
function readHeartbeat(file: string): HeartbeatRecord | null {
  const record = readJsonFile<HeartbeatRecord>(file);
  if (record === null || typeof record !== 'object') return null;
  if (typeof record.lockId !== 'string' || typeof record.heartbeatAt !== 'string') return null;
  return record;
}

/**
 * 计算指定锁代次的心跳年龄；缺少可信心跳时返回无法确认的年龄值。
 */
function heartbeatAge(stateDir: string, lockId: string, now: number): number {
  const record = readHeartbeat(heartbeatFileOf(stateDir, lockId));
  if (record === null || record.lockId !== lockId) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(record.heartbeatAt);
  return Number.isFinite(parsed) ? now - parsed : Number.POSITIVE_INFINITY;
}

/** Write a file through a unique temporary sibling plus an atomic rename. */
/**
 * 复用可靠的原子写入方法更新锁相关文件。
 */
function writeAtomic(file: string, data: string): void {
  writeFileAtomic(file, data);
}

/**
 * 一次短期仲裁的结果及释放操作。
 */
interface Arbitration {
  held: boolean;
  diagnostic: string;
  release(): void;
}

/** Strictly validated guard: every required field must be present and typed. */
/**
 * 通过格式检查的仲裁持有者信息。
 */
interface ValidGuard {
  lockId: string;
  pid: number;
  heartbeatAt: string;
  raw: string;
}

/**
 * 严格检查仲裁持有者记录，避免把格式不明的记录当作可安全回收。
 */
function parseGuard(file: string): ValidGuard | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate['lockId'] !== 'string' || candidate['lockId'] === '') return null;
  if (typeof candidate['pid'] !== 'number' || !Number.isInteger(candidate['pid']) || candidate['pid'] <= 0) return null;
  if (typeof candidate['heartbeatAt'] !== 'string' || candidate['heartbeatAt'] === '') return null;
  return { lockId: candidate['lockId'], pid: candidate['pid'], heartbeatAt: candidate['heartbeatAt'], raw };
}

/**
 * Acquire the arbitration lock.
 *
 * Reclaiming is a generational operation: the observed guard is first renamed to
 * a unique name of its own, the renamed content is verified to be the very guard
 * that was observed, and only that unique file is then removed. A guard that is
 * missing, unreadable, malformed or mistyped is **not** evidence that its holder
 * stopped, and an old reclaimer can therefore never delete a newer generation's
 * guard or directory.
 */
/**
 * 取得短期仲裁使用权，让接管或释放操作串行进行；无法证明持有者已死亡时拒绝强行回收。
 */
function acquireArbitration(stateDir: string, holderLockId: string, options: OwnershipOptions): Arbitration {
  const dir = arbitrationDirOf(stateDir);
  const guard = path.join(dir, 'guard.json');
  const writeGuard = (): void => {
    writeAtomic(
      guard,
      `${JSON.stringify({ schema: 'dsh-codex-bridge/arb-guard/v1', lockId: holderLockId, pid: process.pid, heartbeatAt: new Date().toISOString() }, null, 2)}\n`,
    );
  };
  const releaseOwnGuard = (myRaw: string): void => {
    const aside = `${guard}.release-${randomBytes(6).toString('hex')}`;
    try {
      fs.renameSync(guard, aside);
    } catch {
      return; // nothing of ours is there any more
    }
    const moved = (() => {
      try {
        return fs.readFileSync(aside, 'utf8');
      } catch {
        return '';
      }
    })();
    if (moved !== myRaw) {
      // We moved somebody else's generation aside: put it back untouched.
      try {
        fs.renameSync(aside, guard);
      } catch {
        /* best effort restore */
      }
      return;
    }
    removeIfExists(aside);
    try {
      fs.rmdirSync(dir);
    } catch {
      /* a newer holder already recreated the directory */
    }
  };
  const myRaw = `${JSON.stringify({ schema: 'dsh-codex-bridge/arb-guard/v1', lockId: holderLockId, pid: process.pid, heartbeatAt: new Date().toISOString() }, null, 2)}\n`;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      fs.mkdirSync(dir);
      writeAtomic(guard, myRaw);
      return {
        held: true,
        diagnostic: 'arbitration acquired',
        release(): void {
          releaseOwnGuard(myRaw);
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        return { held: false, diagnostic: `cannot create arbitration lock: ${(error as NodeJS.ErrnoException).code ?? String(error)}`, release: () => {} };
      }
    }
    const recorded = parseGuard(guard);
    if (recorded === null) {
      // Missing / unparsable / incomplete / mistyped: the holder's state is
      // unknown, which is not proof that it stopped. Refuse, keep the directory.
      if (attempt < 19) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      continue;
    }
    if (queryProcessLiveness(recorded.pid) !== 'dead') {
      // Alive, or not queryable at all (invalid/out-of-range pid, EIO/EINVAL,
      // unknown error): in both cases the holder is not proven stopped, so the
      // guard stays untouched (FIX-006 F6-01).
      if (attempt < 19) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      continue;
    }
    // Provably stopped holder: generational reclaim of exactly that generation.
    const aside = `${guard}.reclaim-${randomBytes(6).toString('hex')}`;
    try {
      fs.renameSync(guard, aside);
    } catch {
      continue; // another reclaimer got there first
    }
    const moved = (() => {
      try {
        return fs.readFileSync(aside, 'utf8');
      } catch {
        return '';
      }
    })();
    if (moved !== recorded.raw) {
      // A newer generation had already replaced the guard: restore it, do not
      // remove anything.
      try {
        fs.renameSync(aside, guard);
      } catch {
        /* best effort restore */
      }
      continue;
    }
    removeIfExists(aside);
    try {
      fs.rmdirSync(dir);
    } catch {
      /* another generation moved in: its guard is untouched */
    }
  }
  return {
    held: false,
    diagnostic:
      'arbitration lock is held, missing or unreadable; the holder cannot be proven stopped, so no shared mutation was attempted (manual recovery: inspect stateDir/owner.arb and remove a stale guard only after confirming no bridge is running)',
    release: () => {},
  };
}

/**
 * 取得状态目录使用权并启动心跳。已有锁时重新检查其代次和活跃情况，避免两个实例同时改写记录。
 */
export function acquireOwnership(stateDir: string, options: OwnershipOptions): OwnershipHandle {
  ensureDir(stateDir);
  const lockFile = lockFileOf(stateDir);
  const lockId = randomBytes(12).toString('hex');
  const startedAt = new Date().toISOString();
  const now = Date.now();

  const record = (): OwnershipRecord => ({
    schema: 'dsh-codex-bridge/owner-lock/v1',
    lockId,
    pid: process.pid,
    hostname: os.hostname(),
    startedAt,
    heartbeatAt: new Date().toISOString(),
    bridgeVersion: options.bridgeVersion,
  });

  const writeOwnHeartbeat = (): void => {
    writeAtomic(
      heartbeatFileOf(stateDir, lockId),
      `${JSON.stringify({ schema: 'dsh-codex-bridge/owner-heartbeat/v1', lockId, pid: process.pid, heartbeatAt: new Date().toISOString() }, null, 2)}\n`,
    );
  };

  const currentLock = (): OwnershipRecord | null => readLock(lockFile);
  const isOwnerNow = (at = Date.now()): boolean => {
    const lock = currentLock();
    if (lock === null || lock.lockId !== lockId) return false;
    return Number.isFinite(heartbeatAge(stateDir, lockId, at));
  };

  let mode: OwnershipView['mode'] = 'foreign';
  let diagnostic: string | null = null;
  let existingView: OwnershipView['existingOwner'] = null;
  let released = false;
  let lost = false;
  let lostReason: string | null = null;
  let timer: NodeJS.Timeout | null = null;
  let lostNotified = false;

  const notifyLost = (reason: string): void => {
    if (lost || released) return;
    lost = true;
    lostReason = reason;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    if (!lostNotified) {
      lostNotified = true;
      try {
        options.onLost?.(reason);
      } catch {
        /* the callback must never break ownership bookkeeping */
      }
    }
  };

  const describe = (lock: OwnershipRecord, at: number): OwnershipView['existingOwner'] => {
    const age = heartbeatAge(stateDir, lock.lockId, at);
    return {
      pid: lock.pid,
      hostname: typeof lock.hostname === 'string' ? lock.hostname : 'unknown',
      startedAt: typeof lock.startedAt === 'string' ? lock.startedAt : 'unknown',
      heartbeatAt: new Date(at - (Number.isFinite(age) ? age : 0)).toISOString(),
      heartbeatAgeMs: age,
      pidAlive: queryProcessLiveness(lock.pid) === 'alive',
      pidLiveness: queryProcessLiveness(lock.pid),
    };
  };

  /**
   * Exclusive claim: the complete record is created with O_CREAT|O_EXCL and the
   * heartbeat sidecar is written straight after. Nothing is overwritten, so this
   * step needs no arbitration and cannot displace an existing owner.
   */
  const claimExclusive = (): boolean => {
    if (!createFileExclusive(lockFile, `${JSON.stringify(record(), null, 2)}\n`)) return false;
    writeOwnHeartbeat();
    return true;
  };

  const mtimeOf = (): number => {
    try {
      return fs.statSync(lockFile).mtimeMs;
    } catch {
      return Date.now();
    }
  };

  const lastHeartbeatAt = (forLockId: string): number | null => {
    const record2 = readHeartbeat(heartbeatFileOf(stateDir, forLockId));
    if (record2 === null) return null;
    const parsed = Date.parse(record2.heartbeatAt);
    return Number.isFinite(parsed) ? parsed : null;
  };

  if (claimExclusive()) {
    mode = 'acquired';
    if (!isOwnerNow()) {
      mode = 'foreign';
      diagnostic = 'another bridge claimed the state directory concurrently';
    }
  } else {
    for (let attempt = 0; attempt < 4 && mode === 'foreign'; attempt += 1) {
      const existing = currentLock();
      const lockExists = fs.existsSync(lockFile);
      if (!lockExists) {
        if (claimExclusive()) mode = 'acquired';
        continue;
      }
      const at = Date.now();
      existingView = existing === null ? null : describe(existing, at);
      const fresh = existing !== null && (existingView?.heartbeatAgeMs ?? Number.POSITIVE_INFINITY) <= options.staleHeartbeatMs;
      const gone = existing !== null && existing.pid !== process.pid && queryProcessLiveness(existing.pid) === 'dead';
      if (existing !== null && ((fresh && !gone) || existing.lockId === lockId)) {
        diagnostic = `state directory is owned by a live bridge (pid ${existing.pid}, heartbeat ${Math.max(0, Math.round(existingView?.heartbeatAgeMs ?? 0))} ms old); refusing to take over`;
        break;
      }
      if (existing === null && Date.now() - mtimeOf() <= options.staleHeartbeatMs) {
        diagnostic = `the state directory lock cannot be read and is fresh (${Math.max(0, Math.round(Date.now() - mtimeOf()))} ms old); refusing to overwrite a claim in progress`;
        break;
      }

      // Stale or unreadable-and-old: replace it under the arbitration lock, and
      // re-verify the observed owner inside the critical section.
      const arbitration = acquireArbitration(stateDir, lockId, options);
      if (!arbitration.held) {
        diagnostic = arbitration.diagnostic;
        break;
      }
      try {
        const recheck = currentLock();
        if (recheck === null && fs.existsSync(lockFile) && Date.now() - mtimeOf() <= options.staleHeartbeatMs) {
          diagnostic = 'the unreadable lock changed while taking over; refusing';
          break;
        }
        if (recheck !== null) {
          if (existing !== null && recheck.lockId !== existing.lockId) {
            diagnostic = 'a different owner appeared while taking over; refusing to displace it';
            break;
          }
          const reAge = heartbeatAge(stateDir, recheck.lockId, Date.now());
          const reGone = recheck.pid !== process.pid && queryProcessLiveness(recheck.pid) === 'dead';
          if (reAge <= options.staleHeartbeatMs && !reGone) {
            diagnostic = 'the observed owner refreshed its heartbeat; refusing to take over a live lock';
            break;
          }
        }
        const previous = recheck;
        const previousHeartbeatAt = previous === null ? null : lastHeartbeatAt(previous.lockId);
        removeIfExists(lockFile);
        if (!claimExclusive()) {
          diagnostic = 'lost the race for the freed lock';
          break;
        }
        if (previous !== null) {
          const heartbeatNow = lastHeartbeatAt(previous.lockId);
          if (previousHeartbeatAt !== null && heartbeatNow !== null && heartbeatNow > previousHeartbeatAt) {
            // The previous owner proved liveness inside our critical section:
            // hand the lock back instead of keeping a disputed claim.
            removeIfExists(heartbeatFileOf(stateDir, lockId));
            removeIfExists(lockFile);
            createFileExclusive(lockFile, `${JSON.stringify(previous, null, 2)}\n`);
            diagnostic = 'the previous owner refreshed during the takeover; the lock was restored and this handle refused';
            break;
          }
          removeIfExists(heartbeatFileOf(stateDir, previous.lockId));
          existingView = describe(previous, Date.now());
        }
        mode = 'acquired-stale';
        diagnostic = 'took over a lock whose owner was verified stale under arbitration';
        if (!isOwnerNow()) {
          mode = 'foreign';
          diagnostic = 'lost the race for the freed lock';
        }
      } finally {
        arbitration.release();
      }
    }
  }

  const heartbeat = (): void => {
    if (released || lost) return;
    if (!isOwnerNow()) {
      notifyLost('lock is held by another owner; this instance is no longer authorized');
      return;
    }
    try {
      writeOwnHeartbeat();
    } catch (error) {
      notifyLost(`heartbeat write failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (!isOwnerNow()) notifyLost('lock changed during the heartbeat write; this instance lost ownership');
  };

  if (mode !== 'foreign') {
    timer = setInterval(heartbeat, Math.max(250, options.heartbeatMs));
    if (typeof timer.unref === 'function') timer.unref();
    if (!isOwnerNow()) {
      mode = 'foreign';
      diagnostic = 'another bridge claimed the state directory concurrently';
    }
  }

  const isOwned = (): boolean => !released && !lost && mode !== 'foreign' && isOwnerNow();

  return {
    get owned(): boolean {
      return isOwned();
    },
    get mode(): OwnershipView['mode'] {
      if (released || lost) return 'lost';
      return mode;
    },
    lockId,
    lockFile,
    view(): OwnershipView {
      return {
        owned: isOwned(),
        mode: this.mode,
        lockFile,
        lockId,
        lostReason,
        existingOwner: existingView,
        diagnostic,
      };
    },
    heartbeat,
    release(): void {
      if (released) return;
      released = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      // This handle's own heartbeat sidecar is generational: removing it cannot
      // affect another owner, so it is always safe to clean up.
      removeIfExists(heartbeatFileOf(stateDir, lockId));
      // The shared lock itself is only ever removed while holding the correct
      // arbitration generation. A denied/uncertain arbitration (live holder,
      // timeout, I/O failure, unreadable guard) means "no evidence that the
      // holder stopped": refuse instead of entering the shared delete
      // (FIX-005 F5-01).
      const arbitrationNow = acquireArbitration(stateDir, lockId, options);
      if (!arbitrationNow.held) {
        diagnostic = `refusing to remove the shared owner lock: ${arbitrationNow.diagnostic}`;
        return;
      }
      try {
        const lock = currentLock();
        if (lock !== null && lock.lockId === lockId) removeIfExists(lockFile);
      } finally {
        arbitrationNow.release();
      }
    },
  };
}

/** Read the current lock record (tests and diagnostics). */
/**
 * 只查看当前使用权记录，不接管目录。
 */
export function peekOwnership(stateDir: string): OwnershipRecord | null {
  return readLock(lockFileOf(stateDir));
}

/** Read the heartbeat sidecar for a lock id (tests and diagnostics). */
/**
 * 只查看指定代次的心跳记录。
 */
export function peekHeartbeat(stateDir: string, lockId: string): HeartbeatRecord | null {
  return readHeartbeat(heartbeatFileOf(stateDir, lockId));
}

/**
 * 在有限时间内等待锁被移除，不无限等待。
 */
export async function waitForLockRemoval(stateDir: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (readLock(lockFileOf(stateDir)) === null) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
