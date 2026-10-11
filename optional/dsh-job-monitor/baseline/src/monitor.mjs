/**
 * The sampler: turns the read-only state directory into the JSON the page sees.
 *
 * Design rules enforced here:
 *   - job.json is reduced to whitelisted fields before it leaves this module,
 *   - task text / log text / errorMessage / paths from the record are never
 *     copied into a response,
 *   - terminal elapsed time is frozen on `endedAt` and can never grow,
 *   - execution status and independent review status stay two separate fields,
 *   - no completion percentage is derived from anything.
 */
import {
  JOB_STATUSES,
  TERMINAL_STATUSES,
  STATUS_LABELS,
  STATUS_TONES,
  MODE_LABELS,
  ACCEPTANCE_LABELS,
  ACCEPTANCE_TONES,
  EXECUTION_DISCLAIMER,
  HARD_CAPS,
  DEFAULT_LIMITS,
  DEFAULT_REFRESH_INTERVAL_MS,
  DEFAULT_STALE_HEARTBEAT_MS,
  errorCodeLabel,
  readCodeLabel,
  isValidJobId,
} from './constants.mjs';
import { createStateReader } from './state.mjs';
import { createWorkspaceMap } from './workspaceMap.mjs';
import { createAcceptanceReader, acceptanceFor } from './acceptance.mjs';
import { readOwner } from './owner.mjs';
import { buildActivity } from './activity.mjs';
import { scanWorkspace } from './workspaceScan.mjs';

function parseMs(iso) {
  if (typeof iso !== 'string') return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

export function computeElapsed(job, nowMs) {
  const terminal = TERMINAL_STATUSES.includes(job.status);
  const startedAtMs = parseMs(job.startedAt) ?? parseMs(job.createdAt);
  const basis = parseMs(job.startedAt) !== null ? 'startedAt' : 'createdAt';

  if (terminal) {
    const endedAtMs = parseMs(job.endedAt);
    if (endedAtMs === null || startedAtMs === null) {
      return { elapsedMs: null, frozen: true, basis, note: '终态缺少 endedAt，用时已冻结且不可计算' };
    }
    return { elapsedMs: Math.max(0, endedAtMs - startedAtMs), frozen: true, basis: 'endedAt', note: null };
  }
  if (startedAtMs === null) {
    return { elapsedMs: null, frozen: false, basis: 'unknown', note: '缺少开始时间' };
  }
  return { elapsedMs: Math.max(0, nowMs - startedAtMs), frozen: false, basis, note: null };
}

function timeBudget(job, elapsed) {
  const timeoutSeconds = job.timeoutSeconds;
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    return { limitMs: null, remainingMs: null, usedRatio: null, exceeded: null };
  }
  const limitMs = timeoutSeconds * 1000;
  if (elapsed.elapsedMs === null) {
    return { limitMs, remainingMs: null, usedRatio: null, exceeded: null };
  }
  const remainingMs = limitMs - elapsed.elapsedMs;
  return {
    limitMs,
    remainingMs,
    usedRatio: Math.min(1, Math.max(0, elapsed.elapsedMs / limitMs)),
    exceeded: remainingMs < 0,
  };
}

export function createMonitor(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
  for (const key of Object.keys(HARD_CAPS)) {
    if (key in limits && Number.isFinite(limits[key]) && limits[key] > HARD_CAPS[key]) {
      limits[key] = HARD_CAPS[key];
    }
  }
  const refreshIntervalMs = Number.isFinite(options.refreshIntervalMs)
    ? options.refreshIntervalMs
    : DEFAULT_REFRESH_INTERVAL_MS;
  const staleHeartbeatMs = Number.isFinite(options.staleHeartbeatMs)
    ? options.staleHeartbeatMs
    : DEFAULT_STALE_HEARTBEAT_MS;
  const demo = options.demo === true;

  const state = createStateReader({
    stateRoot: options.stateRoot ?? '.',
    limits,
  });
  const workspaceMap = createWorkspaceMap(options.workspaceMap ?? {});
  const acceptanceReader = createAcceptanceReader({
    path: options.acceptanceLedger ?? null,
    maxBytes: limits.maxLedgerBytes,
  });

  /** @type {Map<string, {sampledAtMs:number, streams:object}>} */
  const previousSamples = new Map();

  function ledgerReadCached() {
    return acceptanceReader.read();
  }

  function decorateAcceptance(jobId, ledgerRead) {
    const raw = acceptanceFor(ledgerRead, jobId);
    return {
      ...raw,
      label: ACCEPTANCE_LABELS[raw.status] ?? ACCEPTANCE_LABELS.none,
      tone: ACCEPTANCE_TONES[raw.status] ?? ACCEPTANCE_TONES.none,
    };
  }

  function decorateJob(job, ledgerRead, nowMs) {
    const nameInfo = workspaceMap.displayName(job);
    const modeLabel = MODE_LABELS[job.mode] ?? MODE_LABELS.unknown;
    const statusLabel = STATUS_LABELS[job.status] ?? STATUS_LABELS.unknown;
    const derivedName =
      nameInfo.name ??
      `${modeLabel} · ${job.workspaceId ?? '未知工作区'}`;
    const elapsed = computeElapsed(job, nowMs);
    const budget = timeBudget(job, elapsed);
    return {
      jobId: job.jobId,
      name: derivedName,
      nameSource: nameInfo.source,
      workspaceId: job.workspaceId,
      mode: job.mode,
      modeLabel,
      status: job.status,
      statusLabel,
      statusTone: STATUS_TONES[job.status] ?? STATUS_TONES.unknown,
      statusKnown: JOB_STATUSES.includes(job.status),
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      endedAt: job.endedAt,
      timeoutSeconds: job.timeoutSeconds,
      exitCode: job.exitCode,
      signal: job.signal,
      errorCode: job.errorCode,
      errorLabel: errorCodeLabel(job.errorCode),
      timedOut: job.timedOut,
      cancelRequested: job.cancelRequested,
      recovered: job.recovered,
      bytes: job.bytes,
      rawBytes: job.rawBytes,
      truncated: job.truncated,
      cleanup: job.cleanup,
      elapsedMs: elapsed.elapsedMs,
      elapsedFrozen: elapsed.frozen,
      elapsedBasis: elapsed.basis,
      elapsedNote: elapsed.note,
      limitMs: budget.limitMs,
      remainingMs: budget.remainingMs,
      timeUsedRatio: budget.usedRatio,
      timeExceeded: budget.exceeded,
      acceptance: decorateAcceptance(job.jobId, ledgerRead),
    };
  }

  function list() {
    const nowMs = now();
    const sampledAt = new Date(nowMs).toISOString();
    const enumeration = state.listJobIds();
    const ledgerRead = ledgerReadCached();

    const readLimit = Math.min(
      enumeration.ids.length,
      Math.max(limits.maxJobs, Math.min(enumeration.ids.length, limits.maxJobs * 4)),
    );

    const jobs = [];
    const unreadable = [];
    const idsToRead = enumeration.ids.slice(0, readLimit);

    for (const jobId of idsToRead) {
      const record = state.readJobRecord(jobId);
      if (!record.ok) {
        unreadable.push({
          jobId,
          code: record.code,
          codeLabel: readCodeLabel(record.code),
          reason: record.reason,
        });
        continue;
      }
      jobs.push({
        summary: decorateJob(record.job, ledgerRead, nowMs),
        createdAtMs: parseMs(record.job.createdAt) ?? 0,
      });
    }

    jobs.sort((a, b) => b.createdAtMs - a.createdAtMs || a.summary.jobId.localeCompare(b.summary.jobId));
    const listed = jobs.slice(0, limits.maxJobs).map((entry) => entry.summary);
    const truncated = enumeration.ids.length > idsToRead.length || jobs.length > limits.maxJobs;

    const notes = [];
    if (enumeration.errorCode) notes.push(`读取 jobs 目录失败（${enumeration.errorCode}）。`);
    if (enumeration.rejectedReparse > 0) {
      notes.push(`忽略了 ${enumeration.rejectedReparse} 个重解析点/符号链接目录。`);
    }
    if (enumeration.ignoredEntries > 0) {
      notes.push(`忽略了 ${enumeration.ignoredEntries} 个不符合 job-<字母数字> 规则的条目。`);
    }
    if (truncated) {
      notes.push(`共 ${enumeration.ids.length} 个作业目录，仅列出最近 ${listed.length} 个（上限 ${limits.maxJobs}）。`);
    }
    if (unreadable.length > 0) {
      notes.push(`${unreadable.length} 条记录损坏或不可读，已单独列出，未计入正常作业。`);
    }
    if (jobs.length === 0 && unreadable.length === 0 && enumeration.errorCode === null) {
      notes.push('当前没有找到任何作业目录。');
    }

    return {
      sampledAt,
      demo,
      readOnly: true,
      refreshIntervalMs,
      source: {
        stateRoot: state.rootInfo.configured,
        stateRootExists: state.rootInfo.exists,
        stateRootIsDirectory: state.rootInfo.isDirectory,
        jobsDirExists: enumeration.jobDirExists,
        enumerationErrorCode: enumeration.errorCode,
        enumerationErrorLabel: readCodeLabel(enumeration.errorCode),
      },
      counts: {
        totalJobDirectories: enumeration.ids.length,
        listed: listed.length,
        unreadable: unreadable.length,
        ignoredEntries: enumeration.ignoredEntries,
        rejectedReparse: enumeration.rejectedReparse,
        truncated,
      },
      jobs: listed,
      unreadable,
      notes,
      executionDisclaimer: EXECUTION_DISCLAIMER,
      acceptanceLedger: {
        configured: ledgerRead.configured,
        readable: ledgerRead.readable,
        errorCode: ledgerRead.errorCode,
        errorLabel: readCodeLabel(ledgerRead.errorCode),
        updatedAt: ledgerRead.updatedAt,
        entryCount: ledgerRead.entryCount,
        invalidEntries: ledgerRead.invalidEntries,
        ignoredKeys: ledgerRead.ignoredKeys,
        note: ledgerRead.note,
      },
    };
  }

  function detail(jobId) {
    if (!isValidJobId(jobId)) {
      return { ok: false, httpStatus: 400, code: 'INVALID_JOB_ID', reason: 'jobId 不合法' };
    }
    const nowMs = now();
    const sampledAt = new Date(nowMs).toISOString();
    const ledgerRead = ledgerReadCached();
    const enumeration = state.listJobIds();

    if (enumeration.errorCode) {
      return {
        ok: false,
        httpStatus: 503,
        code: enumeration.errorCode,
        reason: `读取 jobs 目录失败（${enumeration.errorCode}）`,
      };
    }
    if (!enumeration.ids.includes(jobId)) {
      return { ok: false, httpStatus: 404, code: 'JOB_NOT_FOUND', reason: '未找到该作业目录' };
    }

    const record = state.readJobRecord(jobId);
    if (!record.ok) {
      return {
        ok: true,
        value: {
          sampledAt,
          demo,
          readOnly: true,
          jobId,
          job: null,
          recordError: {
            code: record.code,
            codeLabel: readCodeLabel(record.code),
            reason: record.reason,
          },
          acceptance: decorateAcceptance(jobId, ledgerRead),
          activity: null,
          delivery: null,
          notes: ['该作业目录存在，但 job.json 无法解析为可信记录；不会把它当作“无作业”。'],
        },
      };
    }

    const job = record.job;
    const decorated = decorateJob(job, ledgerRead, nowMs);

    const stats = {
      stdout: state.statLog(jobId, 'stdout.log'),
      stderr: state.statLog(jobId, 'stderr.log'),
    };
    const previous = previousSamples.get(jobId) ?? null;
    const activity = buildActivity({ job, stats, previous, nowMs });
    previousSamples.set(jobId, activity.snapshot);
    if (previousSamples.size > 200) {
      const oldest = previousSamples.keys().next().value;
      previousSamples.delete(oldest);
    }

    const mapping = workspaceMap.resolve(job);
    const testResult = {
      status: 'not-provided',
      label: '未提供',
      note: '本面板不读取报告或测试结果正文，也不匹配日志中的 PASS 字样，因此不给测试通过结论。',
    };
    let delivery;
    if (!mapping.configured) {
      delivery = {
        configured: false,
        match: 'none',
        label: mapping.label,
        scan: null,
        testResult,
        note: '未配置交付目录：请在配置文件中为该工作区或该作业指定只读白名单目录。',
      };
    } else {
      const scan = scanWorkspace(mapping.root, {
        now: nowMs,
        maxScanEntries: limits.maxScanEntries,
        maxScanDepth: limits.maxScanDepth,
        maxRecentFiles: limits.maxRecentFiles,
        maxReportCandidates: limits.maxReportCandidates,
      });
      delivery = {
        configured: true,
        match: mapping.match,
        label: mapping.label,
        ok: scan.ok,
        errorCode: scan.errorCode,
        errorLabel: readCodeLabel(scan.errorCode),
        counts: scan.counts,
        truncated: scan.truncated,
        truncatedReason: scan.truncatedReason,
        maxEntries: scan.maxEntries,
        maxDepth: scan.maxDepth,
        latestMtimeAt: scan.latestMtimeAt,
        recentFiles: scan.files,
        reportCandidates: scan.reportCandidates,
        testResult,
        note: '基于文件元数据（相对路径 / 大小 / 修改时间），未打开文件内容，不能归属到某个模型动作。',
      };
    }

    const notes = [];
    if (record.warnings.length > 0) {
      notes.push(`记录中有 ${record.warnings.length} 个字段非法或缺失，已按缺失处理。`);
    }
    if (activity.value.noNewActivity) {
      notes.push('暂无新活动；这只是文件元数据未变化，不能推断任务阶段或剩余工作量。');
    }
    if (delivery.configured && delivery.truncated) {
      notes.push(`交付目录扫描未覆盖全部内容：${delivery.truncatedReason ?? '达到上限'}。`);
    }
    if (!ledgerRead.configured) {
      notes.push('未提供独立验收账本，验收状态一律为“未提供验收记录”。');
    } else if (!ledgerRead.readable) {
      notes.push(`验收账本不可读（${ledgerRead.errorCode}），验收状态一律为“未提供验收记录”。`);
    }

    return {
      ok: true,
      value: {
        sampledAt,
        demo,
        readOnly: true,
        jobId,
        job: decorated,
        recordError: null,
        recordWarnings: record.warnings,
        acceptance: decorated.acceptance,
        activity: activity.value,
        delivery,
        notes,
        executionDisclaimer: EXECUTION_DISCLAIMER,
      },
    };
  }

  function meta() {
    const nowMs = now();
    const ledgerRead = ledgerReadCached();
    return {
      app: 'dsh-monitor',
      version: options.version ?? '1.0.0',
      demo,
      readOnly: true,
      sampledAt: new Date(nowMs).toISOString(),
      refreshIntervalMs,
      stateRoot: {
        configured: state.rootInfo.configured,
        exists: state.rootInfo.exists,
        isDirectory: state.rootInfo.isDirectory,
        isReparse: state.rootInfo.isReparse,
        errorCode: state.rootInfo.code,
        errorLabel: readCodeLabel(state.rootInfo.code),
      },
      owner: readOwner(state.rootInfo.real, {
        now,
        staleHeartbeatMs,
        maxOwnerBytes: limits.maxOwnerBytes,
      }),
      acceptanceLedger: {
        configured: ledgerRead.configured,
        readable: ledgerRead.readable,
        path: acceptanceReader.path,
        errorCode: ledgerRead.errorCode,
        errorLabel: readCodeLabel(ledgerRead.errorCode),
        updatedAt: ledgerRead.updatedAt,
        entryCount: ledgerRead.entryCount,
        invalidEntries: ledgerRead.invalidEntries,
        ignoredKeys: ledgerRead.ignoredKeys,
        note: ledgerRead.note,
      },
      workspaceMap: {
        configured: workspaceMap.configured,
        workspaceCount: workspaceMap.byWorkspaceId.size,
        jobOverrideCount: workspaceMap.byJobId.size,
        nameCount: workspaceMap.names.size,
        workspaceNameCount: workspaceMap.workspaceNames.size,
        rejected: workspaceMap.rejected,
        entries: [...workspaceMap.byWorkspaceId.keys()],
        overrides: [...workspaceMap.byJobId.keys()],
      },
      limits: {
        maxJobs: limits.maxJobs,
        maxJobJsonBytes: limits.maxJobJsonBytes,
        maxLedgerBytes: limits.maxLedgerBytes,
        maxOwnerBytes: limits.maxOwnerBytes,
        maxScanEntries: limits.maxScanEntries,
        maxScanDepth: limits.maxScanDepth,
        maxRecentFiles: limits.maxRecentFiles,
        maxReportCandidates: limits.maxReportCandidates,
        maxStaticBytes: limits.maxStaticBytes,
      },
      hardCaps: HARD_CAPS,
      executionDisclaimer: EXECUTION_DISCLAIMER,
    };
  }

  return {
    list,
    detail,
    meta,
    // exposed for tests
    _internal: {
      state,
      workspaceMap,
      acceptanceReader,
      previousSamples,
    },
  };
}
