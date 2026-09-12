import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { Readable } from 'node:stream';
import { fetchWithProxyPolicy, resolvePublicAddresses, validateProxyUrl } from '../../proxy/safe-fetch';

const MAX_REQUEST_BODY = 1024 * 1024;
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

async function readRequestBody(req: IncomingMessage): Promise<Buffer | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_REQUEST_BODY) throw new Error('浏览器请求体超过 1MB 安全上限');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

async function proxyHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const target = validateProxyUrl(req.url ?? '');
    if (target.protocol !== 'http:') throw new Error('HTTPS 请求必须使用 CONNECT');
    const body = await readRequestBody(req);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (HOP_BY_HOP.has(name.toLowerCase()) || value === undefined) continue;
      headers[name] = Array.isArray(value) ? value.join(', ') : value;
    }
    const upstream = await fetchWithProxyPolicy(target.toString(), {
      method: req.method,
      headers,
      body,
    }, 'public-only');
    res.statusCode = upstream.status;
    upstream.headers.forEach((value, name) => {
      // Undici exposes a decoded body; forwarding these two stale headers would corrupt it.
      if (HOP_BY_HOP.has(name) || name === 'content-encoding' || name === 'content-length') return;
      res.setHeader(name, value);
    });
    if (!upstream.body || req.method === 'HEAD') {
      await upstream.body?.cancel();
      res.end();
      return;
    }
    Readable.fromWeb(upstream.body as never).on('error', () => res.destroy()).pipe(res);
  } catch (error) {
    if (!res.headersSent) res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(error instanceof Error ? error.message : 'browser proxy rejected request');
  }
}

/**
 * Chromium connects only through this loopback proxy. CONNECT targets are DNS-resolved,
 * checked and pinned to the validated IP, closing the browser DNS-rebinding window.
 */
export async function createBrowserSafeProxy(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => { void proxyHttp(req, res); });
  server.on('connect', (req, clientSocket, head) => {
    void (async () => {
      try {
        const target = validateProxyUrl(`https://${req.url ?? ''}/`);
        const port = Number(target.port || 443);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('非法端口');
        const addresses = await resolvePublicAddresses(target.hostname);
        const upstream = connect({ host: addresses[0].address, port });
        upstream.once('connect', () => {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head.length) upstream.write(head);
          upstream.pipe(clientSocket);
          clientSocket.pipe(upstream);
        });
        upstream.once('error', () => clientSocket.destroy());
      } catch (error) {
        clientSocket.end(`HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n${error instanceof Error ? error.message : ''}`);
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法启动浏览器安全代理');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
