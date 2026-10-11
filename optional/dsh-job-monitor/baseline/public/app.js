/**
 * 前端渲染：所有动态文本只用 textContent / createElement 写入，
 * 不使用 innerHTML，因此 job.json、账本或文件名中的内容不可能变成标记。
 */
const $ = (id) => document.getElementById(id);

const state = {
  meta: null,
  list: null,
  detail: null,
  selectedJobId: null,
  bannerKind: null,
  lastSuccessAt: null,
  failures: 0,
  inFlight: false,
  paused: false,
  timer: null,
  intervalMs: 5000,
  ticker: null,
};

/* ---------------- 取值与格式化 ---------------- */

const PLACEHOLDER = '—';

function fmtDateTime(iso) {
  if (typeof iso !== 'string' || iso === '') return PLACEHOLDER;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return PLACEHOLDER;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtClock(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtDuration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return PLACEHOLDER;
  const total = Math.max(0, Math.round(ms / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const parts = [];
  if (days > 0) parts.push(`${days}天`);
  if (hours > 0) parts.push(`${hours}小时`);
  if (minutes > 0) parts.push(`${minutes}分`);
  parts.push(`${seconds}秒`);
  return parts.join('');
}

function fmtBytes(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return PLACEHOLDER;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MiB`;
}

function fmtDelta(stream, firstSample) {
  if (firstSample) return '首次采样（已记录基线）';
  if (stream.appeared) return `新出现 ${fmtBytes(stream.sizeBytes)}`;
  if (stream.disappeared) return '文件已消失';
  if (stream.deltaBytes === null || stream.deltaBytes === undefined) return '无基线';
  if (stream.deltaBytes === 0) {
    return stream.mtimeChanged ? '大小不变，修改时间变化' : '暂无新活动';
  }
  if (stream.deltaBytes < 0) return `缩小 ${fmtBytes(Math.abs(stream.deltaBytes))}（文件被重建/截断）`;
  return `+${fmtBytes(stream.deltaBytes)}`;
}

/* ---------------- DOM 小工具 ---------------- */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function setText(id, value) {
  const node = $(id);
  if (node) node.textContent = value === null || value === undefined || value === '' ? PLACEHOLDER : String(value);
}

function badge(node, tone, label) {
  node.className = `badge badge-${tone}`;
  node.textContent = label;
}

function fillList(node, items, renderItem) {
  node.replaceChildren(...items.map(renderItem));
}

/* ---------------- 网络 ---------------- */

class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      credentials: 'omit',
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ApiError('响应不是合法 JSON', response.status, 'BAD_RESPONSE');
    }
    if (!response.ok) {
      const code = payload && payload.error ? payload.error.code : 'HTTP_ERROR';
      throw new ApiError('接口返回错误', response.status, code);
    }
    return payload;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error && error.name === 'AbortError') throw new ApiError('刷新超时', 0, 'TIMEOUT');
    throw new ApiError('网络请求失败', 0, 'NETWORK');
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- 横幅 ---------------- */

function showBanner(text, kind = 'refresh') {
  const node = $('banner');
  node.textContent = text;
  node.hidden = false;
  state.bannerKind = kind;
}

/** 只清除“刷新失败”类横幅；选中提示会保留到下一次列表变化。 */
function hideBanner(kind = 'refresh') {
  if (state.bannerKind !== kind) return;
  const node = $('banner');
  node.hidden = true;
  node.textContent = '';
  state.bannerKind = null;
}

function renderLedgerBanner(list) {
  const node = $('ledger-banner');
  const ledger = list && list.acceptanceLedger;
  if (!ledger) {
    node.hidden = true;
    return;
  }
  let text = null;
  if (!ledger.configured) {
    text = '未配置独立验收账本（--acceptance-ledger）：所有作业的验收状态都显示为“未提供验收记录”。';
  } else if (!ledger.readable) {
    text = `独立验收账本不可读（${ledger.errorCode || '未知原因'}）：验收状态一律为“未提供验收记录”。`;
  } else if (ledger.invalidEntries > 0 || ledger.ignoredKeys > 0) {
    text = `独立验收账本已读取，其中 ${ledger.invalidEntries} 条状态非法、${ledger.ignoredKeys} 个键名非法，已忽略。`;
  }
  if (text) {
    node.textContent = text;
    node.hidden = false;
  } else {
    node.hidden = true;
    node.textContent = '';
  }
}

/* ---------------- 顶部 ---------------- */

function renderMeta(meta) {
  setText('meta-root', meta.stateRoot ? meta.stateRoot.configured : null);
  const demoBadge = $('demo-badge');
  demoBadge.hidden = meta.demo !== true;
  if (meta.demo === true) demoBadge.textContent = '演示数据（非真实作业）';
  if (Number.isFinite(meta.refreshIntervalMs) && meta.refreshIntervalMs >= 1000) {
    state.intervalMs = meta.refreshIntervalMs;
  }
  const root = meta.stateRoot || {};
  const owner = meta.owner || {};
  const bits = [];
  bits.push(root.exists ? '状态根可访问' : `状态根不可访问${root.errorCode ? `（${root.errorCode}）` : ''}`);
  if (owner.present) {
    bits.push(
      Number.isFinite(owner.heartbeatAgeMs)
        ? `owner 心跳 ${Math.round(owner.heartbeatAgeMs / 1000)} 秒前${owner.stale ? '（已过期）' : '（新鲜）'}`
        : 'owner 心跳时间未知',
    );
  } else {
    bits.push('未见 owner.lock');
  }
  const listMetaSuffix = bits.join(' · ');
  return listMetaSuffix;
}

/* ---------------- 列表 ---------------- */

function statusBadgeCell(job) {
  const node = el('span');
  badge(node, job.statusTone || 'unknown', job.statusLabel || '未知状态');
  return node;
}

function renderList(list) {
  const rows = $('job-rows');
  const items = Array.isArray(list.jobs) ? list.jobs : [];

  rows.replaceChildren(
    ...items.map((job) => {
      const tr = el('tr');
      tr.tabIndex = 0;
      tr.dataset.jobId = job.jobId;
      if (job.jobId === state.selectedJobId) {
        tr.classList.add('is-selected');
        tr.setAttribute('aria-current', 'true');
      }

      tr.append(el('td', 'cell-name', job.name));
      const idCell = el('td', 'cell-id');
      idCell.append(el('code', null, job.jobId));
      tr.append(idCell);
      tr.append(el('td', null, job.modeLabel));
      const statusCell = el('td');
      statusCell.append(statusBadgeCell(job));
      tr.append(statusCell);
      tr.append(el('td', 'cell-time', fmtDateTime(job.startedAt || job.createdAt)));
      tr.append(
        el(
          'td',
          'cell-elapsed',
          `${fmtDuration(job.elapsedMs)}${job.elapsedFrozen ? '（已冻结）' : ''} / ${Number.isFinite(job.timeoutSeconds) ? fmtDuration(job.timeoutSeconds * 1000) : PLACEHOLDER}`,
        ),
      );

      const activate = () => selectJob(job.jobId);
      tr.addEventListener('click', activate);
      tr.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          activate();
        }
      });
      return tr;
    }),
  );

  const empty = $('list-empty');
  const source = list.source || {};
  empty.hidden = items.length > 0 || (list.unreadable || []).length > 0;
  if (!empty.hidden) {
    empty.textContent = source.enumerationErrorCode
      ? `读取作业目录失败（${source.enumerationErrorCode}）：无法确认是否存在作业，这不等于“没有作业”。`
      : source.stateRootExists === false
        ? '状态根目录不存在或不可访问。'
        : '作业目录存在，但没有找到任何合法作业记录。';
  }

  const metaBits = [];
  if (source.enumerationErrorCode) metaBits.push(`枚举失败：${source.enumerationErrorCode}`);
  const counts = list.counts || {};
  metaBits.push(`共 ${counts.totalJobDirectories ?? 0} 个作业目录，列出 ${counts.listed ?? items.length} 个`);
  if (counts.truncated) metaBits.push('已按上限截断');
  setText('list-meta', metaBits.join(' · '));

  const unreadableBlock = $('unreadable-block');
  const unreadable = Array.isArray(list.unreadable) ? list.unreadable : [];
  unreadableBlock.hidden = unreadable.length === 0;
  fillList($('unreadable-list'), unreadable, (entry) => {
    const li = el('li');
    li.append(el('code', null, entry.jobId));
    li.append(document.createTextNode(`：${entry.reason}${entry.code ? `（${entry.code}）` : ''}`));
    return li;
  });

  const notes = Array.isArray(list.notes) ? list.notes : [];
  fillList($('list-notes'), notes, (text) => el('li', null, text));

  renderLedgerBanner(list);
}

/* ---------------- 详情 ---------------- */

function renderElapsed(job) {
  if (!job) return;
  const sampledAtMs = Date.parse(job.__sampledAt || '');
  let elapsedMs = job.elapsedMs;
  if (!job.elapsedFrozen && Number.isFinite(elapsedMs) && Number.isFinite(sampledAtMs)) {
    elapsedMs += Math.max(0, Date.now() - sampledAtMs);
  }
  const limitText = Number.isFinite(job.timeoutSeconds) ? fmtDuration(job.timeoutSeconds * 1000) : PLACEHOLDER;
  setText('meter-text', `已用 ${fmtDuration(elapsedMs)} / 时限 ${limitText}`);
  setText(
    'meter-note',
    job.elapsedFrozen
      ? `终态用时按 endedAt 冻结${job.endedAt ? `（结束于 ${fmtDateTime(job.endedAt)}）` : '；记录缺少 endedAt，用时不可计算'}。`
      : '运行中用时按“开始时间到最近一次采样”计算；这里不显示完成百分比。',
  );

  const meter = $('meter');
  const fill = $('meter-fill');
  let ratio = null;
  if (Number.isFinite(job.timeUsedRatio)) ratio = job.timeUsedRatio;
  if (!job.elapsedFrozen && Number.isFinite(elapsedMs) && Number.isFinite(job.limitMs) && job.limitMs > 0) {
    ratio = Math.min(1, Math.max(0, elapsedMs / job.limitMs));
  }
  if (ratio === null) {
    meter.setAttribute('aria-valuenow', '0');
    meter.setAttribute('aria-valuetext', '用量未知');
    fill.style.width = '0%';
  } else {
    const pct = Math.round(ratio * 100);
    meter.setAttribute('aria-valuenow', String(pct));
    meter.setAttribute('aria-valuetext', `时限已用 ${pct}%`);
    fill.style.width = `${pct}%`;
  }
  meter.classList.toggle('is-over', job.timeExceeded === true);
  meter.classList.toggle('is-frozen', job.elapsedFrozen === true);
}

function renderActivity(activity) {
  const body = $('activity-rows');
  if (!activity) {
    body.replaceChildren();
    setText('activity-note', '无法获取活动信息。');
    return;
  }
  const rows = ['stdout', 'stderr'].map((key) => {
    const stream = activity.streams ? activity.streams[key] : null;
    const tr = el('tr');
    tr.append(el('td', null, key === 'stdout' ? 'stdout.log' : 'stderr.log'));
    tr.append(el('td', null, stream && stream.exists ? '存在' : `无文件${stream && stream.errorCode ? `（${stream.errorCode}）` : ''}`));
    tr.append(el('td', null, stream && stream.exists ? fmtBytes(stream.sizeBytes) : PLACEHOLDER));
    tr.append(el('td', null, stream && stream.exists ? fmtDateTime(stream.mtimeAt) : PLACEHOLDER));
    tr.append(el('td', null, stream ? fmtDelta(stream, activity.firstSample) : PLACEHOLDER));
    return tr;
  });
  body.replaceChildren(...rows);

  const notes = [];
  if (activity.note) notes.push(activity.note);
  if (activity.previousSampleAt) notes.push(`上次采样 ${fmtDateTime(activity.previousSampleAt)}`);
  const mismatch = ['stdout', 'stderr'].filter((k) => activity.streams && activity.streams[k] && activity.streams[k].recordedMismatch === true);
  if (mismatch.length > 0) {
    notes.push(`job.json 记录的字节数与文件实际大小不一致（${mismatch.join('、')}），以文件元数据为准。`);
  }
  const truncated = ['stdout', 'stderr'].filter((k) => activity.streams && activity.streams[k] && activity.streams[k].truncated === true);
  if (truncated.length > 0) {
    notes.push(`桥标记这些流已截断：${truncated.join('、')}（桥的每流上限，非本面板判断）。`);
  }
  setText('activity-note', notes.join(' '));
}

function renderDelivery(delivery) {
  const body = $('delivery-body');
  const metaNode = $('delivery-meta');
  const noteNode = $('delivery-note');
  const testNode = $('delivery-test');

  if (!delivery) {
    metaNode.textContent = '未获取交付信息。';
    testNode.textContent = '测试结果：未提供。';
    noteNode.textContent = '';
    body.hidden = true;
    return;
  }

  testNode.textContent = delivery.testResult
    ? `测试结果：${delivery.testResult.label} —— ${delivery.testResult.note}`
    : '测试结果：未提供。';

  if (!delivery.configured) {
    metaNode.textContent = `未配置交付目录（匹配：${delivery.label || '无'}）。`;
    noteNode.textContent = delivery.note || '';
    body.hidden = true;
    return;
  }

  if (!delivery.ok) {
    metaNode.textContent = `交付目录不可扫描：${delivery.errorCode || '未知原因'}。`;
    noteNode.textContent = '';
    body.hidden = true;
    return;
  }

  const counts = delivery.counts || {};
  const bits = [
    `白名单来源：${delivery.label}`,
    `文件 ${counts.files ?? 0} 个 · 跳过 ${counts.ignored ?? 0} 项 · 拒绝重解析点 ${counts.rejectedReparse ?? 0} 个`,
    `本次最多扫描 ${delivery.maxEntries} 项、深度 ${delivery.maxDepth}`,
  ];
  if (delivery.truncated) bits.push(`达到上限：${delivery.truncatedReason || '结果被截断'}`);
  metaNode.textContent = bits.join(' · ');
  noteNode.textContent = delivery.note || '';
  body.hidden = false;

  const files = Array.isArray(delivery.recentFiles) ? delivery.recentFiles : [];
  $('files-empty').hidden = files.length > 0;
  fillList($('file-rows'), files, (file) => {
    const tr = el('tr');
    tr.append(el('td', null, file.path));
    tr.append(el('td', null, fmtBytes(file.sizeBytes)));
    tr.append(el('td', null, fmtDateTime(new Date(file.mtimeMs).toISOString())));
    return tr;
  });

  const reports = Array.isArray(delivery.reportCandidates) ? delivery.reportCandidates : [];
  const reportList = $('report-list');
  if (reports.length === 0) {
    fillList(reportList, ['未观察到报告类文件（仅按文件名/目录名判断，未打开内容）。'], (text) => el('li', null, text));
  } else {
    fillList(reportList, reports, (file) => {
      const li = el('li');
      li.append(el('code', null, file.path));
      li.append(document.createTextNode(` · ${fmtBytes(file.sizeBytes)} · ${fmtDateTime(new Date(file.mtimeMs).toISOString())}`));
      return li;
    });
  }
}

function renderDetail(payload) {
  const empty = $('detail-empty');
  const body = $('detail-body');
  const job = payload.job;

  if (!job) {
    body.hidden = true;
    empty.hidden = false;
    empty.textContent = payload.recordError
      ? `该作业目录存在，但 job.json 无法解析（${payload.recordError.reason}，${payload.recordError.code}），不会当作“无作业”。`
      : '该作业暂无详情。';
    return;
  }

  empty.hidden = true;
  body.hidden = false;

  setText('job-name', job.name);
  setText('job-id', job.jobId);
  setText('job-mode', `模式：${job.modeLabel}`);
  setText('job-workspace', `工作区：${job.workspaceId || '未知'}`);
  setText('detail-meta', `采样时间 ${fmtDateTime(payload.sampledAt)}`);

  badge($('exec-badge'), job.statusTone || 'unknown', job.statusLabel || '未知状态');
  const execBits = [];
  execBits.push(job.statusKnown ? '' : '（状态字段无法识别，按未知状态展示）');
  if (job.exitCode !== null && job.exitCode !== undefined) execBits.push(`退出码 ${job.exitCode}`);
  if (job.signal) execBits.push(`信号 ${job.signal}`);
  if (job.timedOut === true) execBits.push('已超时');
  if (job.cancelRequested === true) execBits.push('已请求取消');
  if (job.recovered === true) execBits.push('为启动恢复记录');
  if (job.cleanup && job.cleanup.confirmed === false) execBits.push('进程停止未确认');
  setText('exec-detail', execBits.filter(Boolean).join(' · ') || '—');
  setText('exec-disclaimer', payload.executionDisclaimer || '');

  badge($('acc-badge'), job.acceptance.tone, job.acceptance.label);
  const accBits = [];
  if (job.acceptance.reviewedAt) accBits.push(`复核日期 ${job.acceptance.reviewedAt}`);
  if (job.acceptance.status === 'none') {
    accBits.push(job.acceptance.ledgerReadable ? '账本中没有该作业的条目' : '账本缺失或不可读');
  }
  setText('acc-detail', accBits.join(' · ') || '—');

  job.__sampledAt = payload.sampledAt;
  renderElapsed(job);

  setText('time-created', fmtDateTime(job.createdAt));
  setText('time-started', fmtDateTime(job.startedAt));
  setText('time-ended', fmtDateTime(job.endedAt));
  setText('text-exit', job.exitCode === null || job.exitCode === undefined ? PLACEHOLDER : String(job.exitCode));
  setText('text-errorcode', job.errorCode || PLACEHOLDER);
  setText('text-errorlabel', job.errorLabel || '');

  renderActivity(payload.activity);
  renderDelivery(payload.delivery);

  const notes = Array.isArray(payload.notes) ? payload.notes.slice() : [];
  const warnings = Array.isArray(payload.recordWarnings) ? payload.recordWarnings : [];
  for (const warning of warnings) notes.push(`记录字段：${warning}`);
  fillList($('detail-notes'), notes.length > 0 ? notes : ['无额外说明。'], (text) => el('li', null, text));

  const errorBlock = $('record-error-block');
  errorBlock.hidden = true;
  $('record-error-text').textContent = '';
}

/* ---------------- 选择与刷新 ---------------- */

function selectJob(jobId) {
  if (state.selectedJobId === jobId) return;
  state.selectedJobId = jobId;
  if (location.hash !== `#${jobId}`) {
    history.replaceState(null, '', `#${jobId}`);
  }
  if (state.list) renderList(state.list);
  void refreshAll('select');
}

function ensureSelection(list) {
  const jobs = Array.isArray(list.jobs) ? list.jobs : [];
  const ids = new Set(jobs.map((job) => job.jobId));
  const wanted = state.selectedJobId;
  if (wanted && ids.has(wanted)) return;
  if (wanted && !ids.has(wanted)) {
    showBanner(`所选作业 ${wanted} 已不在当前列表中（可能被移除或记录损坏），已切换到最新作业。`, 'selection');
  }
  state.selectedJobId = jobs.length > 0 ? jobs[0].jobId : null;
  if (state.selectedJobId) history.replaceState(null, '', `#${state.selectedJobId}`);
}

async function refreshAll(reason) {
  if (state.inFlight) return;
  state.inFlight = true;
  try {
    const meta = await fetchJson('/api/meta', 4000);
    state.meta = meta;
    renderMeta(meta);

    const list = await fetchJson('/api/jobs', 6000);
    state.list = list;
    ensureSelection(list);
    renderList(list);

    if (state.selectedJobId) {
      try {
        const detail = await fetchJson(`/api/jobs/${encodeURIComponent(state.selectedJobId)}`, 6000);
        state.detail = detail;
        renderDetail(detail);
      } catch (error) {
        if (error instanceof ApiError && error.code === 'JOB_NOT_FOUND') {
          state.detail = null;
          $('detail-body').hidden = true;
          $('detail-empty').hidden = false;
          $('detail-empty').textContent = '所选作业已不存在。';
        } else {
          throw error;
        }
      }
    } else {
      state.detail = null;
      $('detail-body').hidden = true;
      $('detail-empty').hidden = false;
      $('detail-empty').textContent = '当前没有可显示的作业。';
    }

    state.lastSuccessAt = Date.now();
    state.failures = 0;
    hideBanner();
    setText('meta-refresh', fmtClock(state.lastSuccessAt));
    const stateNode = $('refresh-state');
    stateNode.className = 'refresh-state is-ok';
    stateNode.textContent = `刷新成功（${reason === 'manual' ? '手动' : reason === 'resume' ? '恢复可见' : '自动'}）`;
  } catch (error) {
    state.failures += 1;
    const stateNode = $('refresh-state');
    stateNode.className = 'refresh-state is-error';
    stateNode.textContent = `刷新失败（连续 ${state.failures} 次）`;
    const suffix =
      state.lastSuccessAt === null
        ? '尚无成功采样。'
        : `保留上次成功采样 ${fmtDateTime(new Date(state.lastSuccessAt).toISOString())}。`;
    const code = error instanceof ApiError ? error.code : 'UNKNOWN';
    showBanner(`无法刷新监控数据（${code}）。页面继续显示上一次成功采样的结果。${suffix}`);
    // 失败时仍保留上一次成功的渲染结果（不清空 DOM）。
  } finally {
    state.inFlight = false;
    schedule();
  }
}

function schedule() {
  if (state.timer !== null) clearTimeout(state.timer);
  if (state.paused) {
    state.timer = null;
    return;
  }
  state.timer = setTimeout(() => {
    state.timer = null;
    void refreshAll('auto');
  }, state.intervalMs);
}

function init() {
  const hash = location.hash.startsWith('#job-') ? location.hash.slice(1) : null;
  state.selectedJobId = hash;

  $('refresh-now').addEventListener('click', () => {
    void refreshAll('manual');
  });

  window.addEventListener('hashchange', () => {
    const wanted = location.hash.startsWith('#job-') ? location.hash.slice(1) : null;
    if (wanted && wanted !== state.selectedJobId) {
      state.selectedJobId = wanted;
      void refreshAll('hash');
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      state.paused = true;
      if (state.timer !== null) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      const node = $('refresh-state');
      node.className = 'refresh-state';
      node.textContent = '页面不可见，已暂停自动刷新';
    } else {
      state.paused = false;
      void refreshAll('resume');
    }
  });

  state.ticker = setInterval(() => {
    if (state.detail && state.detail.job) renderElapsed(state.detail.job);
  }, 1000);

  void refreshAll('init');
}

init();
