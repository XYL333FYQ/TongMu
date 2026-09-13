import { redactMediaError } from '../../services/media/redact';
import { canDirect, publicMetadata, type TransportPlan, type PublicMediaDescriptor } from '../../services/media/protocol';
import { AppDataSource } from '../../data-source';
import { Movie } from '../../entities/Movie';
import { Session } from '../../entities/Session';
import { IsNull } from 'typeorm';
import { Router } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth';
import { getUserCookie } from './helpers';
import { resolveMediaInput } from '../../services/media/resolvers';
import { planPlayback } from '../../services/media/planner';
import { issueMediaHandle, resolveMediaHandle, type MediaHandleResource } from '../../services/media/handles';
import { proxyHttpUpstream } from '../../services/proxy/http-proxy';
import { fetchWithProxyPolicy, fetchWithProxyPolicyDetailed } from '../../services/proxy/safe-fetch';
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
const canPublishTarget = (url: string) => canDirect({ finalUrl: url } as MediaDescriptor);
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
): PublicMediaDescriptor {
  return { ...publicMetadata(descriptor), input: '', originalUrl: '', finalUrl, audioUrl };
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
  const assisted = resource.transportMode === 'MANIFEST_ASSISTED' || resource.transportMode === 'PARTIAL_PROXY';
  if (assisted && rewriteManifest !== true && canPublishTarget(absolute)) return absolute;
  const headers = headersForTarget(resource, absolute);
  return issueMediaHandle({
    url: absolute, scope: resource.scope, headers,
    credentialOrigins: resource.credentialOrigins,
    expiresAt: resource.expiresAt,
    transportMode: resource.transportMode,
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

export function credentialOriginsFor(
  url: string,
  headers?: Record<string, string>,
  provenance?: string[],
): string[] | undefined {
  if (!headers || !Object.keys(headers).some(isCredentialHeader)) return undefined;
  if (provenance) return provenance;
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
  if (!token || !url.startsWith('/api/stream/media/')) return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

function dashAssetUrl(id: string, path: string, token?: string, roomGrant?: string): string {
  const encodedPath = encodeDashAssetPath(path);
  const auth = token ? `&amp;token=${encodeURIComponent(token)}` : '';
  const roomAuth = roomGrant ? `&amp;roomGrant=${encodeURIComponent(roomGrant)}` : '';
  return `/api/stream/media/${encodeURIComponent(id)}/asset?path=${encodedPath}${auth}${roomAuth}`;
}

const DASH_TEMPLATE_TOKEN = /\$\$|\$(?:RepresentationID|Number|Time|Bandwidth)(?:%0\d+d)?\$/g;

/** Encode an asset path without hiding DASH template tokens from dash.js. */
export function encodeDashAssetPath(path: string): string {
  let output = '';
  let lastIndex = 0;
  for (const match of path.matchAll(DASH_TEMPLATE_TOKEN)) {
    const index = match.index ?? 0;
    output += encodeURIComponent(path.slice(lastIndex, index));
    output += match[0];
    lastIndex = index + match[0].length;
  }
  return output + encodeURIComponent(path.slice(lastIndex));
}

export function expandDashTemplate(
  template: string,
  values: Partial<Record<'RepresentationID' | 'Number' | 'Time' | 'Bandwidth', string | number>>,
): string {
  return template.replace(DASH_TEMPLATE_TOKEN, (token) => {
    if (token === '$$') return '$';
    const match = /^\$(RepresentationID|Number|Time|Bandwidth)(%0(\d+)d)?\$$/.exec(token);
    if (!match) return token;
    const value = values[match[1] as keyof typeof values];
    if (value === undefined) return token;
    const text = String(value);
    const width = match[3] ? Number(match[3]) : 0;
    return width > 0 ? text.padStart(width, '0') : text;
  });
}

export function highestHlsMaster(body: string): string {
  const lines = body.split(/\r?\n/);
  const variants: Array<{ tag: number; uri: number; pixels: number; bandwidth: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^#EXT-X-STREAM-INF:/.test(lines[i])) continue;
    let uri = i + 1;
    while (uri < lines.length && !lines[uri].trim()) uri++;
    if (uri >= lines.length || lines[uri].startsWith('#')) continue;
    const resolution = /(?:^|[, :])RESOLUTION=(\d+)x(\d+)/.exec(lines[i]);
    variants.push({ tag: i, uri, pixels: resolution ? Number(resolution[1]) * Number(resolution[2]) : 0,
      bandwidth: Number(/(?:^|[, :])BANDWIDTH=(\d+)/.exec(lines[i])?.[1] ?? 0) });
  }
  if (variants.length < 2) return body;
  variants.sort((a, b) => b.pixels - a.pixels || b.bandwidth - a.bandwidth);
  const removed = new Set(variants.slice(1).flatMap(v => [v.tag, v.uri]));
  return lines.filter((_line, index) => !removed.has(index)).join('\n');
}

export function rewriteManifest(
  body: string, contentType: string, resource: MediaHandleResource,
  handle: { id: string; token?: string; roomGrant?: string },
): string {
  if (/mpegurl|m3u8/i.test(contentType) || body.trimStart().startsWith('#EXTM3U')) {
    let nextUriIsPlaylist = false;
    return highestHlsMaster(body).split(/\r?\n/).map((line) => {
      if (line && !line.startsWith('#')) {
        const rewritten = appendRoomGrant(appendAccessToken(handleFor(resource, line.trim(), nextUriIsPlaylist || undefined), handle.token), handle.roomGrant);
        nextUriIsPlaylist = false;
        return rewritten;
      }
      if (/^#EXT-X-STREAM-INF:/i.test(line)) nextUriIsPlaylist = true;
      const attributeIsPlaylist = /^#EXT-X-(?:MEDIA|I-FRAME-STREAM-INF):/i.test(line);
      return line.replace(/URI="([^"]+)"/g, (_all, value: string) => {
        return `URI="${appendRoomGrant(appendAccessToken(handleFor(/^#EXT-X-(?:SESSION-)?KEY:/.test(line) && resource.transportMode === 'PARTIAL_PROXY' ? { ...resource, transportMode: 'FULL_PROXY' } : resource, value, attributeIsPlaylist || undefined), handle.token), handle.roomGrant)}"`;
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

function effectiveDashTemplate(node: XmlElement, name: 'SegmentTemplate' | 'SegmentList'): XmlElement | undefined {
  const chain: XmlElement[] = [];
  for (let current: XmlNode | null = node; current?.nodeType === 1; current = current.parentNode) {
    chain.unshift(current as XmlElement);
  }
  const templates = chain.flatMap((current) => directChildrenByName(current, name));
  if (templates.length === 0) return undefined;

  const effective = templates[0].cloneNode(true) as XmlElement;
  for (const template of templates.slice(1)) {
    for (let index = 0; index < template.attributes.length; index += 1) {
      const attribute = template.attributes.item(index);
      if (attribute) effective.setAttribute(attribute.name, attribute.value);
    }
    const childNames = name === 'SegmentTemplate'
      ? ['SegmentTimeline']
      : ['Initialization', 'SegmentURL'];
    for (const childName of childNames) {
      const children = directChildrenByName(template, childName);
      if (children.length === 0) continue;
      for (const oldChild of directChildrenByName(effective, childName)) effective.removeChild(oldChild);
      for (const child of children) effective.appendChild(child.cloneNode(true));
    }
  }
  return effective;
}

function rewriteDashManifest(
  body: string,
  resource: MediaHandleResource,
  handle: { id: string; token?: string; roomGrant?: string },
): string {
  const document = new DOMParser().parseFromString(body, 'application/xml');
  if (resource.transportMode === 'MANIFEST_ASSISTED' || resource.transportMode === 'PARTIAL_PROXY') {
    // A public MPD may reference private token-bearing resources. Never expose
    // those through assisted mode; the client can try the full encrypted gateway.
    if (/[?&](?:[^=\s"<>]*token|auth[^=\s"<>]*|cookie|password|api.?key)=/i.test(body.replace(/&amp;/g, '&'))) {
      throw new Error('MPD 子资源含私有凭证，需使用完整媒体中转');
    }
    const root = document.documentElement!;
    const bases = directChildrenByName(root, 'BaseURL');
    if (bases.length) for (const base of bases) base.textContent = new URL(base.textContent || '.', resource.url).toString();
    else { const base = document.createElement('BaseURL'); base.textContent = new URL('.', resource.url).toString(); root.insertBefore(base, root.firstChild); }
    return new XMLSerializer().serializeToString(document);
  }
  if (document.getElementsByTagName('parsererror').length) throw new Error('DASH MPD XML 解析失败');

  const representations = Array.from(document.getElementsByTagName('Representation'));
  for (const representation of representations) {
    const base = effectiveDashBase(representation, resource.url);
    const baseHandle = childBaseResource(resource, base);
    const template = effectiveDashTemplate(representation, 'SegmentTemplate');
    if (template) {
      const local = template;
      for (const attribute of ['media', 'initialization']) {
        const value = local.getAttribute(attribute);
        if (value) local.setAttribute(attribute, dashAssetUrl(baseHandle.id, value, handle.token, handle.roomGrant).replace(/&amp;/g, '&'));
      }
      for (const existing of directChildrenByName(representation, 'SegmentTemplate')) representation.removeChild(existing);
      representation.appendChild(local);
    }

    const segmentList = effectiveDashTemplate(representation, 'SegmentList');
    if (segmentList) {
      const local = segmentList;
      for (const elementName of ['Initialization', 'SegmentURL']) {
        const elements = Array.from(local.getElementsByTagName(elementName));
        for (const element of elements) {
          for (const attribute of ['sourceURL', 'media']) {
            const value = element.getAttribute(attribute);
            if (value) element.setAttribute(attribute, appendRoomGrant(appendAccessToken(handleFor(baseHandle.resource, value), handle.token), handle.roomGrant));
          }
        }
      }
      for (const existing of directChildrenByName(representation, 'SegmentList')) representation.removeChild(existing);
      representation.appendChild(local);
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
  if (!roomGrant || !url.startsWith('/api/stream/media/')) return url;
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
  let input = typeof req.body?.input === 'string' ? req.body.input.trim() : '';
  if (!input || input.length > 4096) { res.status(400).json({ success: false, message: '请输入有效媒体 URL 或 BV 号' }); return; }
  const ownerId = userIdOf(req);
  const roomId = typeof req.body?.roomId === 'string' && req.body.roomId.trim()
    ? req.body.roomId.trim().slice(0, 128) : undefined;
  if (roomId) {
    const grant = await authorizeRoomMediaGrant(roomGrantToken(req), roomId);
    const host = grant && await AppDataSource.getRepository(Session).findOneBy({ roomId, socketId: grant.socketId, role: 'sharer', endedAt: IsNull() });
    if (!host) { res.status(403).json({ success: false, message: '只有房主可以统一解析房间媒体' }); return; }
  }
  if (input.startsWith('media-movie:')) {
    const movie = await AppDataSource.getRepository(Movie).findOneBy({ id: Number(input.slice(12)) });
    const grant = await authorizeRoomMediaGrant(roomGrantToken(req), roomId);
    const host = grant && await AppDataSource.getRepository(Session).findOneBy({ roomId: grant.roomId, socketId: grant.socketId, role: 'sharer', endedAt: IsNull() });
    if (!movie || !host || movie.roomId !== roomId || !movie.sourceInput) {
      res.status(403).json({ success: false, message: '只有当前房主可以刷新房间私有媒体源' }); return;
    }
    input = movie.sourceInput;
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
    const plan = planPlayback(descriptor);
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
      credentialOrigins: credentialOriginsFor(
        descriptor.finalUrl,
        descriptor.headers,
        descriptor.credentialOrigins,
      ),
      contentType: descriptor.contentType,
      // Magic handles octet-stream manifests; Bilibili's dual m4s "dash"
      // descriptor deliberately has video/mp4 and must not be parsed as MPD XML.
      rewriteManifest: shouldRewriteManifest(descriptor),
    });
    const audioHandle = descriptor.audioUrl ? issueMediaHandle({
      url: descriptor.audioUrl, scope, headers: descriptor.headers, contentType: 'audio/mp4',
      credentialOrigins: credentialOriginsFor(
        descriptor.audioUrl,
        descriptor.headers,
        descriptor.credentialOrigins,
      ),
      expiresAt: videoHandle.expiresAt,
    }) : undefined;
    descriptor.expiresAt = videoHandle.expiresAt;
    const direct = canDirect(descriptor);
    const transportPlan: TransportPlan = {
      reason: direct ? '优先客户端直连；失败后保持同质量中转' : '源站需要私有请求头或私有 URL，使用中转',
      candidates: [
        ...(direct ? [{ mode: 'DIRECT' as const, url: descriptor.finalUrl, audioUrl: descriptor.audioUrl }] : []),
        ...(direct && shouldRewriteManifest(descriptor) ? [
          ...(['MANIFEST_ASSISTED', 'PARTIAL_PROXY'] as const).map(mode => ({ mode, url: issueMediaHandle({
            url: descriptor.finalUrl, scope, rewriteManifest: true, transportMode: mode,
            expiresAt: videoHandle.expiresAt,
          }).url })),
        ] : []),
        { mode: 'FULL_PROXY', url: videoHandle.url, audioUrl: audioHandle?.url },
      ],
    };

    res.json({
      success: true,
      descriptor: { ...toPublicDescriptor(descriptor, transportPlan.candidates[0].url, transportPlan.candidates[0].audioUrl), transportPlan },
      plan: { ...plan, proxy: !direct },
    });
  } catch (error) {
    res.status(422).json({ success: false, message: redactMediaError(error) });
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
    const fetched = await fetchWithProxyPolicyDetailed(resource.url, { method: 'GET', headers: resource.headers }, 'public-only');
    const upstream = fetched.response;
    if (!upstream.ok) { await upstream.body?.cancel(); res.sendStatus(upstream.status); return; }
    const contentType = upstream.headers.get('content-type') ?? resource.contentType ?? 'application/octet-stream';
    const body = await readManifest(upstream);
    const finalResource: MediaHandleResource = {
      ...resource,
      url: fetched.finalUrl,
      headers: fetched.headers,
      credentialOrigins: fetched.credentialOrigins,
    };
    res.type(contentType).setHeader('Cache-Control', 'private, max-age=15');
    res.send(rewriteManifest(body, contentType, finalResource, {
      id: String(req.params.id),
      token: typeof req.query.token === 'string' ? req.query.token : undefined,
      roomGrant: roomGrantToken(req),
    }));
  } catch (error) {
    res.status(502).json({ success: false, message: redactMediaError(error) });
  }
});

export default router;
