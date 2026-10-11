/* dsh-job-monitor 客户端（手写 bundle，无需构建）
 *
 * 这是 M01 只读面板（dsh-monitor/public/app.js + styles.css）在 DSH 右侧栏里的等价移植：
 *   - 所有刷新语义逐条照搬：inFlight 重叠保护、meta 4000ms / list 6000ms / detail 6000ms 超时、
 *     JOB_NOT_FOUND 单独处理、连续失败计数、保留上次成功采样、ensureSelection 回落提示、
 *     不可读记录单独列出、空态文案不宣称“没有作业”、终态用时冻结、运行中用时按采样时刻外推。
 *   - 所有动态文字都通过 React 文本节点渲染（等价于基线的 textContent），不使用 innerHTML。
 *   - 只访问同源 /dsh-job-monitor/api/*，绝不直连其它端口。
 *   - props.visible 为 false（标签不可见 / 面板收起）时暂停轮询；恢复可见时立刻补一次刷新。
 *   - 只 require 平台基座里已有的 'react'；只用 React.createElement，不用 JSX。
 *   - 样式全部挂在 .djm 根类下，不污染 DSH 界面；色板与基线 styles.css 一致（含深色变体）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-job-monitor',
  factory: function (require) {
    var module = { exports: {} };

    var React = require('react');
    var h = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useRef = React.useRef;
    var useCallback = React.useCallback;

    var API = '/dsh-job-monitor/api';
    var PLACEHOLDER = '—';
    var META_TIMEOUT_MS = 4000;
    var LIST_TIMEOUT_MS = 6000;
    var DETAIL_TIMEOUT_MS = 6000;
    var REASON_LABEL = { init: '初始化', manual: '手动', resume: '恢复可见', select: '选择', auto: '自动' };

    /* ---------------- 样式 ---------------- */

    var STYLE_ID = 'dsh-job-monitor-css';
    var CSS = `
.djm{--djm-bg:var(--dsw-alias-bg-layer-1,#f6f8fc);--djm-panel:var(--dsw-alias-bg-layer-2,#ffffff);--djm-ink:var(--dsw-alias-label-primary,#1c2c45);--djm-ink-soft:var(--dsw-alias-label-secondary,#4a5b74);--djm-ink-mute:var(--dsw-alias-label-secondary,#6b7a91);--djm-run:var(--dsw-alias-brand-primary,#2f5fb6);--djm-ok:var(--dsw-alias-state-success-primary,#2d806a);--djm-warn:var(--dsw-alias-state-warn-primary,#a06917);--djm-bad:var(--dsw-alias-state-error-primary,#ad4054);--djm-unknown:var(--dsw-alias-state-idle-primary,#6b7a91);--djm-line:var(--dsw-alias-border-l1,#d8e0ec);--djm-line-strong:var(--dsw-alias-border-l2,#b9c6d9);--djm-run-bg:color-mix(in srgb,var(--djm-run) 12%,var(--djm-panel));--djm-ok-bg:color-mix(in srgb,var(--djm-ok) 12%,var(--djm-panel));--djm-warn-bg:color-mix(in srgb,var(--djm-warn) 12%,var(--djm-panel));--djm-bad-bg:color-mix(in srgb,var(--djm-bad) 12%,var(--djm-panel));--djm-unknown-bg:color-mix(in srgb,var(--djm-unknown) 14%,var(--djm-panel));--djm-focus:var(--dsw-alias-brand-primary,#2f5fb6);background:var(--djm-bg);color:var(--djm-ink);font-family:"Microsoft YaHei UI","Microsoft YaHei","Segoe UI",system-ui,-apple-system,"Noto Sans SC",sans-serif;font-size:13px;line-height:1.55;padding:12px 14px 20px;max-width:100%;height:100%;overflow:auto;overflow-wrap:anywhere}
.djm *{box-sizing:border-box}
.djm[data-djm-theme="light"]{--djm-bg:#f6f8fc;--djm-panel:#ffffff;--djm-ink:#1c2c45;--djm-ink-soft:#4a5b74;--djm-ink-mute:#6b7a91;--djm-run:#2f5fb6;--djm-ok:#2d806a;--djm-warn:#a06917;--djm-bad:#ad4054;--djm-unknown:#6b7a91;--djm-line:#d8e0ec;--djm-line-strong:#b9c6d9;--djm-run-bg:#eaf1fd;--djm-ok-bg:#e8f4f0;--djm-warn-bg:#fbf2e2;--djm-bad-bg:#fbecef;--djm-unknown-bg:#eef1f6;--djm-focus:#2f5fb6}
.djm[data-djm-theme="dark"]{--djm-bg:#121821;--djm-panel:#1a222d;--djm-ink:#e6edf6;--djm-ink-soft:#b6c2d2;--djm-ink-mute:#8b98ab;--djm-run:#6ea0f0;--djm-ok:#5fbf9a;--djm-warn:#d6a24d;--djm-bad:#e0788c;--djm-unknown:#8b98ab;--djm-line:#2a3543;--djm-line-strong:#3b4a5c;--djm-run-bg:#1e2b3f;--djm-ok-bg:#16292a;--djm-warn-bg:#2b2418;--djm-bad-bg:#2b1c21;--djm-unknown-bg:#212a36;--djm-focus:#6ea0f0}
.djm h1,.djm h2,.djm h3{margin:0;font-weight:600;line-height:1.3}
.djm h1{font-size:17px}
.djm h2{font-size:15px}
.djm h3{font-size:13.5px;margin-bottom:5px}
.djm code,.djm .mono{font-family:"Cascadia Code",Consolas,"Courier New",monospace;font-size:0.92em}
.djm-head{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:flex-start;justify-content:space-between}
.djm-brand-sub{color:var(--djm-ink-mute);font-size:12px;margin-top:2px}
.djm-actions{display:flex;flex-wrap:wrap;gap:6px}
.djm-btn{font:inherit;color:var(--djm-run);background:var(--djm-panel);border:1px solid var(--djm-run);border-radius:4px;padding:3px 9px;cursor:pointer}
.djm-btn:hover{background:var(--djm-run-bg)}
.djm-btn:disabled{opacity:.55;cursor:default}
.djm-kv{color:var(--djm-ink-soft);font-size:12px;margin-top:7px}
.djm-kv-label{color:var(--djm-ink-mute)}
.djm-refresh{font-size:12px;margin-top:3px;color:var(--djm-ink-mute)}
.djm-refresh.is-ok{color:var(--djm-ok)}
.djm-refresh.is-error{color:var(--djm-bad);font-weight:600}
.djm-banner{margin:10px 0 0;padding:8px 10px;border:1px solid var(--djm-bad);border-left-width:4px;border-radius:3px;background:var(--djm-bad-bg);color:var(--djm-ink)}
.djm-banner.is-soft{border-color:var(--djm-warn);background:var(--djm-warn-bg)}
.djm-panel{background:var(--djm-panel);border:1px solid var(--djm-line);border-radius:4px;padding:10px 12px 12px;margin-top:12px}
.djm-panel-head{display:flex;flex-wrap:wrap;gap:4px 12px;align-items:baseline;justify-content:space-between;border-bottom:1px solid var(--djm-line);padding-bottom:6px;margin-bottom:8px}
.djm-meta{color:var(--djm-ink-mute);font-size:11.5px}
.djm-empty{color:var(--djm-ink-mute);padding:8px 0}
.djm-table-wrap{overflow-x:auto;max-width:100%}
.djm table{width:100%;max-width:100%;border-collapse:collapse;font-size:12.5px}
.djm th,.djm td{text-align:left;padding:6px 6px;border-bottom:1px solid var(--djm-line);vertical-align:top}
.djm thead th{color:var(--djm-ink-mute);font-weight:600;font-size:11.5px;border-bottom:1px solid var(--djm-line-strong);white-space:nowrap}
.djm-jobs tbody tr{cursor:pointer}
.djm-jobs tbody tr:hover{background:var(--djm-run-bg)}
.djm-jobs tbody tr.is-selected{background:var(--djm-run-bg);box-shadow:inset 3px 0 0 var(--djm-run)}
.djm-jobs td.cell-id code{word-break:break-all;color:var(--djm-ink-soft)}
.djm .cell-name{font-weight:600}
.djm .cell-time,.djm .cell-elapsed{white-space:nowrap;font-variant-numeric:tabular-nums}
.djm .badge{display:inline-block;padding:1px 8px;border-radius:999px;border:1px solid var(--djm-line-strong);background:var(--djm-unknown-bg);color:var(--djm-ink);font-size:12px;white-space:nowrap}
.djm .badge-run{border-color:var(--djm-run);color:var(--djm-run);background:var(--djm-run-bg)}
.djm .badge-ok{border-color:var(--djm-ok);color:var(--djm-ok);background:var(--djm-ok-bg)}
.djm .badge-warn{border-color:var(--djm-warn);color:var(--djm-warn);background:var(--djm-warn-bg)}
.djm .badge-bad{border-color:var(--djm-bad);color:var(--djm-bad);background:var(--djm-bad-bg)}
.djm .badge-unknown{border-color:var(--djm-unknown);color:var(--djm-unknown);background:var(--djm-unknown-bg)}
.djm .badge-demo{border-color:var(--djm-bad);background:var(--djm-bad);color:#fff;font-weight:600}
.djm .tag{display:inline-block;padding:1px 8px;border:1px solid var(--djm-line-strong);border-radius:3px;color:var(--djm-ink-soft);font-size:12px}
.djm .detail-name{font-size:14.5px;font-weight:600}
.djm .detail-id{margin-top:3px;color:var(--djm-ink-soft);font-size:12px}
.djm .detail-id code{word-break:break-all}
.djm .status-card{border:1px solid var(--djm-line);border-left:3px solid var(--djm-line-strong);border-radius:3px;padding:7px 9px;margin-top:8px}
.djm .status-card-title{color:var(--djm-ink-mute);font-size:11.5px}
.djm .status-line{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:4px 0 2px}
.djm .status-note{color:var(--djm-ink-soft);font-size:12px}
.djm .disclaimer{color:var(--djm-ink-mute);font-size:11px;margin-top:4px}
.djm .meter-head{display:flex;justify-content:space-between;gap:10px;font-size:12px;color:var(--djm-ink-soft);margin-top:10px}
.djm .meter{margin-top:4px;height:9px;border:1px solid var(--djm-line-strong);border-radius:3px;background:var(--djm-unknown-bg);overflow:hidden}
.djm .meter-fill{display:block;height:100%;width:0;background:var(--djm-run)}
.djm .meter.is-over{border-color:var(--djm-bad)}
.djm .meter.is-over .meter-fill{background:var(--djm-bad)}
.djm .meter.is-frozen .meter-fill{background:var(--djm-ink-mute)}
.djm .times{margin-top:10px;padding-top:8px;border-top:1px solid var(--djm-line);font-size:12px;color:var(--djm-ink-soft)}
.djm .times div{margin-bottom:2px}
.djm .times code{word-break:break-all}
.djm .sub-block{margin-top:12px;padding-top:10px;border-top:1px solid var(--djm-line)}
.djm .sub-block.is-warn{border-top-color:var(--djm-bad)}
.djm .notes{margin:5px 0 0;padding-left:16px;color:var(--djm-ink-soft);font-size:12px}
.djm .notes li{margin-bottom:2px}
.djm .notes code{word-break:break-all}
.djm .files td:first-child{word-break:break-all}
.djm .files td:not(:first-child){white-space:nowrap;font-variant-numeric:tabular-nums}
.djm .footer{margin-top:12px;color:var(--djm-ink-mute);font-size:11.5px}
.djm .footer code{color:var(--djm-ink-soft)}
.djm :focus-visible{outline:2px solid var(--djm-focus);outline-offset:2px}
.djm-jobs tbody tr:focus-visible{outline:2px solid var(--djm-focus);outline-offset:-2px}
.djm .djm-panel{max-width:100%}
@media (max-width:520px){.djm{padding:10px 10px 16px}.djm .djm-panel{padding:8px 9px 10px}.djm-jobs th:nth-child(3),.djm-jobs td:nth-child(3),.djm-jobs th:nth-child(5),.djm-jobs td:nth-child(5){display:none}}
@media (max-width:380px){.djm{font-size:12.5px}.djm-jobs th:nth-child(2),.djm-jobs td:nth-child(2){display:none}.djm th,.djm td{padding:5px 4px}}
@media (prefers-reduced-motion:reduce){.djm *,.djm *::before,.djm *::after{animation-duration:.001ms!important;transition-duration:.001ms!important}}
@media (forced-colors:active){.djm .badge,.djm .tag,.djm .djm-panel,.djm .djm-banner{border:1px solid CanvasText}}
`;

    /**
     * 注入面板样式。样式只挂在根类 .djm 下，不污染宿主页面；
     * 色板读 DSH 主题令牌（--dsw-alias-*），"自动"即跟随宿主明暗，基线色作 fallback。
     * 同一 STYLE_ID 只注入一次（重复挂载不产生重复 <style>）。
     */
    function ensureCss() {
      if (typeof document === 'undefined') return;
      if (document.getElementById(STYLE_ID)) return;
      var el = document.createElement('style');
      el.id = STYLE_ID;
      el.textContent = CSS;
      (document.head || document.documentElement).appendChild(el);
    }
    ensureCss();

    /* ---------------- 格式化（逐条照搬基线 app.js） ---------------- */

    /** 补零，用于时间显示。 */
    function pad(n) {
      return n < 10 ? `0${n}` : String(n);
    }

    /** ISO 时间 → 本地可读时间；无法解析时显示占位符，绝不显示"未知"以外的猜测。 */
    function fmtDateTime(iso) {
      if (!iso) return PLACEHOLDER;
      var ms = Date.parse(iso);
      if (Number.isNaN(ms)) return PLACEHOLDER;
      var d = new Date(ms);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    /** 毫秒时间戳 → 时:分:秒（用于"上次刷新于"这类短显示）。 */
    function fmtClock(ms) {
      var d = new Date(ms);
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    /** 毫秒时长 → "X天X小时X分X秒"；非有限值显示占位符。终态用时由服务端给出并冻结，运行中用外推值。 */
    function fmtDuration(ms) {
      if (ms === null || ms === undefined || !Number.isFinite(ms)) return PLACEHOLDER;
      var total = Math.max(0, Math.round(ms / 1000));
      var days = Math.floor(total / 86400);
      var hours = Math.floor((total % 86400) / 3600);
      var minutes = Math.floor((total % 3600) / 60);
      var seconds = total % 60;
      var parts = [];
      if (days > 0) parts.push(`${days}天`);
      if (hours > 0) parts.push(`${hours}小时`);
      if (minutes > 0) parts.push(`${minutes}分`);
      parts.push(`${seconds}秒`);
      return parts.join('');
    }

    /** 字节数 → 可读大小。只用于文件元数据（大小），不涉及文件内容。 */
    function fmtBytes(value) {
      if (value === null || value === undefined || !Number.isFinite(value)) return PLACEHOLDER;
      if (value < 1024) return `${value} B`;
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
      return `${(value / (1024 * 1024)).toFixed(2)} MiB`;
    }

    /**
     * 日志流活动描述：只依据"大小与修改时间"的变化，不读日志正文。
     * 缩小 = 文件被重建/截断（不是"内容变少"）；首次采样只记录基线，不宣称有活动。
     */
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

    /* ---------------- 网络（照搬基线 fetchJson / ApiError） ---------------- */

    /** 带 HTTP 状态与只读错误码（如 PATH_TRAVERSAL / JOB_NOT_FOUND）的错误对象。 */
    function ApiError(message, status, code) {
      var e = new Error(message);
      e.name = 'ApiError';
      e.status = status;
      e.code = code;
      return e;
    }

    /** 区分"接口返回的业务错误"与"网络/超时"，两者在横幅里文案不同。 */
    function isApiError(e) {
      return !!e && e.name === 'ApiError';
    }

    /**
     * 只读 GET 取 JSON：带超时（AbortController）、cache: 'no-store'（不吃缓存）、
     * credentials: 'omit'（不带凭据）。只访问同源 /dsh-job-monitor/api/*，绝不请求外部地址。
     * 非 2xx 时把服务端给的只读错误码带出来；超时/网络失败分别给出 TIMEOUT / NETWORK。
     */
    function fetchJson(url, timeoutMs, ctl) {
      var controller = new AbortController();
      if (ctl) ctl.controllers.add(controller);
      var timer = setTimeout(function () {
        controller.abort();
      }, timeoutMs);
      return fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        credentials: 'omit',
      })
        .then(function (response) {
          return response.text().then(function (text) {
            var payload = null;
            try {
              payload = JSON.parse(text);
            } catch {
              throw ApiError('响应不是合法 JSON', response.status, 'BAD_RESPONSE');
            }
            if (!response.ok) {
              var code = payload && payload.error ? payload.error.code : 'HTTP_ERROR';
              throw ApiError('接口返回错误', response.status, code);
            }
            return payload;
          });
        })
        .catch(function (error) {
          if (isApiError(error)) throw error;
          if (error && error.name === 'AbortError') throw ApiError('刷新超时', 0, 'TIMEOUT');
          throw ApiError('网络请求失败', 0, 'NETWORK');
        })
        .finally(function () {
          clearTimeout(timer);
          if (ctl) ctl.controllers.delete(controller);
        });
    }

    /* ---------------- 主题 ---------------- */

    var THEME_KEY = 'dsh-job-monitor-theme';
    var THEME_LABEL = { auto: '自动（跟随 DSH 主题）', light: '浅色', dark: '深色' };

    /** 读用户主题偏好（localStorage）。隐私模式里 localStorage 会抛异常，这里吞掉并回落默认。 */
    function prefGet() {
      try {
        return localStorage.getItem(THEME_KEY);
      } catch {
        return null;
      }
    }

    /** 系统级深色偏好探测；"自动"档实际由 CSS 里的 DSH 主题令牌决定，这里只用于兜底。 */
    function detectDark() {
      try {
        return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      } catch {
        return false;
      }
    }

    /** 主题初值：只接受 auto / light / dark，其它值一律回落 auto（跟随宿主）。 */
    function initialTheme() {
      var p = prefGet();
      if (p === 'light' || p === 'dark' || p === 'auto') return p;
      return 'auto';
    }

    /* ---------------- 面板 ---------------- */

    /**
     * 面板组件（M01 面板 public/app.js 在 React 侧边栏里的等价移植）。
     * props.visible 为 false（标签切走/窗口不可见）时暂停轮询，恢复可见立刻补一次刷新。
     * ctlRef 保存"跨渲染的控制状态"（重叠保护、连续失败计数、上次成功采样、定时器），
     * 这些量不参与渲染，放 ref 里避免闭包过期。所有动态文字都走 React 文本节点（等价 textContent），
     * 全文件不使用 innerHTML。
     */
    function Panel(props) {
      var visibleRef = useRef(props.visible);
      visibleRef.current = props.visible;

      var stMeta = useState(null);
      var meta = stMeta[0];
      var setMeta = stMeta[1];
      var stList = useState(null);
      var list = stList[0];
      var setList = stList[1];
      var stDetail = useState(null);
      var detail = stDetail[0];
      var setDetail = stDetail[1];
      var stCfg = useState(null);
      var cfg = stCfg[0];
      var setCfg = stCfg[1];
      var stSel = useState(null);
      var sel = stSel[0];
      var setSel = stSel[1];
      var stBanner = useState(null);
      var banner = stBanner[0];
      var setBanner = stBanner[1];
      var stRf = useState(null);
      var rf = stRf[0];
      var setRf = stRf[1];
      var stBusy = useState(false);
      var busy = stBusy[0];
      var setBusy = stBusy[1];
      var stTheme = useState(initialTheme());
      var theme = stTheme[0];
      var setTheme = stTheme[1];
      var stTick = useState(0);
      var tick = stTick[0];
      var setTick = stTick[1];

      var ctlRef = useRef({
        inFlight: false,
        disposed: false,
        epoch: 0,
        selectionVersion: 0,
        pendingSelect: false,
        controllers: new Set(),
        paused: false,
        lastSuccessAt: null,
        failures: 0,
        intervalMs: 5000,
        sel: null,
        timer: null,
      });
      var ctl = ctlRef.current;

      /**
       * 一次完整刷新：meta → jobs → 详情，串行执行。
       * inFlight 重叠保护（上一轮没回来就不启动下一轮）；
       * 选择项从列表里消失时给出明确提示并回落到最新作业，不静默清空选择；
       * JOB_NOT_FOUND 单独处理成"该作业记录不存在"，不当成网络故障；
       * 失败时只增加连续失败计数并显示横幅，**保留上次成功采样**，绝不显示空列表假装没有作业。
       */
      var refreshAll = useCallback(async function (reason) {
        if (ctl.disposed) return;
        if (ctl.inFlight) {
          if (reason === 'select') ctl.pendingSelect = true;
          return;
        }
        ctl.inFlight = true;
        var epoch = ctl.epoch;
        var selectionVersion = ctl.selectionVersion;
        function active() { return !ctl.disposed && ctl.epoch === epoch; }
        setBusy(true);
        try {
          // 整轮采样成功后统一更新；中途断连保留上一轮完整数据。
          var m = await fetchJson(API + '/meta', META_TIMEOUT_MS, ctl);
          if (!active()) return;
          var l = await fetchJson(API + '/jobs', LIST_TIMEOUT_MS, ctl);
          if (!active()) return;
          var jobs = Array.isArray(l.jobs) ? l.jobs : [];
          var wanted = ctl.sel;
          var selected = jobs.some(function (j) { return j.jobId === wanted; }) ? wanted : (jobs.length ? jobs[0].jobId : null);
          var notice = wanted && wanted !== selected ? { text: `所选作业 ${wanted} 已不在当前列表中（可能被移除或记录损坏），已切换到最新作业。`, kind: 'selection' } : null;
          var d = null;
          if (selected) {
            try { d = await fetchJson(API + '/jobs/' + encodeURIComponent(selected), DETAIL_TIMEOUT_MS, ctl); }
            catch (error) {
              if (isApiError(error) && error.code === 'JOB_NOT_FOUND') d = { notFound: true };
              else throw error;
            }
          }
          if (!active()) return;
          // 用户在请求期间换过作业，旧详情不得覆盖新选择，随后补读最新选择。
          if (selectionVersion !== ctl.selectionVersion) { ctl.pendingSelect = true; return; }
          ctl.sel = selected;
          setSel(selected);
          setMeta(m);
          setList(l);
          setDetail(d);
          if (typeof m.refreshIntervalMs === 'number' && m.refreshIntervalMs >= 1000) ctl.intervalMs = m.refreshIntervalMs;
          ctl.lastSuccessAt = Date.now();
          ctl.failures = 0;
          setBanner(notice);
          setRf({ text: `刷新成功（${REASON_LABEL[reason] || '自动'}）`, kind: 'ok' });
        } catch (error) {
          if (!active()) return;
          ctl.failures += 1;
          var code = isApiError(error) ? error.code : 'UNKNOWN';
          var suffix = ctl.lastSuccessAt === null ? '尚无成功采样。' : `保留上次成功采样 ${fmtDateTime(new Date(ctl.lastSuccessAt).toISOString())}。`;
          setBanner({ text: `刷新失败（连续 ${ctl.failures} 次，${code}）：${String((error && error.message) || error)}。${suffix}`, kind: 'refresh' });
          setRf({ text: `刷新失败（连续 ${ctl.failures} 次）`, kind: 'error' });
        } finally {
          if (active()) {
            ctl.inFlight = false;
            setBusy(false);
            if (ctl.pendingSelect) { ctl.pendingSelect = false; refreshAll('select'); }
          }
        }
      }, [ctl]);

      /** 链式定时器：先清旧定时器，暂停时不排新定时器；间隔由 /api/meta 提供（默认 5 秒）。 */
      var schedule = useCallback(function () {
        if (ctl.timer) clearTimeout(ctl.timer);
        ctl.timer = null;
        if (ctl.paused || ctl.disposed) return;
        ctl.timer = setTimeout(function () {
          if (visibleRef.current) refreshAll('auto');
          schedule();
        }, ctl.intervalMs);
      }, [ctl, refreshAll]);

      // 挂载：先读一次配置状态（用于横幅里的"未配置"提示），再跑首轮刷新并启动定时器；
      // 卸载时清定时器 —— 关闭面板/停用插件只清理本面板自己的定时器，不触碰桥或模型作业。
      useEffect(function () {
        ctl.disposed = false;
        ctl.epoch += 1;
        ctl.inFlight = false;
        var epoch = ctl.epoch;
        fetchJson(API + '/config-status', META_TIMEOUT_MS, ctl)
          .then(function (c) {
            if (!ctl.disposed && ctl.epoch === epoch) setCfg(c);
          })
          .catch(function () {
            if (!ctl.disposed && ctl.epoch === epoch) setCfg({ ok: false, configWarnings: ['配置状态接口不可用。'] });
          });
        refreshAll('init').then(function () { if (!ctl.disposed && ctl.epoch === epoch) schedule(); });
        return function () {
          ctl.disposed = true;
          ctl.epoch += 1;
          ctl.pendingSelect = false;
          ctl.controllers.forEach(function (controller) { controller.abort(); });
          ctl.controllers.clear();
          if (ctl.timer) clearTimeout(ctl.timer);
          ctl.timer = null;
        };
      }, [refreshAll, schedule, ctl]);

      // 标签不可见 / 面板收起时暂停轮询；恢复可见时立刻补一次刷新
      useEffect(function () {
        if (props.visible) {
          if (ctl.paused) {
            ctl.paused = false;
            refreshAll('resume');
          }
          schedule();
        } else {
          ctl.paused = true;
          if (ctl.timer) clearTimeout(ctl.timer);
          ctl.timer = null;
          setRf({ text: '标签不可见，已暂停自动刷新', kind: '' });
        }
      }, [props.visible, refreshAll, schedule, ctl]);

      // 1 秒心跳：只为运行中的“用时”外推重绘（与基线 state.ticker 一致）
      useEffect(function () {
        var t = setInterval(function () {
          setTick(function (n) {
            return n + 1;
          });
        }, 1000);
        return function () {
          clearInterval(t);
        };
      }, []);

      /** 点击/键盘选中某行：换选择后立刻刷新详情；重复点同一行不重复请求。 */
      function selectJob(jobId) {
        if (ctl.sel === jobId) return;
        ctl.sel = jobId;
        ctl.selectionVersion += 1;
        setSel(jobId);
        setDetail(null);
        refreshAll('select');
      }

      /* ---- 渲染片段 ---- */

      /** 顶部状态行：状态根可达性、owner 心跳新鲜度、刷新间隔、只读声明。
       *  心跳"已过期"只表示超过 staleHeartbeatMs 没有新写入，不代表桥异常或作业卡死。 */
      function metaLine() {
        if (!meta) return null;
        var sr = meta.stateRoot || {};
        var rootText = sr.configured ? (sr.exists && sr.isDirectory ? '状态根可访问' : `状态根不可访问（${sr.errorCode || sr.errorLabel || '未知原因'}）`) : '未配置状态根';
        var owner = meta.owner || {};
        var ownerText = '未见 owner.lock';
        if (owner.heartbeatAt) {
          ownerText = `owner 心跳 ${Math.round((owner.heartbeatAgeMs || 0) / 1000)} 秒前（${owner.stale ? '已过期' : '新鲜'}）`;
        } else if (owner.errorCode) {
          ownerText = `未见 owner.lock（${owner.errorCode}）`;
        }
        return h(
          'div',
          { className: 'djm-kv' },
          h('span', { className: 'djm-kv-label' }, '状态根：'),
          rootText,
          ' · ',
          ownerText,
          ' · 刷新间隔 ',
          Math.round((meta.refreshIntervalMs || 5000) / 1000),
          ' 秒 · 只读',
        );
      }

      /** 验收账本横幅：账本不可读时明确说明"全部显示未提供验收记录"，不给出通过结论。 */
      function ledgerBanner() {
        var l = list && list.acceptanceLedger;
        if (!l) return null;
        if (!l.configured) {
          return h('div', { className: 'djm-banner is-soft' }, '未配置独立验收账本：所有作业的验收状态都显示为“未提供验收记录”。');
        }
        if (!l.readable) {
          return h('div', { className: 'djm-banner is-soft' }, `独立验收账本不可读（${l.errorCode || '未知原因'}）：验收状态一律为“未提供验收记录”。`);
        }
        if ((l.invalidEntries || 0) > 0 || (l.ignoredKeys || 0) > 0) {
          return h('div', { className: 'djm-banner is-soft' }, `独立验收账本已读取，其中 ${l.invalidEntries || 0} 条状态非法、${l.ignoredKeys || 0} 个键名非法，已忽略。`);
        }
        return null;
      }

      /** 配置横幅：显示宿主侧配置来源与逐条诊断（JSON 非法、字段非法、文件缺失）。 */
      function configBanner() {
        if (!cfg) return null;
        var w = cfg.configWarnings || [];
        if (!w.length) return null;
        return h(
          'div',
          { className: 'djm-banner is-soft' },
          `配置诊断（来源：${cfg.configSource || '未知'}）：`,
          h('ul', { className: 'notes' }, w.map(function (x, i) { return h('li', { key: i }, x); })),
        );
      }

      /** 列表计数行：枚举失败时明确写"枚举失败"，不写成"没有作业"。 */
      function listMeta() {
        if (!list) return null;
        var bits = [];
        var src = list.source || {};
        if (src.enumerationErrorCode) bits.push(`枚举失败：${src.enumerationErrorCode}`);
        var c = list.counts || {};
        bits.push(`共 ${c.totalJobDirectories || 0} 个作业目录，列出 ${c.listed || 0} 个`);
        if (c.truncated) bits.push('已按上限截断');
        return h('div', { className: 'djm-meta' }, bits.join(' · '));
      }

      /**
       * 作业列表表格。三种空态文案严格区分：枚举失败 / 状态根不可访问 / 目录存在但无合法记录。
       * 行可点击、可键盘（Enter/Space）选中，aria-current 标记当前选择；
       * 用时列对终态显示"（已冻结）"，对运行中显示按采样时刻外推的值。
       */
      function listBody() {
        var jobs = list && Array.isArray(list.jobs) ? list.jobs : [];
        if (!list) return h('div', { className: 'djm-empty' }, '正在读取…');
        if (jobs.length === 0) {
          var src = list.source || {};
          var text;
          if (src.enumerationErrorCode) text = `读取作业目录失败（${src.enumerationErrorCode}）：无法确认是否存在作业，这不等于“没有作业”。`;
          else if (src.stateRootExists === false) text = '状态根目录不存在或不可访问。';
          else text = '作业目录存在，但没有找到任何合法作业记录。';
          return h('div', { className: 'djm-empty' }, text);
        }
        return h(
          'div',
          { className: 'djm-table-wrap' },
          h(
            'table',
            { className: 'djm-jobs' },
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', null, '名称'),
                h('th', null, '作业 ID'),
                h('th', null, '模式'),
                h('th', null, '状态'),
                h('th', null, '开始'),
                h('th', null, '用时 / 时限'),
              ),
            ),
            h(
              'tbody',
              null,
              jobs.map(function (job) {
                return h(
                  'tr',
                  {
                    key: job.jobId,
                    className: ctl.sel === job.jobId ? 'is-selected' : '',
                    tabIndex: 0,
                    'aria-current': ctl.sel === job.jobId ? 'true' : undefined,
                    onClick: function () {
                      selectJob(job.jobId);
                    },
                    onKeyDown: function (e) {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        selectJob(job.jobId);
                      }
                    },
                  },
                  h('td', { className: 'cell-name' }, job.name || PLACEHOLDER),
                  h('td', { className: 'cell-id' }, h('code', null, job.jobId)),
                  h('td', null, job.modeLabel || PLACEHOLDER),
                  h('td', null, h('span', { className: `badge badge-${job.statusTone || 'unknown'}` }, job.statusLabel || '未知状态')),
                  h('td', { className: 'cell-time' }, fmtDateTime(job.startedAt || job.createdAt)),
                  h('td', { className: 'cell-elapsed' }, `${fmtDuration(job.elapsedMs)}${job.elapsedFrozen ? '（已冻结）' : ''} / ${fmtDuration((job.timeoutSeconds || 0) * 1000)}`),
                );
              }),
            ),
          ),
        );
      }

      /** 不可读的 job.json 单独列出（jobId + 原因 + 只读错误码），不与合法记录混在列表里。 */
      function unreadableBlock() {
        var items = list && Array.isArray(list.unreadable) ? list.unreadable : [];
        if (!items.length) return null;
        return h(
          'div',
          { className: 'sub-block is-warn' },
          h('h3', null, `不可读记录（${items.length}）`),
          h(
            'ul',
            { className: 'notes' },
            items.map(function (entry, i) {
              return h('li', { key: `${entry.jobId}-${i}` }, h('code', null, entry.jobId), `：${entry.reason}（${entry.code}）`);
            }),
          ),
        );
      }

      /** 通用说明列表（全部是服务端算好的可读文案，前端不做推断）。 */
      function notesBlock(items, className) {
        if (!items || !items.length) return null;
        return h('ul', { className: className || 'notes' }, items.map(function (n, i) { return h('li', { key: i }, n); }));
      }

      /** 运行中用时的外推：采样时刻到现在的增量只加在显示层，不改服务端数据；终态用冻结值不外推。 */
      function liveElapsed(job, sampledAt) {
        if (!job) return PLACEHOLDER;
        var ms = job.elapsedMs;
        if (!job.elapsedFrozen && Number.isFinite(ms) && sampledAt) {
          var sampledAtMs = Date.parse(sampledAt);
          if (Number.isFinite(sampledAtMs)) ms += Math.max(0, Date.now() - sampledAtMs);
        }
        return fmtDuration(ms);
      }

      /**
       * 详情区：执行状态、时限比例、验收状态、交付白名单与文件元数据。
       * 三种"无详情"情形分开表达：没有选择 / 作业不存在 / job.json 不可解析。
       * 执行侧只报状态与退出码等元数据，绝不给出"工作被接受"的结论；
       * 验收结论只来自独立账本，时限比例标注为"时限已用"，不是完成百分比。
       */
      function detailBody() {
        if (!detail) return h('div', { className: 'djm-empty' }, '当前没有可显示的作业。');
        if (detail.notFound) return h('div', { className: 'djm-empty' }, '所选作业已不存在。');
        if (!detail.job) {
          var rec = detail.recordError || {};
          return h(
            'div',
            { className: 'djm-empty' },
            `该作业目录存在，但 job.json 无法解析（${rec.reason || '未知原因'}，${rec.code || '未知码'}），不会当作“无作业”。`,
          );
        }
        var job = detail.job;
        var acc = job.acceptance || {};
        var execBits = [];
        if (!job.statusKnown) execBits.push('（状态字段无法识别，按未知状态展示）');
        if (job.exitCode !== null && job.exitCode !== undefined) execBits.push(`退出码 ${job.exitCode}`);
        if (job.signal) execBits.push(`信号 ${job.signal}`);
        if (job.timedOut) execBits.push('已超时');
        if (job.cancelRequested) execBits.push('已请求取消');
        if (job.recovered) execBits.push('为启动恢复记录');
        if (job.cleanup && job.cleanup.confirmed === false) execBits.push('进程停止未确认');

        var accBits = [];
        if (acc.reviewedAt) accBits.push(`复核日期 ${acc.reviewedAt}`);
        if (acc.status === 'none') accBits.push(acc.ledgerReadable ? '账本中没有该作业的条目' : '账本缺失或不可读');

        var activity = detail.activity;
        var delivery = detail.delivery;

        return h(
          'div',
          null,
          h('div', { className: 'detail-name' }, job.name || PLACEHOLDER),
          h('div', { className: 'detail-id' }, h('code', null, job.jobId), ' · ', job.modeLabel || PLACEHOLDER, ' · 工作区 ', job.workspaceId || PLACEHOLDER),
          h(
            'div',
            { className: 'status-card' },
            h('div', { className: 'status-card-title' }, '执行状态（桥记录）'),
            h(
              'div',
              { className: 'status-line' },
              h('span', { className: `badge badge-${job.statusTone || 'unknown'}` }, job.statusLabel || '未知状态'),
              h('span', { className: 'status-note' }, execBits.join(' · ') || PLACEHOLDER),
            ),
            h('div', { className: 'disclaimer' }, detail.executionDisclaimer || PLACEHOLDER),
          ),
          h(
            'div',
            { className: 'status-card' },
            h('div', { className: 'status-card-title' }, '验收状态（独立账本）'),
            h(
              'div',
              { className: 'status-line' },
              h('span', { className: `badge badge-${acc.tone || 'unknown'}` }, acc.label || '未提供验收记录'),
              h('span', { className: 'status-note' }, accBits.join(' · ')),
            ),
          ),
          h(
            'div',
            null,
            h(
              'div',
              { className: 'meter-head' },
              h('span', { className: 'meter-label' }, `用时 ${liveElapsed(job, detail.sampledAt)}`),
              h('span', { className: 'meter-text' }, `时限已用 ${Math.round((job.timeUsedRatio || 0) * 100)}% · 剩余 ${fmtDuration(job.remainingMs)}`),
            ),
            h(
              'div',
              {
                className: `meter${job.timeExceeded ? ' is-over' : ''}${job.elapsedFrozen ? ' is-frozen' : ''}`,
                role: 'meter',
                'aria-valuenow': Math.round((job.timeUsedRatio || 0) * 100),
                'aria-valuemin': 0,
                'aria-valuemax': 100,
                'aria-valuetext': `时限已用 ${Math.round((job.timeUsedRatio || 0) * 100)}%`,
              },
              h('span', { className: 'meter-fill', style: { width: `${Math.min(100, Math.round((job.timeUsedRatio || 0) * 100))}%` } }),
            ),
            h('div', { className: 'status-note' }, job.elapsedNote || PLACEHOLDER),
          ),
          h(
            'div',
            { className: 'times' },
            h('div', null, '创建 ', fmtDateTime(job.createdAt)),
            h('div', null, '开始 ', fmtDateTime(job.startedAt)),
            h('div', null, '结束 ', fmtDateTime(job.endedAt)),
            h('div', null, '采样于 ', fmtDateTime(detail.sampledAt)),
            h('div', null, '记录字节 ', fmtBytes(job.rawBytes), ' · 桥记录字节 ', fmtBytes(job.bytes), job.truncated ? ' · 桥已截断' : ''),
          ),
          activity
            ? h(
                'div',
                { className: 'sub-block' },
                h('h3', null, '活动（仅文件元数据）'),
                h(
                  'div',
                  { className: 'djm-table-wrap' },
                  h(
                    'table',
                    { className: 'files' },
                    h('thead', null, h('tr', null, h('th', null, '流'), h('th', null, '存在'), h('th', null, '大小'), h('th', null, '修改时间'), h('th', null, '变化'))),
                    h(
                      'tbody',
                      null,
                      ['stdout', 'stderr'].map(function (k) {
                        var s = activity.streams && activity.streams[k];
                        if (!s) return null;
                        return h(
                          'tr',
                          { key: k },
                          h('td', null, `${k}.log`),
                          h('td', null, s.exists ? '存在' : `无文件${s.errorCode ? `（${s.errorCode}）` : ''}`),
                          h('td', null, s.exists ? fmtBytes(s.sizeBytes) : PLACEHOLDER),
                          h('td', null, s.exists ? fmtDateTime(s.mtimeAt) : PLACEHOLDER),
                          h('td', null, fmtDelta(s, activity.firstSample)),
                        );
                      }),
                    ),
                  ),
                ),
                notesBlock(
                  [activity.note]
                    .filter(Boolean)
                    .concat(
                      ['stdout', 'stderr'].map(function (k) {
                        var s = activity.streams && activity.streams[k];
                        if (!s) return null;
                        if (s.recordedMismatch === true) return `job.json 记录的字节数与 ${k}.log 实际大小不一致（记录 ${fmtBytes(s.recordedBytes)}，实际 ${fmtBytes(s.sizeBytes)}），以文件元数据为准。`;
                        if (s.truncated === true) return `桥标记 ${k}.log 已截断（桥的每流上限，非本面板判断）。`;
                        return null;
                      }).filter(Boolean),
                    ),
                ),
              )
            : null,
          delivery
            ? h(
                'div',
                { className: 'sub-block' },
                h('h3', null, '交付与测试信息'),
                h('div', { className: 'status-note' }, `测试结果：${delivery.testResult ? delivery.testResult.label : '未提供'} —— ${delivery.testResult ? delivery.testResult.note : ''}`),
                !delivery.configured
                  ? [
                      h('div', { className: 'status-note', key: 'unconf' }, `未配置交付目录（匹配：${delivery.label || '无'}）。`),
                      // 与基线 app.js 一致：未配置时也要给出可操作说明（noteNode.textContent = delivery.note）
                      h('div', { className: 'disclaimer', key: 'unconf-note' }, delivery.note || ''),
                    ]
                  : !delivery.ok
                    ? h('div', { className: 'status-note' }, `交付目录不可扫描：${delivery.errorCode || '未知原因'}。`)
                    : h(
                        'div',
                        null,
                        h('div', { className: 'djm-meta' }, `白名单来源：${delivery.label} · 文件 ${delivery.counts ? delivery.counts.files : 0} 个 · 跳过 ${delivery.counts ? delivery.counts.ignored : 0} 项 · 拒绝重解析点 ${delivery.counts ? delivery.counts.rejectedReparse : 0} 个`),
                        h('div', { className: 'djm-meta' }, `本次最多扫描 ${delivery.maxEntries} 项、深度 ${delivery.maxDepth}${delivery.truncated ? ` · 达到上限：${delivery.truncatedReason}` : ''}`),
                        h(
                          'div',
                          { className: 'djm-table-wrap' },
                          h(
                            'table',
                            { className: 'files' },
                            h('thead', null, h('tr', null, h('th', null, '相对路径'), h('th', null, '大小'), h('th', null, '修改时间'))),
                            h(
                              'tbody',
                              null,
                              (delivery.recentFiles || []).map(function (f, i) {
                                return h('tr', { key: `${f.path}-${i}` }, h('td', null, f.path), h('td', null, fmtBytes(f.sizeBytes)), h('td', null, fmtDateTime(new Date(f.mtimeMs).toISOString())));
                              }),
                            ),
                          ),
                        ),
                        h(
                          'div',
                          { className: 'status-note' },
                          (delivery.reportCandidates || []).length
                            ? h('ul', { className: 'notes' }, (delivery.reportCandidates || []).map(function (c, i) { return h('li', { key: i }, `${c.path} · ${fmtBytes(c.sizeBytes)} · ${fmtDateTime(new Date(c.mtimeMs).toISOString())}`); }))
                            : '未观察到报告类文件（仅按文件名/目录名判断，未打开内容）。',
                        ),
                        h('div', { className: 'disclaimer' }, delivery.note || ''),
                      ),
              )
            : null,
          notesBlock(detail.notes),
        );
      }

      // 工具条：立即刷新 / 暂停·继续 / 主题（自动 → 浅色 → 深色，偏好存 localStorage）。
      // 暂停只停本面板的轮询，不影响桥、模型作业或宿主任何服务。
      var head = h(
        'div',
        { className: 'djm-head' },
        h(
          'div',
          null,
          h('h1', null, '作业监控'),
          h('div', { className: 'djm-brand-sub' }, '只读采样 · 经 DSH 宿主同源路由 · 不启动桥与模型作业'),
        ),
        h(
          'div',
          { className: 'djm-actions' },
          h('button', { className: 'djm-btn', disabled: busy, onClick: function () { refreshAll('manual'); } }, '立即刷新'),
          h(
            'button',
            {
              className: 'djm-btn',
              onClick: function () {
                ctl.paused = !ctl.paused;
                if (ctl.paused) {
                  if (ctl.timer) clearTimeout(ctl.timer);
                  ctl.timer = null;
                  setRf({ text: '已暂停自动刷新（数据保持上次成功采样）', kind: '' });
                } else {
                  refreshAll('manual');
                  schedule();
                }
                setTick(function (n) { return n + 1; });
              },
            },
            ctl.paused ? '继续自动刷新' : '暂停自动刷新',
          ),
          h(
            'button',
            {
              className: 'djm-btn',
              onClick: function () {
                var next = theme === 'auto' ? 'light' : theme === 'light' ? 'dark' : 'auto';
                try {
                  localStorage.setItem(THEME_KEY, next);
                } catch {
                  /* 存储不可用时仅本次生效 */
                }
                setTheme(next);
              },
            },
            `主题：${THEME_LABEL[theme]}`,
          ),
        ),
      );

      return h(
        'div',
        { className: 'djm', 'data-djm-theme': theme },
        head,
        metaLine(),
        rf ? h('div', { className: `djm-refresh${rf.kind === 'ok' ? ' is-ok' : rf.kind === 'error' ? ' is-error' : ''}` }, rf.text, ctl.lastSuccessAt ? ` · 上次成功 ${fmtDateTime(new Date(ctl.lastSuccessAt).toISOString())}` : '') : null,
        banner ? h('div', { className: 'djm-banner' }, banner.text) : null,
        ledgerBanner(),
        configBanner(),
        h(
          'div',
          { className: 'djm-panel' },
          h('div', { className: 'djm-panel-head' }, h('h2', null, '作业列表'), listMeta()),
          listBody(),
          unreadableBlock(),
          list && list.notes ? notesBlock(list.notes) : null,
        ),
        h(
          'div',
          { className: 'djm-panel' },
          h('div', { className: 'djm-panel-head' }, h('h2', null, '作业详情'), h('div', { className: 'djm-meta' }, detail && detail.sampledAt ? `采样于 ${fmtDateTime(detail.sampledAt)}` : '')),
          detailBody(),
        ),
        h(
          'div',
          { className: 'footer' },
          '本面板只读取 owner.lock 心跳、job.json 白名单字段与日志 stat；不读取日志正文、任务正文、请求正文、凭据，也不提供提交/取消/删除/重试/改配置。',
          ' “正常结束”只表示进程退出码为 0，不代表工作被接受；验收结论只来自独立账本。',
        ),
      );
    }

    /* ---------------- 注册右侧栏标签 ---------------- */

    /**
     * 注册右侧栏标签。ctx.effect 返回 disposer：标签卸载时由宿主调用，面板自己的定时器随之清理。
     * props.visible 由宿主传入，标签切走时面板暂停轮询（见 Panel 内的 visible 效应）。
     */
    function apply(ctx) {
      ctx.effect(function () {
        return ctx.betterSidebar.registerTab({
          id: 'dsh-job-monitor:jobs',
          title: '作业监控',
          description: '桥作业只读监控（复用 dsh-monitor 采样核心）',
          order: 60,
          single: true,
          component: function (p) {
            return h(Panel, p);
          },
        });
      });
    }

    var inject = ['betterSidebar'];

    // 不依赖装载器注入的自由变量 exports：只写自己声明的 module.exports 并返回它
    module.exports.apply = apply;
    module.exports.inject = inject;
    return module.exports;
  },
});
