import { Connection, BasicAuthenticator } from 'webdav-client';
import { DOMParser, type Document as XmlDocument } from '@xmldom/xmldom';
import { Readable, Transform } from 'node:stream';
import { promisify } from 'node:util';
import { TtlCache } from '../utils/ttl-cache';
import {
  parseByteRangeHeader,
  parseContentRangeHeader,
  resolveByteRange,
} from './proxy/byte-range';

const DEFAULT_TIMEOUT = 10000; // 10 秒

function withTimeout<T>(promise: Promise<T>, label: string, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new WebDAVError(`${label} 超时`, 'TIMEOUT')), DEFAULT_TIMEOUT);
    const abort = () => {
      const error = new Error('WebDAV 请求已取消');
      error.name = 'AbortError';
      reject(error);
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    });
  });
}

// 错误类型：携带错误码便于上层路由处理
export class WebDAVError extends Error {
  code: string;
  fileSize?: number;
  constructor(message: string, code: string, fileSize?: number) {
    super(message);
    this.name = 'WebDAVError';
    this.code = code;
    this.fileSize = fileSize;
  }
}

// 将底层抛出的异常包装为 WebDAVError，便于路由层根据 code 返回对应 HTTP 状态
function wrapWebDAVError(err: unknown): WebDAVError {
  if (err instanceof WebDAVError) return err;
  if (err instanceof Error && err.name === 'AbortError') {
    const wrapped = new WebDAVError('WebDAV 请求已取消', 'CANCELLED');
    wrapped.name = 'AbortError';
    return wrapped;
  }
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  if (lower.includes('timeout') || lower.includes('超时')) {
    return new WebDAVError('WebDAV 请求超时', 'TIMEOUT');
  }
  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('auth')) {
    return new WebDAVError('WebDAV 认证失败，请检查用户名和密码', 'AUTH_FAILED');
  }
  if (lower.includes('404') || lower.includes('not found') || lower.includes('不存在') || lower.includes('object not found')) {
    return new WebDAVError('文件不存在或路径错误', 'NOT_FOUND');
  }
  return new WebDAVError(message, 'UNREACHABLE');
}

const MAX_PROPERTY_RESPONSE_BYTES = 64 * 1024;

async function readBoundedText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > MAX_PROPERTY_RESPONSE_BYTES) {
    throw new WebDAVError('WebDAV 属性响应过大', 'UNREACHABLE');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (total <= MAX_PROPERTY_RESPONSE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PROPERTY_RESPONSE_BYTES) {
        throw new WebDAVError('WebDAV 属性响应过大', 'UNREACHABLE');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

function xmlPropertyText(document: XmlDocument, localName: string): string | undefined {
  const elements = document.getElementsByTagNameNS('DAV:', localName);
  const element = elements.length > 0 ? elements.item(0) : document.getElementsByTagName(localName).item(0);
  const value = element?.textContent?.trim();
  return value || undefined;
}

async function statWebDAVFileWithFetch(
  params: WebDAVConnectionParams,
  signal?: AbortSignal,
): Promise<WebDAVFileInfo> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  try {
    const headers: Record<string, string> = {
      Depth: '0',
      'Content-Type': 'application/xml; charset=utf-8',
    };
    if (params.username || params.password) {
      headers.Authorization = `Basic ${Buffer.from(`${params.username || ''}:${params.password || ''}`).toString('base64')}`;
    }
    const response = await fetch(`${normalizeServerUrl(params.serverUrl)}${normalizePath(params.path)}`, {
      method: 'PROPFIND',
      headers,
      body: '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>',
      signal: controller.signal,
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new WebDAVError('WebDAV 认证失败，请检查用户名和密码', 'AUTH_FAILED');
      if (response.status === 404) throw new WebDAVError('文件不存在或路径错误', 'NOT_FOUND');
      throw new WebDAVError(`WebDAV HTTP ${response.status}`, 'UNREACHABLE');
    }
    const document = new DOMParser().parseFromString(await readBoundedText(response), 'text/xml');
    const parserError = document.getElementsByTagName('parsererror').item(0);
    if (parserError) throw new WebDAVError('WebDAV 属性响应无效', 'UNREACHABLE');
    const name = xmlPropertyText(document, 'displayname') || params.path.split('/').filter(Boolean).pop() || '';
    const size = Number(xmlPropertyText(document, 'getcontentlength') || 0);
    const lastModifiedRaw = xmlPropertyText(document, 'getlastmodified');
    return {
      name,
      path: params.path,
      size: Number.isFinite(size) && size >= 0 ? size : 0,
      lastModified: lastModifiedRaw ? new Date(lastModifiedRaw) : undefined,
    };
  } catch (error) {
    if (error instanceof WebDAVError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      const cancelled = new Error(signal?.aborted ? 'WebDAV 请求已取消' : 'WebDAV 请求超时');
      cancelled.name = 'AbortError';
      throw cancelled;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export interface WebDAVConnectionParams {
  serverUrl: string;
  path: string;
  username?: string;
  password?: string;
}

export interface WebDAVFileInfo {
  name: string;
  path: string;
  size: number;
  lastModified?: Date;
}

function normalizePath(path: string): string {
  let normalized = path.trim();
  if (!normalized.startsWith('/')) normalized = '/' + normalized;
  // webdav-client 的 readdir/stat 等方法会把 path 直接拼到 URL，
  // 包含中文/空格等非 ASCII 字符时底层 http 库会抛
  // "Request path contains unescaped characters" 错误。
  // 对每段单独 encodeURIComponent，保留 / 分隔符。
  // 先 tryDecode 避免前端已编码过的路径被二次编码。
  // 注意：不做任何"乱码修复"——路径字符必须与服务器真实文件名逐字节一致，
  // 否则 PROPFIND/GET 404（部分网盘如 139Cloud 的文件名本身就是 Latin-1 乱码形态）。
  return normalized
    .split('/')
    .map((seg) => {
      if (!seg) return seg;
      try {
        return encodeURIComponent(decodeURIComponent(seg));
      } catch {
        return encodeURIComponent(seg);
      }
    })
    .join('/');
}

function normalizeServerUrl(url: string): string {
  let normalized = url.trim();
  while (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  return normalized;
}

// 计算 serverUrl 的 path 前缀，用于从 DAV 服务器返回的 href 中剥离
// 例如 serverUrl = "http://host/dav"，则前缀为 "/dav"
function getServerPathPrefix(serverUrl: string): string {
  try {
    const parsed = new URL(normalizeServerUrl(serverUrl));
    let pathname = parsed.pathname;
    while (pathname.endsWith('/')) pathname = pathname.slice(0, -1);
    return pathname;
  } catch {
    return '';
  }
}

// 历史数据兼容：旧版本曾把服务器真实文件名（本身是 Latin-1 乱码形态，
// 如 `ï¼\x81`）"修复"为理想字符（`！`）后存入影片表 / 返回给前端。
// 该形态与服务器真名不匹配导致 404，此函数做逆变换生成候选路径用于重试：
// `！` U+FF01 → UTF-8 字节 EF BC 81 → 按 Latin-1 解释回 `ï¼\x81`。
// 仅当结果与原串不同时才有重试价值。
export function latin1RoundTrip(str: string): string | null {
  if (!str) return null;
  try {
    const reversed = Buffer.from(str, 'utf8').toString('latin1');
    if (reversed !== str && /[\u0080-\u00FF]/.test(reversed)) return reversed;
  } catch {
    // 忽略错误
  }
  return null;
}

// 从可能为完整 URL 的 href 中提取 pathname，不使用 new URL().pathname
// 因为 WHATWG URL 规范化会对路径中的非 ASCII 字符进行重新编码，
// 导致双重编码问题（Latin-1 字符被重新编码为 UTF-8 百分号编码）。
function extractPathname(href: string): string {
  const match = /^https?:\/\/[^/]+(\/[^?#]*)?/i.exec(href);
  if (match) {
    return match[1] || '/';
  }
  return href;
}

// 将 DAV 服务器返回的 href 转换为相对 webdav 根的路径
// 例如 href="/dav/folder1"，serverUrl="http://host/dav"，返回 "/folder1"
// 返回的是已解码的原始路径（非 URL 编码），由调用方按需编码。
// 注意：解码后即服务器真实路径，不做任何"乱码修复"——
// 部分网盘（如 139Cloud）的文件名本身就是 Latin-1 乱码形态，
// 任何字符变换都会导致后续 PROPFIND/GET 与真实文件名不匹配而 404。
function hrefToWebDAVPath(href: string, serverUrl: string): string {
  if (!href) return '/';
  let pathname = extractPathname(href);
  // 解码 URL 编码，得到服务器上的真实路径
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // 解码失败（可能包含无效的 % 序列），保持原样
  }
  // 剥离 serverUrl 的 path 前缀（如 /dav）
  const prefix = getServerPathPrefix(serverUrl);
  if (prefix && prefix !== '/' && pathname.startsWith(prefix)) {
    pathname = pathname.slice(prefix.length);
  }
  if (!pathname.startsWith('/')) pathname = '/' + pathname;
  // 去除末尾斜杠（根路径除外）
  while (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }
  return pathname;
}

function createConnection(params: WebDAVConnectionParams): Connection {
  // webdav-client 库不会自动根据 username/password 发送 Basic Auth 头，
  // 必须显式传入 authenticator 才会在请求中添加 Authorization 头。
  const hasCredentials = !!(params.username || params.password);
  return new Connection({
    url: normalizeServerUrl(params.serverUrl),
    username: params.username || undefined,
    password: params.password || undefined,
    authenticator: hasCredentials ? new BasicAuthenticator() : undefined,
  });
}

export async function statWebDAVFile(
  params: WebDAVConnectionParams,
  signal?: AbortSignal,
): Promise<WebDAVFileInfo> {
  try {
    try {
      return await statWebDAVFileWithFetch(params, signal);
    } catch (err) {
      // 历史数据兼容：影片表中 path 若为旧版"乱码修复"形态（`！`），
      // 与服务器真名（`ï¼\x81`）不匹配会 404；用逆变换候选路径重试一次。
      const fallbackPath = latin1RoundTrip(params.path);
      if (fallbackPath && !(signal?.aborted)) {
        return await statWebDAVFileWithFetch({ ...params, path: fallbackPath }, signal);
      }
      throw err;
    }
  } catch (err) {
    throw wrapWebDAVError(err);
  }
}

export function createWebDAVReadStream(
  params: WebDAVConnectionParams,
): Readable {
  const connection = createConnection(params);
  return connection.get(normalizePath(params.path)) as Readable;
}

/**
 * 构造 WebDAV 文件直链。
 *
 * WebDAV credentials are never embedded in a browser-visible URL. The
 * returned URL is therefore eligible for direct playback only when the
 * configured mount is actually anonymous and the URL passes the common
 * public-target policy; credentialed mounts must use the scoped media gateway.
 * The optional credential arguments remain for source compatibility with
 * older callers, but are intentionally ignored.
 */
export function buildWebDAVDirectUrl(
  serverUrl: string,
  path: string,
  _username?: string,
  _password?: string,
): string {
  const normalizedUrl = normalizeServerUrl(serverUrl);
  // 路径保持服务器真名原样，不做乱码修复（与 normalizePath 策略一致）
  const encodedPath = normalizePath(path);
  // WebDAV credentials are never embedded in a browser-visible URL. A
  // credentialed mount must use the scoped media gateway instead.
  return `${normalizedUrl}${encodedPath}`;
}

export interface WebDAVDirectoryEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  lastModified?: Date;
}

export async function listWebDAVDirectory(
  params: WebDAVConnectionParams,
  targetPath?: string,
): Promise<WebDAVDirectoryEntry[]> {
  try {
    return await withTimeout(
      (async () => {
        try {
          const connection = createConnection(params);
          const listPath = targetPath
            ? normalizePath(targetPath)
            : params.path.endsWith('/')
              ? normalizePath(params.path)
              : normalizePath(params.path.split('/').slice(0, -1).join('/') || '/');
          const readdir = promisify(
            connection.readdir.bind(connection) as (
              path: string,
              options: { properties?: boolean; extraProperties?: unknown[] },
              callback: (error: Error, files?: unknown[]) => void,
            ) => void,
          );
          const entries = (await readdir(listPath, {
            properties: true,
            extraProperties: [],
          })) as Array<{
            name?: string;
            href?: string;
            isDirectory?: boolean;
            size?: number;
            lastModified?: Date;
          }>;
          return entries.map((entry) => ({
            // name 保持服务器原样（与 path 同源），不做乱码修复
            name: entry.name || '',
            // 将 DAV 服务器返回的 href（如 /dav/folder1）转换为相对 webdav 根的路径（/folder1）
            // 避免前端把带前缀的路径回传给后端时造成路径重复（/dav/dav/folder1）导致 404
            path: entry.href
              ? hrefToWebDAVPath(entry.href, params.serverUrl)
              : '',
            type: entry.isDirectory ? 'directory' : 'file',
            size: typeof entry.size === 'number' ? entry.size : undefined,
            lastModified: entry.lastModified,
          }));
        } catch (err) {
          throw wrapWebDAVError(err);
        }
      })(),
      'WebDAV 连接',
    );
  } catch (err) {
    throw wrapWebDAVError(err);
  }
}

// ── 文件 stat 缓存 ─────────────────────────────────────
// 视频播放/seek 期间会产生大量 Range 请求，每次都 PROPFIND 取 fileSize
// 会多一次上游往返（高延迟 WebDAV 下显著拖慢 seek 响应）。
// 文件大小在播放期间不会变化，短 TTL 缓存即可；文件被替换时最多 30s 后自愈。
const statCache = new Map<string, { info: WebDAVFileInfo; cachedAt: number }>();
const STAT_CACHE_TTL_MS = 30 * 1000; // 30 秒
const STAT_CACHE_MAX_ENTRIES = 200;

function statCacheKey(params: WebDAVConnectionParams): string {
  return `${params.serverUrl}|${params.username || ''}|${params.path}`;
}

/** statWebDAVFile 的缓存版本：Range 流请求专用，减少 seek 时的上游往返。 */
export async function statWebDAVFileCached(
  params: WebDAVConnectionParams,
): Promise<WebDAVFileInfo> {
  const key = statCacheKey(params);
  const now = Date.now();
  const cached = statCache.get(key);
  if (cached && now - cached.cachedAt < STAT_CACHE_TTL_MS) {
    return cached.info;
  }
  const info = await statWebDAVFile(params);
  // 简单容量控制：超限且正好撞上过期项时顺手清理
  if (statCache.size >= STAT_CACHE_MAX_ENTRIES) {
    for (const [k, v] of statCache) {
      if (now - v.cachedAt >= STAT_CACHE_TTL_MS) statCache.delete(k);
    }
    if (statCache.size >= STAT_CACHE_MAX_ENTRIES) statCache.clear();
  }
  statCache.set(key, { info, cachedAt: now });
  return info;
}

// 创建带 Range 的 WebDAV 读取流；未提供 rangeHeader 时返回完整流
export async function createWebDAVReadStreamWithRange(
  params: WebDAVConnectionParams,
  rangeHeader?: string | string[],
): Promise<{ stream: Readable; fileSize: number; start: number; end: number }> {
  const info = await statWebDAVFileCached(params);
  const fileSize = info.size;
  // info.path 可能是 fallback 修正后的服务器真名路径，流请求必须与其一致
  const streamPath = info.path || params.path;

  const hasRange = Array.isArray(rangeHeader)
    ? rangeHeader.some((value) => value.trim())
    : !!rangeHeader?.trim();
  if (!hasRange) {
    const stream = createWebDAVReadStream({ ...params, path: streamPath });
    return { stream, fileSize, start: 0, end: fileSize - 1 };
  }

  const parsed = parseByteRangeHeader(rangeHeader);
  const resolved = parsed ? resolveByteRange(parsed, fileSize) : null;
  if (!resolved || resolved.kind !== 'single') {
    throw new WebDAVError(
      resolved?.kind === 'multi'
        ? 'WebDAV 暂不支持 multipart/byteranges'
        : '请求的字节范围不可满足',
      'RANGE_NOT_SATISFIABLE',
      fileSize,
    );
  }
  const { start, end } = resolved.range;
  const connection = createConnection(params);
  // webdav-client 的 connection.get 不支持 range 选项，需直接构造 stream 请求
  // 通过 connection.stream({ url, method, headers }) 发送带 Range 头的 GET 请求
  const streamFn = connection.stream.bind(connection) as unknown as (
    options: {
      url: string;
      method: string;
      headers?: Record<string, string>;
    },
  ) => Readable;
  const stream = streamFn({
    url: normalizePath(streamPath),
    method: 'GET',
    headers: {
      Range: `bytes=${start}-${end}`,
    },
  });
  const response = await new Promise<{
    statusCode?: number;
    headers?: Record<string, string | string[]>;
  }>((resolve, reject) => {
    stream.once('response', resolve);
    stream.once('error', reject);
  });
  if (response.statusCode !== 206) {
    stream.destroy();
    throw new WebDAVError(
      response.statusCode === 200
        ? 'WebDAV 上游忽略 Range 请求'
        : 'WebDAV 上游 Range 响应无效',
      'RANGE_UPSTREAM_INVALID',
      fileSize,
    );
  }
  const headers = response.headers || {};
  const contentRangeValue = Array.isArray(headers['content-range'])
    ? headers['content-range'][0]
    : headers['content-range'];
  const contentRange = parseContentRangeHeader(contentRangeValue);
  const expected = resolveByteRange(parsed!, fileSize);
  if (!contentRange || expected.kind !== 'single' ||
      contentRange.start !== expected.range.start ||
      contentRange.end !== expected.range.end ||
      contentRange.total !== fileSize) {
    stream.destroy();
    throw new WebDAVError('WebDAV 上游 Content-Range 与请求不一致', 'RANGE_UPSTREAM_INVALID', fileSize);
  }
  const contentLengthValue = Array.isArray(headers['content-length'])
    ? headers['content-length'][0]
    : headers['content-length'];
  if (contentLengthValue !== undefined &&
      (!/^\d+$/.test(String(contentLengthValue)) || Number(contentLengthValue) !== expected.range.length)) {
    stream.destroy();
    throw new WebDAVError('WebDAV 上游 Content-Length 与 Range 不一致', 'RANGE_UPSTREAM_INVALID', fileSize);
  }
  let actualLength = 0;
  const validator = new Transform({
    transform(chunk, _encoding, callback) {
      actualLength += chunk.length;
      callback(null, chunk);
    },
    flush(callback) {
      if (actualLength !== expected.range.length) {
        callback(new Error('WebDAV 上游 body 长度与 Range 不一致'));
        return;
      }
      callback();
    },
  });
  return { stream: stream.pipe(validator), fileSize, start, end };
}

// 目录缓存：key=`${mountId}:${targetPath || params.path}`
// 使用 TtlCache（LRU 上限）替代无界 Map：条目存整个目录列表（远大于单条 stat），
// 浏览过的每个目录 60s TTL 过期后若无容量控制会永久残留。
const webdavDirCache = new TtlCache<WebDAVDirectoryEntry[]>({
  ttlMs: 60 * 1000,
  maxSize: 300,
});

// 优先读缓存，缓存过期或不存在时调用 listWebDAVDirectory
export async function listWebDAVDirectoryCached(
  params: WebDAVConnectionParams,
  mountId: number,
  targetPath?: string,
): Promise<WebDAVDirectoryEntry[]> {
  const cacheKey = `${mountId}:${targetPath || params.path}`;
  const cached = webdavDirCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const data = await listWebDAVDirectory(params, targetPath);
  webdavDirCache.set(cacheKey, data);
  return data;
}
