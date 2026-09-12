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
import {
  DOMParser,
  XMLSerializer,
  type Element as XmlElement,
  type Node as XmlNode,
} from '@xmldom/xmldom';
import { authenticateToken, extractAccessToken, verifyAccessToken } from '../../middleware/auth';
import { authorizeRoomMediaGrant } from '../../services/media/room-access';

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
  const headers = headersForTarget(resource, absolute);
  return issueMediaHandle({
    url: absolute, scope: resource.scope, headers,
    credentialOrigins: resource.credentialOrigins,
    expiresAt: resource.expiresAt,
    rewriteManifest: rewriteManifest ?? /\.(?:m3u8|mpd)(?:[?#]|$)/i.test(absolute),
  }).url;
}

function isCredentialHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === 'cookie' || lower === 'authorization' || lower.includes('token') || /(?:^|[-_])api[-_]?key$/.test(lower);
}

function headersForTarget(resource: MediaHandleResource, target: string): Record<string, string> | undefined {
  if (!resource.headers) return undefined;
  const targetOrigin = new URL(target).origin;
  const allowed = new Set(resource.credentialOrigins ?? [new URL(resource.url).origin]);
  return Object.fromEntries(
    Object.entries(resource.headers).filter(([name]) => !isCredentialHeader(name) || allowed.has(targetOrigin)),
  );
}

function credentialOriginsFor(url: string, headers?: Record<string, string>): string[] | undefined {
  if (!headers || !Object.keys(headers).some(isCredentialHeader)) return undefined;
  return [new URL(url).origin];
}

function childBaseResource(resource: MediaHandleResource, baseUrl: string): { id: string; resource: MediaHandleResource } {
  const child: MediaHandleResource = {
    ...resource,
    url: baseUrl,
    headers: headersForTarget(resource, baseUrl),
    rewriteManifest: false,
  };
  const issued = issueMediaHandle(child);
  return { id: issued.id, resource: child };
}

function appendAccessToken(url: string, token?: string): string {
  if (!token) return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

function dashAssetUrl(id: string, path: string, token?: string, roomGrant?: string): string {
  const encodedPath = encodeURIComponent(path).replace(/%24/gi, '$');
  const auth = token ? `&amp;token=${encodeURIComponent(token)}` : '';
  const roomAuth = roomGrant ? `&amp;roomGrant=${encodeURIComponent(roomGrant)}` : '';
  return `/api/stream/media/${encodeURIComponent(id)}/asset?path=${encodedPath}${auth}${roomAuth}`;
}

export function rewriteManifest(
  body: string, contentType: string, resource: MediaHandleResource,
  handle: { id: string; token?: string; roomGrant?: string },
): string {
  if (/mpegurl|m3u8/i.test(contentType) || body.trimStart().startsWith('#EXTM3U')) {
    let nextUriIsPlaylist = false;
    return body.split(/\r?\n/).map((line) => {
      if (line && !line.startsWith('#')) {
        const rewritten = appendRoomGrant(appendAccessToken(handleFor(resource, line.trim(), nextUriIsPlaylist || undefined), handle.token), handle.roomGrant);
        nextUriIsPlaylist = false;
        return rewritten;
      }
      if (/^#EXT-X-STREAM-INF:/i.test(line)) nextUriIsPlaylist = true;
      const attributeIsPlaylist = /^#EXT-X-(?:MEDIA|I-FRAME-STREAM-INF):/i.test(line);
      return line.replace(/URI="([^"]+)"/g, (_all, value: string) => {
        return `URI="${appendRoomGrant(appendAccessToken(handleFor(resource, value, attributeIsPlaylist || undefined), handle.token), handle.roomGrant)}"`;
      });
    }).join('\n');
  }
  return rewriteDashManifest(body, resource, handle);
}

function directChildrenByName(node: XmlElement, name: string): XmlElement[] {
  const output: XmlElement[] = [];
  for (let index = 0; index < node.childNodes.length; index += 1) {
    const child = node.childNodes.item(index);
    if (child?.nodeType === 1 && (child as XmlElement).localName === name) output.push(child as XmlElement);
  }
  return output;
}

function effectiveDashBase(node: XmlElement, manifestUrl: string): string {
  const chain: XmlElement[] = [];
  for (let current: XmlNode | null = node; current?.nodeType === 1; current = current.parentNode) {
    chain.unshift(current as XmlElement);
  }
  let base = manifestUrl;
  for (const current of chain) {
    const baseNode = directChildrenByName(current, 'BaseURL')[0];
    const value = baseNode?.textContent?.trim();
    if (value) base = new URL(value, base).toString();
  }
  return base;
}

function closestTemplate(node: XmlElement, name: 'SegmentTemplate' | 'SegmentList'): XmlElement | undefined {
  for (let current: XmlNode | null = node; current?.nodeType === 1; current = current.parentNode) {
    const found = directChildrenByName(current as XmlElement, name)[0];
    if (found) return found;
  }
  return undefined;
}

function rewriteDashManifest(
  body: string,
  resource: MediaHandleResource,
  handle: { id: string; token?: string; roomGrant?: string },
): string {
  const document = new DOMParser().parseFromString(body, 'application/xml');
  if (document.getElementsByTagName('parsererror').length) throw new Error('DASH MPD XML 解析失败');

  const representations = Array.from(document.getElementsByTagName('Representation'));
  for (const representation of representations) {
    const base = effectiveDashBase(representation, resource.url);
    const baseHandle = childBaseResource(resource, base);
    const template = closestTemplate(representation, 'SegmentTemplate');
    if (template) {
      const local = template.parentNode === representation ? template : template.cloneNode(true) as XmlElement;
      for (const attribute of ['media', 'initialization']) {
        const value = local.getAttribute(attribute);
        if (value) local.setAttribute(attribute, dashAssetUrl(baseHandle.id, value, handle.token, handle.roomGrant).replace(/&amp;/g, '&'));
      }
      if (local.parentNode !== representation) representation.appendChild(local);
    }

    const segmentList = closestTemplate(representation, 'SegmentList');
    if (segmentList) {
      const local = segmentList.parentNode === representation ? segmentList : segmentList.cloneNode(true) as XmlElement;
      for (const elementName of ['Initialization', 'SegmentURL']) {
        const elements = Array.from(local.getElementsByTagName(elementName));
        for (const element of elements) {
          for (const attribute of ['sourceURL', 'media']) {
            const value = element.getAttribute(attribute);
            if (value) element.setAttribute(attribute, appendRoomGrant(appendAccessToken(handleFor(baseHandle.resource, value), handle.token), handle.roomGrant));
          }
        }
      }
      if (local.parentNode !== representation) representation.appendChild(local);
    }

    // A Representation containing only BaseURL points directly at a media file.
    if (!template && !segmentList) {
      const directBase = directChildrenByName(representation, 'BaseURL')[0];
      if (directBase) directBase.textContent = appendRoomGrant(appendAccessToken(handleFor(resource, base), handle.token), handle.roomGrant);
    } else {
      for (const baseNode of directChildrenByName(representation, 'BaseURL')) representation.removeChild(baseNode);
    }
  }

  // Rewritten Representation URLs are absolute gateway URLs; retaining inherited
  // BaseURL nodes would make dash.js prepend the upstream path a second time.
  for (const name of ['MPD', 'Period', 'AdaptationSet']) {
    for (const element of Array.from(document.getElementsByTagName(name))) {
      for (const baseNode of directChildrenByName(element, 'BaseURL')) element.removeChild(baseNode);
    }
  }
  for (const name of ['SegmentTemplate', 'SegmentList']) {
    for (const element of Array.from(document.getElementsByTagName(name))) {
      if (element.parentNode?.localName !== 'Representation') element.parentNode?.removeChild(element);
    }
  }
  return new XMLSerializer().serializeToString(document);
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

function appendRoomGrant(url: string, roomGrant?: string): string {
  if (!roomGrant) return url;
  return `${url}${url.includes('?') ? '&' : '?'}roomGrant=${encodeURIComponent(roomGrant)}`;
}

function roomGrantToken(req: AuthenticatedRequest): string | undefined {
  const value = req.query.roomGrant ?? req.body?.roomGrant;
  return typeof value === 'string' && value ? value : undefined;
}

function optionalViewerId(req: AuthenticatedRequest): string {
  const token = extractAccessToken(req);
  if (!token) return '';
  try { return String(verifyAccessToken(token).userId); } catch { return ''; }
}

async function authorizedResource(req: AuthenticatedRequest): Promise<MediaHandleResource | undefined> {
  const grant = await authorizeRoomMediaGrant(roomGrantToken(req));
  return resolveMediaHandle(String(req.params.id), optionalViewerId(req), grant);
}

router.post('/media/resolve', authenticateToken, mediaResolveLimiter, async (req: AuthenticatedRequest, res) => {
  const input = typeof req.body?.input === 'string' ? req.body.input.trim() : '';
  if (!input || input.length > 4096) { res.status(400).json({ success: false, message: '请输入有效媒体 URL 或 BV 号' }); return; }
  const ownerId = userIdOf(req);
  const roomId = typeof req.body?.roomId === 'string' && req.body.roomId.trim()
    ? req.body.roomId.trim().slice(0, 128) : undefined;
  if (roomId && !(await authorizeRoomMediaGrant(roomGrantToken(req), roomId))) {
    res.status(403).json({ success: false, message: '当前客户端没有房间媒体访问权限' });
    return;
  }
  const scope = roomId ? `room:${roomId}` : `user:${ownerId}`;
  try {
    const cookie = (await getUserCookie(req.user?.userId)) || undefined;
    const descriptor = await resolveMediaInput(input, {
      userId: ownerId, cookie, browserSniff: req.body?.browserSniff === true,
      requestedQn: Number.isFinite(req.body?.requestedQn) ? Number(req.body.requestedQn) : undefined,
      preferMp4: req.body?.preferMp4 === true,
      page: Number.isFinite(req.body?.page) ? Number(req.body.page) : undefined,
      cid: Number.isFinite(req.body?.cid) ? Number(req.body.cid) : undefined,
    });
    const plan = planPlayback(descriptor, req.body?.capabilities ?? {});
    if (descriptor.drm.protected) {
      res.status(422).json({
        success: false,
        message: '检测到 DRM 加密，当前无法作为普通媒体播放',
        descriptor: toPublicDescriptor(descriptor, ''),
        plan,
      });
      return;
    }
    if (plan.engine === 'blocked') {
      res.status(422).json({ success: false, message: plan.reasons.join('；') || '当前客户端无法播放该媒体', descriptor: toPublicDescriptor(descriptor, ''), plan });
      return;
    }
    const videoHandle = issueMediaHandle({
      url: descriptor.finalUrl, scope, headers: descriptor.headers,
      credentialOrigins: credentialOriginsFor(descriptor.finalUrl, descriptor.headers),
      contentType: descriptor.contentType,
      // Magic handles octet-stream manifests; Bilibili's dual m4s "dash"
      // descriptor deliberately has video/mp4 and must not be parsed as MPD XML.
      rewriteManifest: shouldRewriteManifest(descriptor),
    });
    const audioHandle = descriptor.audioUrl ? issueMediaHandle({
      url: descriptor.audioUrl, scope, headers: descriptor.headers, contentType: 'audio/mp4',
      credentialOrigins: credentialOriginsFor(descriptor.audioUrl, descriptor.headers),
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
  const resource = await authorizedResource(req);
  const relativePath = typeof req.query.path === 'string' ? req.query.path : '';
  if (!resource || !relativePath) { res.status(403).end(); return; }
  let target: URL;
  try { target = new URL(relativePath, resource.url); } catch { res.status(400).end(); return; }
  // Template requests can vary only within the manifest's origin; they cannot turn a handle into an open proxy.
  if (target.origin !== new URL(resource.url).origin) { res.status(403).end(); return; }
  await proxyHttpUpstream(req, res, {
    url: target.toString(), targetPolicy: 'public-only', headers: { extra: headersForTarget(resource, target.toString()) },
    cors: 'global', logTag: 'media-segment', errorMessage: 'DASH 分片请求失败',
  });
});

router.get('/media/:id', async (req: AuthenticatedRequest, res) => {
  const resource = await authorizedResource(req);
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
    const finalResource: MediaHandleResource = {
      ...resource,
      url: upstream.url || resource.url,
      headers: headersForTarget(resource, upstream.url || resource.url),
    };
    res.type(contentType).setHeader('Cache-Control', 'private, max-age=15');
    res.send(rewriteManifest(body, contentType, finalResource, {
      id: String(req.params.id),
      token: typeof req.query.token === 'string' ? req.query.token : undefined,
      roomGrant: roomGrantToken(req),
    }));
  } catch (error) {
    res.status(502).json({ success: false, message: error instanceof Error ? error.message : 'manifest 代理失败' });
  }
});

export default router;
