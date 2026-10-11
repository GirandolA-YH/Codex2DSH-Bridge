/**
 * DSH 宿主同源路由适配器。
 *
 * 目标：把 M01 只读面板挂到 DSH 自带 Web 服务（http://127.0.0.1:19387）的
 * /dsh-job-monitor/api/* 前缀上，因此：
 *   - 不新增监听端口（复用宿主端口，浏览器访问同源，无跨域、无 CORS）
 *   - 不内嵌 iframe（基线对 HTML 发 frame-ancestors 'none' / X-Frame-Options DENY）
 *   - 只读契约逐字节复用基线 createRequestHandler：非 GET/HEAD → 405 + Allow，
 *     过长 → 414，非法编码/路径遍历 → 400，未知接口 → 404，
 *     detail() 的 {ok:false, httpStatus, code, reason} → 对应 HTTP 状态 + {error:{code,message}}
 *
 * 本适配器额外做两件事：
 *   1) 只允许 /api/* 内部路径，静态资源（index.html/app.js/styles.css）永不可达，
 *      宿主上不存在可被 iframe 的 HTML 面；publicDir 指向一个不存在的目录作为第二道防线。
 *   2) 增加一个同样只读的 /api/config-status，用于展示配置来源与诊断。
 */
import { createRequestHandler } from '../baseline/src/http.mjs';

export const MOUNT = '/dsh-job-monitor';
export const API_PREFIX = `${MOUNT}/api`;

const MAX_URL_LENGTH = 2048;

// 只读面板的安全头：禁止被内嵌、禁止被跨源读取、禁 MIME 嗅探、禁引用外泄。从不发 CORS 头。
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

// 405 的固定文案：明确告诉调用方"没有写接口"，避免被当成可操作的提交面
const METHOD_NOT_ALLOWED = {
  error: {
    code: 'METHOD_NOT_ALLOWED',
    message: '本面板只提供 GET 接口，不提供提交/取消/删除/重试/配置编辑。',
  },
};

/** 统一 JSON 响应：带安全头 + no-store（监控数据不吃缓存），body 用 Buffer 保证 Content-Length 精确。 */
function sendJson(res, status, payload) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** 把挂载前缀剥掉，得到基线 handler 认识的内部路径。 */
function stripMount(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length > MAX_URL_LENGTH) {
    return { ok: false, status: 414, code: 'URI_TOO_LONG', message: '请求地址过长' };
  }
  if (!rawUrl.startsWith(API_PREFIX)) {
    return {
      ok: false,
      status: 404,
      code: 'NOT_FOUND',
      message: '未挂载该路径：本插件只提供 /dsh-job-monitor/api/* 只读接口，不提供静态页面。',
    };
  }
  let parsed;
  try {
    parsed = new URL(rawUrl, 'http://127.0.0.1');
  } catch {
    return { ok: false, status: 400, code: 'BAD_REQUEST', message: '请求地址无法解析' };
  }
  let pathname;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return { ok: false, status: 400, code: 'BAD_REQUEST', message: '请求地址包含非法编码' };
  }
  if (pathname.includes('\0') || pathname.includes('\\')) {
    return { ok: false, status: 400, code: 'BAD_REQUEST', message: '请求地址包含非法字符' };
  }
  if (pathname.split('/').some((segment) => segment === '..' || segment === '.')) {
    return { ok: false, status: 400, code: 'PATH_TRAVERSAL', message: '请求地址包含路径遍历片段，已拒绝' };
  }
  if (!pathname.startsWith(API_PREFIX)) {
    return { ok: false, status: 404, code: 'NOT_FOUND', message: '未知接口' };
  }
  const rest = pathname.slice(API_PREFIX.length);
  return { ok: true, url: `/api${rest}${parsed.search ?? ''}` };
}

/** 给基线 handler 一个能跟踪 headersSent 的响应包装；body 支持 string|Uint8Array。 */
function wrapRes(res) {
  let sent = false;
  return {
    get headersSent() {
      return sent;
    },
    writeHead(status, headers) {
      sent = true;
      return res.writeHead(status, headers);
    },
    end(body) {
      sent = true;
      return res.end(body);
    },
  };
}

export function createHostHandler({ monitor, limits, logger, configStatus, publicDir }) {
  const handler = monitor ? createRequestHandler({ monitor, publicDir, limits, logger }) : null;

  return async function handle(req, res) {
    const method = req.method ?? 'GET';
    const rawUrl = req.url ?? '/';
    // 在响应边界统一剔除 HEAD 正文，包括错误响应和配置诊断。
    if (method === 'HEAD') {
      const original = res;
      res = { writeHead: (...args) => original.writeHead(...args), end: () => original.end() };
    }

    const mount = stripMount(rawUrl);
    if (!mount.ok) {
      sendJson(res, mount.status, { error: { code: mount.code, message: mount.message } });
      return;
    }

    // config-status 由适配器自己处理（同样只读、同样 405 语义），其余交给基线只读契约
    if (mount.url.split('?')[0] === '/api/config-status') {
      if (method !== 'GET' && method !== 'HEAD') {
        res.writeHead(405, {
          ...SECURITY_HEADERS,
          Allow: 'GET, HEAD',
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(METHOD_NOT_ALLOWED));
        return;
      }
      sendJson(res, 200, configStatus());
      return;
    }

    if (!handler) {
      if (method !== 'GET' && method !== 'HEAD') {
        res.writeHead(405, { ...SECURITY_HEADERS, Allow: 'GET, HEAD', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(METHOD_NOT_ALLOWED));
      } else {
        sendJson(res, 503, { error: { code: 'CONFIG_NOT_CONFIGURED', message: '未配置状态根，暂停采样。请填写 stateRoot 后重启 DSH。' } });
      }
      return;
    }
    await handler({ method, url: mount.url, headers: req.headers ?? {} }, wrapRes(res));
  };
}
