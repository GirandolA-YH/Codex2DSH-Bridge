/**
 * Log activity from file metadata only.
 *
 * The panel never opens stdout.log / stderr.log. "New activity" therefore means
 * exactly "the file grew or its mtime moved since the previous sample", and
 * silence means exactly "nothing changed" -- never "stuck", "failed" or "the
 * process is dead". No phase or remaining-work estimate is derived from it.
 */
import { LOG_FILE_NAMES } from './paths.mjs';

function compareStream(name, stat, previous, recordedBytes, truncated) {
  const exists = stat.exists === true;
  const sizeBytes = exists ? stat.sizeBytes : null;
  const mtimeMs = exists && Number.isFinite(stat.mtimeMs) ? Math.round(stat.mtimeMs) : null;
  const prev = previous === null || previous === undefined ? null : previous[name] ?? null;

  let deltaBytes = null;
  let appeared = false;
  let disappeared = false;
  let mtimeChanged = null;

  if (previous !== null && previous !== undefined) {
    if (exists && prev !== null && prev.exists === true) {
      deltaBytes = sizeBytes !== null && prev.sizeBytes !== null ? sizeBytes - prev.sizeBytes : null;
      mtimeChanged = mtimeMs !== null && prev.mtimeMs !== null ? mtimeMs !== prev.mtimeMs : null;
    } else if (exists && (prev === null || prev.exists !== true)) {
      appeared = true;
      deltaBytes = sizeBytes;
      mtimeChanged = true;
    } else if (!exists && prev !== null && prev.exists === true) {
      disappeared = true;
      deltaBytes = null;
      mtimeChanged = true;
    }
  }

  return {
    exists,
    sizeBytes,
    mtimeAt: mtimeMs === null ? null : new Date(mtimeMs).toISOString(),
    mtimeMs,
    deltaBytes,
    mtimeChanged,
    appeared,
    disappeared,
    recordedBytes: Number.isFinite(recordedBytes) ? recordedBytes : null,
    recordedMismatch:
      exists && Number.isFinite(recordedBytes) && sizeBytes !== null ? recordedBytes !== sizeBytes : null,
    truncated: truncated === true ? true : truncated === false ? false : null,
    errorCode: exists ? null : (stat.code ?? null),
  };
}

/**
 * @param {object} input
 * @param {object} input.job whitelisted job record
 * @param {{stdout:object,stderr:object}} input.stats
 * @param {object|null} input.previous previous sample for this job
 * @param {number} input.nowMs
 */
export function buildActivity({ job, stats, previous, nowMs }) {
  const recorded = job?.bytes ?? { stdout: null, stderr: null };
  const truncated = job?.truncated ?? { stdout: null, stderr: null };
  const prevStreams = previous?.streams ?? null;

  const streams = {};
  const snapshotStreams = {};
  for (const name of LOG_FILE_NAMES) {
    const key = name === 'stdout.log' ? 'stdout' : 'stderr';
    const stat = stats?.[key] ?? { exists: false, code: 'ENOENT' };
    const compared = compareStream(key, stat, prevStreams, recorded?.[key], truncated?.[key]);
    streams[key] = compared;
    snapshotStreams[key] = {
      exists: compared.exists,
      sizeBytes: compared.sizeBytes,
      mtimeMs: compared.mtimeMs,
    };
  }

  const firstSample = previous === null || previous === undefined;
  const anyExists = streams.stdout.exists || streams.stderr.exists;

  let noNewActivity = false;
  if (!firstSample) {
    const changed = ['stdout', 'stderr'].some((key) => {
      const s = streams[key];
      if (s.appeared || s.disappeared) return true;
      if (s.deltaBytes !== null && s.deltaBytes !== 0) return true;
      if (s.mtimeChanged === true) return true;
      return false;
    });
    noNewActivity = !changed;
  }

  let note;
  if (!anyExists) {
    note = '未找到日志文件（stdout.log / stderr.log 均不存在）。';
  } else if (firstSample) {
    note = '首次采样：已记录文件大小与修改时间基线，下次刷新后显示增长量。';
  } else if (noNewActivity) {
    note = '暂无新活动（仅表示文件大小与修改时间没有变化，不代表卡死、失败或进程已退出）。';
  } else {
    note = '日志文件自上次采样发生变化（仅文件元数据，未读取日志内容）。';
  }

  const snapshot = {
    sampledAtMs: nowMs,
    streams: snapshotStreams,
  };

  return {
    value: {
      sampledAt: new Date(nowMs).toISOString(),
      previousSampleAt: previous ? new Date(previous.sampledAtMs).toISOString() : null,
      firstSample,
      noNewActivity,
      anyLogFileExists: anyExists,
      streams,
      note,
    },
    snapshot,
  };
}
