import { Router } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth';
import { getUserCookie } from './helpers';
import { resolveMediaInput } from '../../services/media/resolvers';
import { planPlayback } from '../../services/media/planner';
import { issueMediaHandle, resolveMediaHandle, type MediaHandleResource } from '../../services/media/handles';
import { proxyHttpUpstream } from '../../services/proxy/http-proxy';
import { fetchWithProxyPolicy } from '../../services/proxy/safe-fetch';
import rateLimit from 'express-rate-limit';
import type { MediaDescriptor } from '../../services/media/types';

const router = Router();
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const mediaResolveLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, message: '媒体解析请求过于频繁，请稍后再试' },
});

function userIdOf(req: AuthenticatedRequest): string {
  return String(req.user?.userId ?? '');
}

/** Never expose upstream credentials or signed candidate URLs to the browser. */
export function toPublicDescriptor(
  descriptor: MediaDescriptor,
  finalUrl: string,
  audioUrl?: string,
): Omit<MediaDescriptor, 'headers' | 'candidates'> {
  const { headers: _headers, candidates: _candidates, ...safe } = descriptor;
  return { ...safe, finalUrl, audioUrl };
}

export function shouldRewriteManifest(descriptor: MediaDescriptor): boolean {
  return (
    /mpegurl|dash\+xml/i.test(descriptor.contentType ?? '') ||
    descriptor.probe.magic === 'EXTM3U' ||
    descriptor.probe.magic === 'MPD XML'
  );
}

function handleFor(resource: MediaHandleResource, target: string, rewriteManifest?: boolean): string {
  const absolute = new URL(target, resource.url).toString();
  return issueMediaHandle({
    url: absolute, scope: resource.scope, headers: resource.headers,
    expiresAt: resource.expiresAt,
    rewriteManifest: rewriteManifest ?? /\.(?:m3u8|mpd)(?:[?#]|$)/i.test(absolute),
  }).url;
}

function appendAccessToken(url: string, token?: string): string {
  if (!token) return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

function dashAssetUrl(id: string, path: string, token?: string): string {
  const encodedPath = encodeURIComponent(path).replace(/%24/gi, '$');
  const auth = token ? `&amp;token=${encodeURIComponent(token)}` : '';
  return `/api/stream/media/${encodeURIComponent(id)}/asset?path=${encodedPath}${auth}`;
}

export function rewriteManifest(
  body: string, contentType: string, resource: MediaHandleResource,
  handle: { id: string; token?: string },
): string {
  if (/mpegurl|m3u8/i.test(contentType) || body.trimStart().startsWith('#EXTM3U')) {
    let nextUriIsPlaylist = false;
    return body.split(/\r?\n/).map((line) => {
      if (line && !line.startsWith('#')) {
        const rewritten = appendAccessToken(handleFor(resource, line.trim(), nextUriIsPlaylist || undefined), handle.token);
        nextUriIsPlaylist = false;
        return rewritten;
      }
      if (/^#EXT-X-STREAM-INF:/i.test(line)) nextUriIsPlaylist = true;
      const attributeIsPlaylist = /^#EXT-X-(?:MEDIA|I-FRAME-STREAM-INF):/i.test(line);
      return line.replace(/URI="([^"]+)"/g, (_all, value: string) => {
        return `URI="${appendAccessToken(handleFor(resource, value, attributeIsPlaylist || undefined), handle.token)}"`;
      });
    }).join('\n');
  }
  return body
    .replace(/(<BaseURL[^>]*>)([^<$]+)(<\/BaseURL>)/gi, (_all, open: string, value: string, close: string) => `${open}${appendAccessToken(handleFor(resource, value.trim()), handle.token).replace(/&/g, '&amp;')}${close}`)
    .replace(/\b(media|initialization|sourceURL)="([^"]+)"/gi, (_all, name: string, value: string) => {
      return `${name}="${dashAssetUrl(handle.id, value, handle.token)}"`;
    });
}

async function readManifest(response: Awaited<ReturnType<typeof fetchWithProxyPolicy>>): Promise<string> {
  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_MANIFEST_BYTES) throw new Error('manifest 超出 4MB 安全上限');
  if (!response.body) return '';
  const reader = response.body.getReader(); const chunks: Buffer[] = []; let total = 0;
  try {
    while (total <= MAX_MANIFEST_BYTES) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.length; if (total > MAX_MANIFEST_BYTES) throw new Error('manifest 超出 4MB 安全上限');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return Buffer.concat(chunks, total).toString('utf8');
}

router.post('/media/resolve', mediaResolveLimiter, async (req: AuthenticatedRequest, res) => {
  const input = typeof req.body?.input === 'string' ? req.body.input.trim() : '';
  if (!input || input.length > 4096) { res.status(400).json({ success: false, message: '请输入有效媒体 URL 或 BV 号' }); return; }
  const ownerId = userIdOf(req);
  const roomId = typeof req.body?.roomId === 'string' && req.body.roomId.trim()
    ? req.body.roomId.trim().slice(0, 128) : undefined;
  const scope = roomId ? `room:${roomId}` : `user:${ownerId}`;
  try {
    const cookie = (await getUserCookie(req.user?.userId)) || undefined;
    const descriptor = await resolveMediaInput(input, {
      userId: ownerId, cookie, browserSniff: req.body?.browserSniff === true,
      requestedQn: Number.isFinite(req.body?.requestedQn) ? Number(req.body.requestedQn) : undefined,
      preferMp4: req.body?.preferMp4 === true,
    });
    const plan = planPlayback(descriptor, req.body?.capabilities ?? {});
    if (descriptor.drm.protected) {
      res.status(422).json({ success: false, message: '检测到 DRM 加密，当前无法作为普通媒体播放', descriptor, plan });
      return;
    }
    const videoHandle = issueMediaHandle({
      url: descriptor.finalUrl, scope, headers: descriptor.headers,
      contentType: descriptor.contentType,
      // Magic handles octet-stream manifests; Bilibili's dual m4s "dash"
      // descriptor deliberately has video/mp4 and must not be parsed as MPD XML.
      rewriteManifest: shouldRewriteManifest(descriptor),
    });
    const audioHandle = descriptor.audioUrl ? issueMediaHandle({
      url: descriptor.audioUrl, scope, headers: descriptor.headers, contentType: 'audio/mp4',
      expiresAt: videoHandle.expiresAt,
    }) : undefined;
    descriptor.expiresAt = videoHandle.expiresAt;
    res.json({
      success: true,
      descriptor: toPublicDescriptor(descriptor, videoHandle.url, audioHandle?.url),
      plan: { ...plan, proxy: true },
    });
  } catch (error) {
    res.status(422).json({ success: false, message: error instanceof Error ? error.message : '媒体解析失败' });
  }
});

router.get('/media/:id/asset', async (req: AuthenticatedRequest, res) => {
  const id = String(req.params.id);
  const resource = resolveMediaHandle(id, userIdOf(req));
  const relativePath = typeof req.query.path === 'string' ? req.query.path : '';
  if (!resource || !relativePath) { res.status(403).end(); return; }
  let target: URL;
  try { target = new URL(relativePath, resource.url); } catch { res.status(400).end(); return; }
  // Template requests can vary only within the manifest's origin; they cannot turn a handle into an open proxy.
  if (target.origin !== new URL(resource.url).origin) { res.status(403).end(); return; }
  await proxyHttpUpstream(req, res, {
    url: target.toString(), targetPolicy: 'public-only', headers: { extra: resource.headers },
    cors: 'global', logTag: 'media-segment', errorMessage: 'DASH 分片请求失败',
  });
});

router.get('/media/:id', async (req: AuthenticatedRequest, res) => {
  const resource = resolveMediaHandle(String(req.params.id), userIdOf(req));
  if (!resource) { res.status(403).json({ success: false, message: '媒体凭证无效或已过期' }); return; }
  if (!resource.rewriteManifest) {
    await proxyHttpUpstream(req, res, {
      url: resource.url, targetPolicy: 'public-only', headers: { extra: resource.headers },
      defaultContentType: resource.contentType, cors: 'global', logTag: 'media-handle', errorMessage: '媒体网关请求失败',
    });
    return;
  }
  try {
    const upstream = await fetchWithProxyPolicy(resource.url, { method: 'GET', headers: resource.headers }, 'public-only');
    if (!upstream.ok) { await upstream.body?.cancel(); res.sendStatus(upstream.status); return; }
    const contentType = upstream.headers.get('content-type') ?? resource.contentType ?? 'application/octet-stream';
    const body = await readManifest(upstream);
    res.type(contentType).setHeader('Cache-Control', 'private, max-age=15');
    res.send(rewriteManifest(body, contentType, resource, {
      id: String(req.params.id),
      token: typeof req.query.token === 'string' ? req.query.token : undefined,
    }));
  } catch (error) {
    res.status(502).json({ success: false, message: error instanceof Error ? error.message : 'manifest 代理失败' });
  }
});

export default router;
