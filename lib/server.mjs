import fs from 'node:fs/promises';
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { RouteCollector } from './collector.mjs';

/** Start a read-only loopback page service; each host process gets a fresh page capability. */
export async function startServer({ port = 3491, gateway = '', configDir = '', webRoot = new URL('../web/', import.meta.url),
  collector = new RouteCollector({ gateway, configDir }) } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('页面服务端口无效');
  const capability = randomBytes(32).toString('hex');
  const server = http.createServer(async (request, response) => {
    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    const host = request.headers.host || '';
    let authority;
    try {
      authority = new URL(`http://${host}`);
      // Browsers omit :80 from Host; compare its effective port and reject non-authority input.
      if (!['127.0.0.1', 'localhost'].includes(authority.hostname) || Number(authority.port || 80) !== actualPort
        || authority.username || authority.password || authority.pathname !== '/' || authority.search || authority.hash) throw new Error();
    } catch { response.writeHead(403).end(); return; }
    const origin = request.headers.origin;
    if (origin && origin !== 'null' && origin !== authority.origin) {
      response.writeHead(403).end(); return;
    }
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self' http://127.0.0.1:${actualPort} http://localhost:${actualPort}; style-src 'self' 'unsafe-inline' http://127.0.0.1:${actualPort} http://localhost:${actualPort}; img-src 'self' data:; connect-src 'self' http://127.0.0.1:${actualPort} http://localhost:${actualPort}; frame-ancestors 'self' wails://localhost http://127.0.0.1:* http://localhost:*`);
    let pathname;
    try { pathname = new URL(request.url, `http://${host}`).pathname; }
    catch { response.writeHead(400).end(); return; }
    if (request.method === 'OPTIONS' && pathname === '/api/state' && origin === 'null') {
      response.setHeader('Access-Control-Allow-Origin', 'null');
      response.setHeader('Access-Control-Allow-Headers', 'X-Route-Monitor-Key');
      response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD');
      response.setHeader('Vary', 'Origin');
      response.writeHead(204).end(); return;
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end(); return;
    }
    try {
      if (pathname === '/api/state') {
        const supplied = Buffer.from(String(request.headers['x-route-monitor-key'] || ''));
        const expected = Buffer.from(capability);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
          response.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' })
            .end(JSON.stringify({ error: '页面连接已过期，请重新打开路由监控' }));
          return;
        }
        // The capability-bearing HTML has no CORS. Only a successfully
        // authenticated API read is exposed to Magpie's opaque frame.
        if (origin === 'null') {
          response.setHeader('Access-Control-Allow-Origin', 'null');
          response.setHeader('Vary', 'Origin');
        }
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.end(request.method === 'HEAD' ? undefined : JSON.stringify(collector.getState()));
        return;
      }
      const files = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'],
        '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      const file = files[pathname];
      if (!file) { response.writeHead(404).end(); return; }
      // Scripts and styles contain no private data; opaque frames may
      // load them, while another frame cannot fetch the HTML capability.
      if (origin === 'null' && file[0] !== 'index.html') {
        response.setHeader('Access-Control-Allow-Origin', 'null');
        response.setHeader('Vary', 'Origin');
      }
      const source = await fs.readFile(new URL(file[0], webRoot), 'utf8');
      response.setHeader('Content-Type', `${file[1]}; charset=utf-8`);
      response.end(request.method === 'HEAD' ? undefined : source.replaceAll('__ROUTE_MONITOR_CAPABILITY__', capability));
    } catch {
      response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' })
        .end(JSON.stringify({ error: '监控页面暂不可用，请重新打开或检查插件日志' }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  server.unref();
  collector.start();
  return {
    port: server.address().port, server, collector,
    /** Stop observer reads before closing the service to release every socket and timer. */
    async close() {
      await collector.stop();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
