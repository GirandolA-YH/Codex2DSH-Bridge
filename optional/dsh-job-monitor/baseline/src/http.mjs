/**
 * HTTP surface: static assets + GET-only JSON API.
 *
 *  - non-GET/HEAD -> 405 with `Allow`; every mutating verb is unimplementable,
 *  - the static route table is a fixed allowlist, so `..`/encoded traversal
 *    cannot name a file that is not already listed,
 *  - no CORS header is ever emitted; the listener is loopback only,
 *  - dynamic strings reach the page through textContent only (see public/app.js).
 */
import fs from 'node:fs';
import http from 'node:http';
import { resolveRoot, safeResolve } from './paths.mjs';
import { DEFAULT_LIMITS } from './constants.mjs';

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

const HTML_CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const STATIC_ROUTES = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8', csp: true }],
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8', csp: true }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8', csp: false }],
  ['/styles.css', { file: 'styles.css', type: 'text/css; charset=utf-8', csp: false }],
]);

const MAX_URL_LENGTH = 2048;

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

function sendText(res, status, type, text, extraHeaders = {}) {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': type,
    'Content-Length': body.length,
    ...extraHeaders,
  });
  res.end(body);
}

export function createStaticReader(publicDir, maxStaticBytes) {
  const info = resolveRoot(publicDir);
  return {
    info,
    read(fileName) {
      if (!info.ok || !info.isDirectory) return { ok: false, code: info.code ?? 'ENOENT' };
      const resolved = safeResolve(info.real, [fileName]);
      if (!resolved.ok) return { ok: false, code: resolved.code };
      if (!resolved.stat.isFile()) return { ok: false, code: 'NOT_A_FILE' };
      if (resolved.stat.size > maxStaticBytes) return { ok: false, code: 'TOO_LARGE' };
      try {
        return { ok: true, body: fs.readFileSync(resolved.path) };
      } catch {
        return { ok: false, code: 'EACCES' };
      }
    },
  };
}

export function createRequestHandler({ monitor, publicDir, limits = DEFAULT_LIMITS, logger }) {
  const staticReader = createStaticReader(publicDir, limits.maxStaticBytes ?? DEFAULT_LIMITS.maxStaticBytes);

  return function handle(req, res) {
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, {
        ...SECURITY_HEADERS,
        Allow: 'GET, HEAD',
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ error: { code: 'METHOD_NOT_ALLOWED', message: '本面板只提供 GET 接口，不提供提交/取消/删除/重试/配置编辑。' } }));
      return;
    }

    const rawUrl = req.url ?? '/';
    if (rawUrl.length > MAX_URL_LENGTH) {
      sendJson(res, 414, { error: { code: 'URI_TOO_LONG', message: '请求地址过长' } });
      return;
    }

    let parsed;
    try {
      parsed = new URL(rawUrl, 'http://127.0.0.1');
    } catch {
      sendJson(res, 400, { error: { code: 'BAD_REQUEST', message: '请求地址无法解析' } });
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(parsed.pathname);
    } catch {
      sendJson(res, 400, { error: { code: 'BAD_REQUEST', message: '请求地址包含非法编码' } });
      return;
    }
    if (pathname.includes('\0') || pathname.includes('\\')) {
      sendJson(res, 400, { error: { code: 'BAD_REQUEST', message: '请求地址包含非法字符' } });
      return;
    }
    if (pathname.split('/').some((segment) => segment === '..' || segment === '.')) {
      sendJson(res, 400, { error: { code: 'PATH_TRAVERSAL', message: '请求地址包含路径遍历片段，已拒绝' } });
      return;
    }

    const isHead = method === 'HEAD';
    const json = (status, payload) => {
      if (isHead) {
        const body = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
        res.writeHead(status, {
          ...SECURITY_HEADERS,
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': body.length,
          'Cache-Control': 'no-store',
        });
        res.end();
        return;
      }
      sendJson(res, status, payload);
    };

    try {
      if (pathname === '/api/meta') {
        json(200, monitor.meta());
        return;
      }
      if (pathname === '/api/jobs') {
        json(200, monitor.list());
        return;
      }
      if (pathname.startsWith('/api/jobs/')) {
        const rest = pathname.slice('/api/jobs/'.length);
        if (rest === '' || rest.includes('/')) {
          json(404, { error: { code: 'NOT_FOUND', message: '未知接口' } });
          return;
        }
        const result = monitor.detail(rest);
        if (!result.ok) {
          json(result.httpStatus ?? 400, {
            error: { code: result.code, message: result.reason },
          });
          return;
        }
        json(200, result.value);
        return;
      }
      if (pathname.startsWith('/api/')) {
        json(404, { error: { code: 'NOT_FOUND', message: '未知接口' } });
        return;
      }
      if (pathname === '/favicon.ico') {
        res.writeHead(204, SECURITY_HEADERS);
        res.end();
        return;
      }

      const route = STATIC_ROUTES.get(pathname);
      if (route === undefined) {
        sendText(res, 404, 'text/plain; charset=utf-8', '404 未找到该资源');
        return;
      }
      const file = staticReader.read(route.file);
      if (!file.ok) {
        sendText(res, 500, 'text/plain; charset=utf-8', `500 静态资源不可用（${file.code}）`);
        return;
      }
      const headers = { 'Cache-Control': 'no-store' };
      if (route.csp) headers['Content-Security-Policy'] = HTML_CSP;
      if (isHead) {
        res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': route.type, 'Content-Length': file.body.length, ...headers });
        res.end();
        return;
      }
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': route.type, ...headers });
      res.end(file.body);
    } catch (error) {
      if (logger) logger(`request failed: ${error && error.code ? error.code : 'UNKNOWN'}`);
      if (!res.headersSent) {
        json(500, { error: { code: 'INTERNAL_ERROR', message: '面板内部错误（不显示原始异常文本）' } });
      } else {
        res.end();
      }
    }
  };
}

/**
 * Start the listener and resolve with the bound port. Rejects with a readable
 * message when the port is taken.
 */
export function startServer({ host, port, handler }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer({ requestTimeout: 15000, headersTimeout: 10000 }, (req, res) => {
      res.setHeader('X-DSH-Monitor', 'read-only');
      handler(req, res);
    });
    let settled = false;

    server.on('error', (error) => {
      if (settled) return;
      settled = true;
      const code = error && error.code ? error.code : 'UNKNOWN';
      if (code === 'EADDRINUSE') {
        reject(
          Object.assign(new Error(`端口 ${port} 已被占用（EADDRINUSE）。请停止占用该端口的进程，或用 --port 指定其它端口。`), {
            code,
          }),
        );
        return;
      }
      if (code === 'EACCES') {
        reject(Object.assign(new Error(`没有权限绑定 ${host}:${port}（EACCES）。请换用 1024 以上的端口。`), { code }));
        return;
      }
      reject(Object.assign(new Error(`监听 ${host}:${port} 失败（${code}）。`), { code }));
    });

    server.listen({ host, port, exclusive: true }, () => {
      if (settled) return;
      settled = true;
      const address = server.address();
      const boundPort = typeof address === 'object' && address !== null ? address.port : port;
      resolve({ server, port: boundPort, url: `http://${host}:${boundPort}/` });
    });
  });
}

