import { redactMediaError } from '../../services/media/redact';
import {
  canDirect,
  publicMetadata,
  publicTransportCandidate,
  type PlaybackCandidate,
  type TransportPlan,
  type PublicMediaDescriptor,
} from '../../services/media/protocol';
import { AppDataSource } from '../../data-source';
import { Movie } from '../../entities/Movie';
import { Room } from '../../entities/Room';
import { UserMount } from '../../entities/UserMount';
import { Session } from '../../entities/Session';
import { IsNull } from 'typeorm';
import { Router } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth';
import { getUserCookie } from './helpers';
import { resolveMediaProvider } from '../../services/media/resolvers';
import {
  validatePlaybackClientProfile,
  PlaybackProfileError,
  audioCodecFamily,
  type PlaybackPipeline,
  videoCodecFamily,
} from '../../services/media/playback-profile';
import { filterPlaybackCandidates } from '../../services/media/viability';
import { issueMediaHandle, resolveMediaHandle, type MediaHandleResource } from '../../services/media/handles';
import { proxyHttpUpstream } from '../../services/proxy/http-proxy';
import { fetchWithProxyPolicy, fetchWithProxyPolicyDetailed } from '../../services/proxy/safe-fetch';
import rateLimit from 'express-rate-limit';
import type { MediaDescriptor } from '../../services/media/types';
import { authenticateToken, extractAccessToken, verifyAccessToken } from '../../middleware/auth';
import { authorizeRoomMediaGrant } from '../../services/media/room-access';
import { pipeProviderMediaHandle } from '../../services/media/provider-gateway';
import { mediaProviderRegistry, providerContextFromResolverContext } from '../../services/media/providers/registry';
import { buildMediaServerReference } from '../../services/media/providers/media-server-reference';
import { providerPlaybackSessionCoordinator } from '../../services/media/provider-playback-session';
import { legacyPlaybackClientProfile } from '../../services/media/playback-profile';
import {
  rewriteManifest as rewriteTypedManifest,
  DEFAULT_MAX_MANIFEST_DEPTH,
  DEFAULT_MAX_MANIFEST_RESOURCES,
} from '../../services/media/manifest/mapper';
import {
  manifestHandleKind,
  type DashResourceKind,
  type HlsResourceKind,
  type ManifestHandleKind,
} from '../../services/media/manifest/model';
import { buildBilibiliUnifiedManifest } from '../../services/media/manifest/bilibili';

const router = Router();
const canPublishTarget = (url: string) => canDirect({ finalUrl: url } as MediaDescriptor);
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_RESOURCES = DEFAULT_MAX_MANIFEST_RESOURCES;
const MAX_MANIFEST_DEPTH = DEFAULT_MAX_MANIFEST_DEPTH;
const MAX_HLS_KEY_BYTES = 1024 * 1024;
const mediaResolveLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, message: '媒体解析请求过于频繁，请稍后再试' },
});

function requiredPipelinesForDescriptor(descriptor: MediaDescriptor): PlaybackPipeline[] {
  if (descriptor.transport === 'hls') return ['native', 'mse'];
  if (descriptor.transport === 'dash' || descriptor.transport === 'flv') return ['mse'];
  if (['mkv', 'avi', 'wmv', 'ts'].includes(descriptor.container)) return ['native', 'playsvideo'];
  return ['native'];
}

function candidateFacts(
  descriptor: MediaDescriptor,
  mode: PlaybackCandidate['mode'],
  url: string,
  audioUrl?: string,
  providerCandidate?: PlaybackCandidate,
): PlaybackCandidate {
  const exactCodecStrings = providerCandidate?.exactCodecStrings ?? [descriptor.videoCodec, descriptor.audioCodec]
    .filter((value): value is string => !!value)
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter((value) => /^(?:avc1|avc3|hev1|hvc1|av01|vp0[89]|mp4a|opus|vorbis|ac-?3|ec-?3|dts|flac)(?:[.\d]|$)/i.test(value));
  return {
    mode,
    url,
    audioUrl,
    transport: providerCandidate?.transport ?? descriptor.transport,
    container: providerCandidate?.container ?? descriptor.container,
    videoCodec: providerCandidate?.videoCodec ?? videoCodecFamily(descriptor.videoCodec),
    audioCodec: providerCandidate?.audioCodec ?? audioCodecFamily(descriptor.audioCodec),
    actualQuality: providerCandidate?.actualQuality ?? descriptor.actualQuality,
    requiredPipelines: providerCandidate?.requiredPipelines ?? requiredPipelinesForDescriptor(descriptor),
    exactCodecStrings,
    // A gateway consumes upstream credentials on the server. Custom-header
    // support is relevant only to a browser DIRECT candidate.
    requiresCustomHeaders: mode === 'DIRECT' && (providerCandidate?.requiresCustomHeaders ?? Object.keys(descriptor.headers ?? {}).some((key) => !/^accept(?:-language)?$/i.test(key))),
    representationId: providerCandidate?.representationId,
    upstreamMode: providerCandidate?.upstreamMode,
    qualityPreserved: providerCandidate?.qualityPreserved,
    qualityChanged: providerCandidate?.qualityChanged,
    audioTranscoded: providerCandidate?.audioTranscoded,
    session: providerCandidate?.session,
    qualityIdentity: providerCandidate?.qualityIdentity,
  };
}

function pageProtocolForRequest(req: AuthenticatedRequest): 'http' | 'https' | undefined {
  const origin = req.get('origin');
  if (origin?.startsWith('https://')) return 'https';
  if (origin?.startsWith('http://')) return 'http';
  const forwarded = req.get('x-forwarded-proto');
  if (forwarded?.split(',')[0]?.trim() === 'https') return 'https';
  if (forwarded?.split(',')[0]?.trim() === 'http') return 'http';
  return undefined;
}

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

function appendAccessToken(url: string, token?: string): string {
  if (!token || !url.startsWith('/api/stream/media/')) return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

function dashAssetUrl(id: string, path: string, token?: string, roomGrant?: string, sourceGeneration?: number): string {
  const encodedPath = encodeDashAssetPath(path);
  const auth = token ? `&amp;token=${encodeURIComponent(token)}` : '';
  const roomAuth = roomGrant ? `&amp;roomGrant=${encodeURIComponent(roomGrant)}` : '';
  const generation = sourceGeneration === undefined ? '' : `&amp;sourceGeneration=${encodeURIComponent(String(sourceGeneration))}`;
  return `/api/stream/media/${encodeURIComponent(id)}/asset?path=${encodedPath}${auth}${roomAuth}${generation}`;
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

/** Compatibility facade for callers that used the old route-local mapper. */
export function rewriteManifest(
  body: string,
  contentType: string,
  resource: MediaHandleResource,
  handle: { id: string; token?: string; roomGrant?: string },
): string {
  const protocol: 'hls' | 'dash' = resource.resourceKind?.startsWith('hls-') ||
    /mpegurl|m3u8/i.test(contentType) || body.trimStart().startsWith('#EXTM3U') ? 'hls' : 'dash';
  const mapped = rewriteTypedManifest(body, contentType, {
    protocol,
    sourceUrl: resource.url,
    parentResourceId: handle.id,
    recursiveDepth: resource.recursiveDepth ?? 0,
    maxRecursiveDepth: MAX_MANIFEST_DEPTH,
    maxResources: MAX_MANIFEST_RESOURCES,
    // The historical exported helper always meant a full gateway rewrite.
    // Live routing above supplies the real Direct/Assisted/Partial mode.
    mapResource: (mapping) => mapTypedManifestResource(
      resource.transportMode ? resource : { ...resource, transportMode: 'FULL_PROXY' },
      mapping,
      handle,
    ),
  }).body;
  // Historical callers expected inherited BaseURL nodes to be materialized
  // into concrete attributes. The live route keeps typed BaseURL candidates;
  // this facade preserves the old serialized shape only.
  return mapped.replace(/<BaseURL(?:\s[^>]*)?>[^<]*<\/BaseURL>/g, '');
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

async function pipeHlsKey(req: AuthenticatedRequest, res: import('express').Response, resource: MediaHandleResource): Promise<void> {
  if (req.headers.range) { res.status(416).end(); return; }
  const fetched = await fetchWithProxyPolicyDetailed(
    resource.url,
    { method: 'GET', headers: resource.headers },
    resource.targetPolicy ?? 'public-only',
    resource.trustedPrivateHosts,
  );
  const upstream = fetched.response;
  if (!upstream.ok) { await upstream.body?.cancel(); res.sendStatus(upstream.status); return; }
  const declared = Number(upstream.headers.get('content-length') ?? 0);
  if (declared > MAX_HLS_KEY_BYTES) { await upstream.body?.cancel(); res.status(502).json({ success: false, message: 'HLS key 超出大小限制' }); return; }
  if (!upstream.body) { res.status(upstream.status).end(); return; }
  const reader = upstream.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (total <= MAX_HLS_KEY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_HLS_KEY_BYTES) {
        await reader.cancel();
        res.status(502).json({ success: false, message: 'HLS key 超出大小限制' });
        return;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  res.status(upstream.status);
  res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'application/octet-stream');
  res.setHeader('Content-Length', String(total));
  res.setHeader('Cache-Control', 'no-store, no-transform');
  res.send(Buffer.concat(chunks, total));
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
  const resource = resolveMediaHandle(String(req.params.id), optionalViewerId(req), grant);
  const expectedGeneration = req.query.sourceGeneration ?? req.body?.sourceGeneration;
  if (resource?.sourceGeneration !== undefined &&
      (typeof expectedGeneration !== 'string' || expectedGeneration !== String(resource.sourceGeneration))) return undefined;
  return resource;
}

function withSourceGeneration(url: string, generation?: number): string {
  if (generation === undefined || !url.startsWith('/api/stream/media/')) return url;
  return `${url}${url.includes('?') ? '&' : '?'}sourceGeneration=${encodeURIComponent(String(generation))}`;
}

function issuePlaybackSessionCapability(
  resource: Pick<MediaHandleResource, 'scope' | 'expiresAt' | 'sourceGeneration'>,
  session: NonNullable<MediaHandleResource['session']>,
): string {
  const issued = issueMediaHandle({
    kind: 'session',
    // The URL is sealed and is never returned. It only satisfies the handle's
    // structural invariant; session operations use the sealed binding below.
    url: 'https://tongmu.invalid/provider-session',
    scope: resource.scope,
    providerId: session.providerId,
    session,
    sourceGeneration: resource.sourceGeneration,
    expiresAt: resource.expiresAt,
  });
  return withSourceGeneration(`${issued.url}/session`, resource.sourceGeneration);
}

function sessionContextForRequest(
  req: AuthenticatedRequest,
  session: NonNullable<MediaHandleResource['session']>,
): ReturnType<typeof providerContextFromResolverContext> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once('aborted', abort);
  return providerContextFromResolverContext({
    userId: userIdOf(req) || session.actorUserId || '',
    roomId: session.roomId,
    movieId: session.movieId,
    sourceGeneration: session.sourceGeneration,
    credentialOwnerId: session.credentialOwnerId,
    signal: controller.signal,
    deadline: Date.now() + 8_000,
    playbackClientProfile: legacyPlaybackClientProfile(),
    qualityChangingTranscode: 'disabled',
  });
}

function isManifestHandleKind(kind: ManifestHandleKind): boolean {
  return kind === 'hls-manifest' || kind === 'dash-manifest' || kind === 'dash-recursive-manifest';
}

function splitDashTemplateTarget(target: string): { scopeUrl: string; suffix: string; assetPathPrefix: string } {
  const url = new URL(target);
  const segments = url.pathname.split('/');
  const dynamicIndex = segments.findIndex((segment) => /\$/.test(segment));
  const dynamicQuery = /\$(?:\$|RepresentationID|Number|Time|Bandwidth)/i.test(url.search);
  if (dynamicIndex < 0) {
    const directory = new URL('.', target);
    const file = segments[segments.length - 1] || '';
    directory.search = '';
    directory.hash = '';
    return {
      scopeUrl: directory.toString(),
      suffix: `${file}${url.search}${url.hash}`,
      assetPathPrefix: directory.pathname,
    };
  }
  const prefix = segments.slice(0, dynamicIndex).join('/');
  const pathPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`;
  const suffix = `${segments.slice(dynamicIndex).join('/')}${dynamicQuery ? url.search : ''}${url.hash}`;
  const scope = new URL(target);
  scope.pathname = pathPrefix;
  if (dynamicQuery) {
    scope.search = '';
  }
  scope.hash = '';
  return { scopeUrl: scope.toString(), suffix, assetPathPrefix: pathPrefix };
}

function mapTypedManifestResource(
  resource: MediaHandleResource,
  mapping: {
    protocol: 'hls' | 'dash';
    kind: HlsResourceKind | DashResourceKind;
    upstreamUrl: string;
    parentResourceId: string;
    recursiveDepth: number;
    allowRange: boolean;
    representationIdentity?: string;
    template?: boolean;
  },
  handle: { token?: string; roomGrant?: string },
): string {
  const manifestKind = manifestHandleKind(mapping.protocol, mapping.kind);
  const target = new URL(mapping.upstreamUrl).toString();
  const targetHeaders = headersForTarget(resource, target);
  const isKey = manifestKind === 'hls-key';
  const isBase = manifestKind === 'dash-base';
  const effectiveResource = isKey && resource.transportMode !== 'FULL_PROXY'
    ? { ...resource, transportMode: 'FULL_PROXY' as const }
    : resource;

  // Assisted/partial mode deliberately retains public same-representation
  // child URLs. The mapper still classifies them; only private or manifest
  // children need a sealed server resource.
  const isAssistedManifest = effectiveResource.transportMode === 'MANIFEST_ASSISTED' ||
    effectiveResource.transportMode === 'PARTIAL_PROXY';
  if (
    isAssistedManifest &&
    !isManifestHandleKind(manifestKind) &&
    !isKey &&
    !isBase &&
    canPublishTarget(target)
  ) return target;

  let childUrl = target;
  let suffix = '';
  let assetPathPrefix: string | undefined;
  if (mapping.protocol === 'dash' && mapping.template) {
    const split = splitDashTemplateTarget(target);
    const sourceDirectory = new URL('.', resource.url).pathname;
    childUrl = split.assetPathPrefix === sourceDirectory ? resource.url : split.scopeUrl;
    suffix = split.suffix;
    assetPathPrefix = split.assetPathPrefix;
  }
  const issued = issueMediaHandle({
    kind: 'media',
    url: childUrl,
    scope: effectiveResource.scope,
    headers: targetHeaders,
    credentialOrigins: effectiveResource.credentialOrigins,
    contentType: isManifestHandleKind(manifestKind)
      ? (mapping.protocol === 'hls' ? 'application/vnd.apple.mpegurl' : 'application/dash+xml')
      : effectiveResource.contentType,
    rewriteManifest: isManifestHandleKind(manifestKind),
    resourceKind: manifestKind,
    parentResourceId: mapping.parentResourceId,
    rootSourceIdentity: effectiveResource.rootSourceIdentity ?? resource.url,
    recursiveDepth: mapping.recursiveDepth,
    allowRange: mapping.allowRange,
    representationIdentity: mapping.representationIdentity,
    assetPathPrefix: mapping.template
      ? assetPathPrefix
      : isBase
        ? new URL(childUrl).pathname
        : undefined,
    cachePolicyHint: 'future-slice-cache',
    transportMode: effectiveResource.transportMode,
    providerId: effectiveResource.providerId,
    providerData: effectiveResource.providerData,
    session: effectiveResource.session,
    targetPolicy: effectiveResource.targetPolicy,
    trustedPrivateHosts: effectiveResource.trustedPrivateHosts,
    sourceGeneration: effectiveResource.sourceGeneration,
    expiresAt: effectiveResource.expiresAt,
  });
  const issuedUrl = mapping.protocol === 'dash' && mapping.template
    ? dashAssetUrl(issued.id, suffix, handle.token, handle.roomGrant, effectiveResource.sourceGeneration)
    : isBase
      ? withSourceGeneration(`${issued.url}/base/`, effectiveResource.sourceGeneration)
    : withSourceGeneration(issued.url, effectiveResource.sourceGeneration);
  return appendRoomGrant(appendAccessToken(issuedUrl, handle.token), handle.roomGrant);
}

export function sessionActorIsCurrentUser(
  session: Pick<NonNullable<MediaHandleResource['session']>, 'actorUserId'>,
  userId: string,
): boolean {
  return Boolean(userId && session.actorUserId && session.actorUserId === userId);
}

async function handlePlaybackSessionRequest(
  req: AuthenticatedRequest,
  res: import('express').Response,
  action: 'start' | 'progress' | 'stop' | 'cleanup',
): Promise<void> {
  const resource = await authorizedResource(req);
  const session = resource?.session;
  const provider = resource?.providerId ? mediaProviderRegistry.get(resource.providerId) : undefined;
  if (!resource || resource.kind !== 'session' || !session || !provider?.playbackSession) {
    res.status(403).json({ success: false, message: '媒体播放会话凭证无效' });
    return;
  }
  if (!sessionActorIsCurrentUser(session, userIdOf(req))) {
    res.status(403).json({ success: false, message: '只有创建该媒体会话的用户可以操作它' });
    return;
  }
  const context = sessionContextForRequest(req, session);
  try {
    if (action === 'start') {
      await providerPlaybackSessionCoordinator.start(provider, context, session);
    } else if (action === 'progress') {
      const position = Number(req.body?.position);
      if (!Number.isFinite(position) || position < 0 || position > 7_200_000) {
        res.status(400).json({ success: false, message: '播放进度无效' });
        return;
      }
      await providerPlaybackSessionCoordinator.progress(provider, context, session, position, req.body?.paused === true);
    } else if (action === 'stop') {
      const position = Number(req.body?.position ?? 0);
      await providerPlaybackSessionCoordinator.stop(provider, context, session, Number.isFinite(position) && position >= 0 ? position : 0);
    } else {
      await providerPlaybackSessionCoordinator.cleanup(provider, context, session);
    }
    res.json({ success: true });
  } catch (error) {
    if (action === 'cleanup') {
      // Cleanup is intentionally best effort and must not block player/source
      // replacement. The coordinator already makes it idempotent.
      res.json({ success: true, cleanup: 'best-effort' });
      return;
    }
    res.status(502).json({ success: false, message: redactMediaError(error) });
  }
}

router.post('/media/resolve', authenticateToken, mediaResolveLimiter, async (req: AuthenticatedRequest, res) => {
  let input = typeof req.body?.input === 'string' ? req.body.input.trim() : '';
  let mediaMovieId: number | undefined;
  if (!input || input.length > 4096) { res.status(400).json({ success: false, message: '请输入有效媒体 URL 或 BV 号' }); return; }
  const ownerId = userIdOf(req);
  const roomId = typeof req.body?.roomId === 'string' && req.body.roomId.trim()
    ? req.body.roomId.trim().slice(0, 128) : undefined;
  let credentialOwnerId = ownerId;
  let mediaMovie: Movie | undefined;
  if (roomId) {
    const room = await AppDataSource.getRepository(Room).findOneBy({ roomId });
    if (room?.ownerUserId) credentialOwnerId = String(room.ownerUserId);
    const grant = await authorizeRoomMediaGrant(roomGrantToken(req), roomId);
    const host = grant && await AppDataSource.getRepository(Session).findOneBy({ roomId, socketId: grant.socketId, role: 'sharer', endedAt: IsNull() });
    if (!host) { res.status(403).json({ success: false, message: '只有房主可以统一解析房间媒体' }); return; }
  }
  if (input.startsWith('media-movie:')) {
    const movieId = Number(input.slice(12));
    const movie = await AppDataSource.getRepository(Movie).findOneBy({ id: movieId });
    const grant = await authorizeRoomMediaGrant(roomGrantToken(req), roomId);
    const host = grant && await AppDataSource.getRepository(Session).findOneBy({ roomId: grant.roomId, socketId: grant.socketId, role: 'sharer', endedAt: IsNull() });
    if (!movie || !host || movie.roomId !== roomId) {
      res.status(403).json({ success: false, message: '只有当前房主可以刷新房间私有媒体源' }); return;
    }
    mediaMovie = movie;
    if (movie.sourceInput?.startsWith('provider://')) {
      input = movie.sourceInput;
    } else if ((movie.source === 'emby' || movie.source === 'jellyfin') && movie.path) {
      const mounts = await AppDataSource.getRepository(UserMount).find({
        where: { userId: Number(credentialOwnerId), type: movie.source },
      });
      const mount = mounts.find((item) => !!movie.serverUrl && item.serverUrl === movie.serverUrl);
      if (!mount) {
        res.status(403).json({ success: false, message: '旧媒体记录未找到其所属媒体服务器挂载' }); return;
      }
      input = buildMediaServerReference({ provider: movie.source, mountId: mount.id, itemId: movie.path });
    } else if (movie.sourceInput?.trim()) {
      // Existing non-media-server records (for example legacy direct URLs)
      // keep their server-private source input for an authorized refresh.
      // Emby/Jellyfin records are handled above so an expired provider URL
      // cannot become a new long-lived source identity.
      input = movie.sourceInput.trim();
    } else {
      res.status(403).json({ success: false, message: '媒体记录缺少稳定的 Provider 引用' }); return;
    }
    mediaMovieId = movieId;
  }
  let profile: ReturnType<typeof validatePlaybackClientProfile>;
  try {
    profile = validatePlaybackClientProfile(req.body?.profile);
  } catch (error) {
    const code = error instanceof PlaybackProfileError ? error.code : 'MALFORMED_PROFILE';
    res.status(400).json({ success: false, code, message: error instanceof Error ? error.message : '播放能力声明无效' });
    return;
  }
  const scope = roomId ? `room:${roomId}` : `user:${ownerId}`;
  const resolveController = new AbortController();
  const resolveDeadline = Date.now() + 30_000;
  const abortResolve = () => resolveController.abort();
  const resolveTimer = setTimeout(abortResolve, 30_000);
  req.once('aborted', abortResolve);
  try {
    const cookie = (await getUserCookie(req.user?.userId)) || undefined;
    const providerResolution = await resolveMediaProvider(input, {
      userId: ownerId, cookie, browserSniff: req.body?.browserSniff === true,
      requestedQn: Number.isFinite(req.body?.requestedQn) ? Number(req.body.requestedQn) : undefined,
      preferMp4: req.body?.preferMp4 === true,
      page: Number.isFinite(req.body?.page) ? Number(req.body.page) : undefined,
      cid: Number.isFinite(req.body?.cid) ? Number(req.body.cid) : undefined,
      signal: resolveController.signal,
      deadline: resolveDeadline,
      roomId,
      sourceGeneration: Number.isSafeInteger(req.body?.sourceGeneration) ? Number(req.body.sourceGeneration) : undefined,
      movieId: mediaMovieId,
      credentialOwnerId,
      qualityChangingTranscode: req.body?.allowQualityChangingTranscode === true ? 'explicit' : 'disabled',
      playbackClientProfile: profile,
    });
    const descriptor = providerResolution.descriptor;
    if (descriptor.drm.protected) {
      res.status(422).json({
        success: false,
        code: 'DRM_UNSUPPORTED',
        message: '检测到 DRM 加密，当前无法作为普通媒体播放',
        descriptor: toPublicDescriptor(descriptor, ''),
      });
      return;
    }
    const privateSource = providerResolution.privateSource;
    const providerId = privateSource.providerId;
    const providerData = privateSource.providerData;
    if (mediaMovie && providerResolution.sourceReference && mediaMovie.sourceInput !== providerResolution.sourceReference) {
      // Upgrade an old movie record to the stable provider/mount/item identity
      // after a successful server-side resolution. No temporary URL is stored.
      mediaMovie.sourceInput = providerResolution.sourceReference;
      await AppDataSource.getRepository(Movie).save(mediaMovie);
    }
    const requestedSourceGeneration = Number.isSafeInteger(req.body?.sourceGeneration)
      ? Number(req.body.sourceGeneration)
      : undefined;
    const trustedPrivateHosts = Array.isArray(providerData?.trustedPrivateHosts)
      ? providerData.trustedPrivateHosts.filter((value): value is string => typeof value === 'string')
      : undefined;
    const targetPolicy = providerId === 'webdav' || providerId === 'openlist' || providerId === 'emby' || providerId === 'jellyfin'
      ? 'trusted-private' as const : undefined;
    const handleExpiresAt = descriptor.expiresAt && descriptor.expiresAt > Date.now()
      ? descriptor.expiresAt
      : undefined;
    const privateCandidates: PlaybackCandidate[] = [];
    const sessionUrls = new Map<PlaybackCandidate, string | undefined>();
    const providerCandidates = providerResolution.candidates.length
      ? providerResolution.candidates
      : [undefined];
    let resolvedExpiry: number | undefined;
    for (const providerCandidate of providerCandidates) {
      const handleUrl = providerCandidate?.url || privateSource.finalUrl || descriptor.finalUrl;
      const handleHeaders = privateSource.headers ?? descriptor.headers;
      const bilibiliUnifiedManifest = providerId === 'bilibili' && providerCandidate?.transport === 'dash'
        ? buildBilibiliUnifiedManifest({
            videoUrl: providerCandidate.url,
            audioUrl: providerCandidate.audioUrl,
            videoCodec: providerCandidate.exactCodecStrings?.find((value) => /^(?:avc|hev|hvc|av01|vp)/i.test(value)) ?? descriptor.videoCodec,
            audioCodec: providerCandidate.exactCodecStrings?.find((value) => /^(?:mp4a|opus|vorbis|ac-?3|ec-?3|dts|flac)/i.test(value)) ?? descriptor.audioCodec,
            videoBandwidth: descriptor.actualBandwidth ?? descriptor.bitrate,
            duration: descriptor.duration,
            quality: providerCandidate.actualQuality ?? descriptor.actualQuality,
          })
        : undefined;
      const candidateIsManifest = Boolean(bilibiliUnifiedManifest) || (
        providerCandidate
          ? providerCandidate.transport === 'hls' || providerCandidate.transport === 'dash' || shouldRewriteManifest(descriptor)
          : shouldRewriteManifest(descriptor)
      );
      const candidateResourceKind: ManifestHandleKind | 'media' = bilibiliUnifiedManifest
        ? 'dash-manifest'
        : providerCandidate?.transport === 'hls' || (!providerCandidate && descriptor.transport === 'hls')
          ? 'hls-manifest'
          : providerCandidate?.transport === 'dash' || (!providerCandidate && descriptor.transport === 'dash')
            ? 'dash-manifest'
            : 'media';
      const handle = issueMediaHandle({
        kind: 'media',
        url: handleUrl,
        scope,
        headers: handleHeaders,
        credentialOrigins: credentialOriginsFor(
          handleUrl,
          handleHeaders,
          privateSource.credentialOrigins ?? descriptor.credentialOrigins,
        ),
        contentType: bilibiliUnifiedManifest
          ? 'application/dash+xml'
          : providerCandidate?.container === 'hls' ? 'application/vnd.apple.mpegurl' : descriptor.contentType,
        rewriteManifest: candidateIsManifest,
        resourceKind: candidateResourceKind,
        parentResourceId: 'root',
        rootSourceIdentity: privateSource.finalUrl || descriptor.finalUrl,
        recursiveDepth: 0,
        allowRange: true,
        cachePolicyHint: 'future-slice-cache',
        transportMode: 'FULL_PROXY',
        manifestBody: bilibiliUnifiedManifest,
        providerId,
        providerData,
        session: providerCandidate?.session ?? providerResolution.session,
        targetPolicy,
        trustedPrivateHosts,
        sourceGeneration: requestedSourceGeneration,
        expiresAt: handleExpiresAt,
      });
      resolvedExpiry = handle.expiresAt;
      const audioUrl = bilibiliUnifiedManifest
        ? undefined
        : providerCandidate?.audioUrl || (!providerCandidate ? descriptor.audioUrl : undefined);
      const audioHandle = audioUrl ? issueMediaHandle({
        kind: 'media',
        url: audioUrl,
        scope,
        headers: handleHeaders,
        contentType: 'audio/mp4',
        credentialOrigins: credentialOriginsFor(audioUrl, handleHeaders, privateSource.credentialOrigins ?? descriptor.credentialOrigins),
        expiresAt: handle.expiresAt,
        sourceGeneration: requestedSourceGeneration,
      }) : undefined;
      const session = providerCandidate?.session ?? providerResolution.session;
      const sessionUrl = session && providerId && mediaProviderRegistry.get(providerId)?.playbackSession
        ? issuePlaybackSessionCapability({ scope, expiresAt: handle.expiresAt, sourceGeneration: requestedSourceGeneration }, session)
        : undefined;
      const full = candidateFacts(
        descriptor,
        'FULL_PROXY',
        withSourceGeneration(handle.url, requestedSourceGeneration),
        audioHandle ? withSourceGeneration(audioHandle.url, requestedSourceGeneration) : undefined,
        providerCandidate,
      );
      sessionUrls.set(full, sessionUrl);

      const candidateIsDirect = providerCandidate
        ? providerCandidate.mode === 'DIRECT' && canPublishTarget(providerCandidate.url) && !providerCandidate.requiresCustomHeaders
        : !providerId && canDirect(descriptor);
      if (candidateIsDirect) {
        const direct = candidateFacts(
          descriptor,
          'DIRECT',
          providerCandidate?.url ?? descriptor.finalUrl,
          providerCandidate?.audioUrl ?? descriptor.audioUrl,
          providerCandidate,
        );
        privateCandidates.push(direct);
        sessionUrls.set(direct, sessionUrl);
        if (shouldRewriteManifest(descriptor) || providerCandidate?.transport === 'hls' || providerCandidate?.transport === 'dash') {
          for (const mode of ['MANIFEST_ASSISTED', 'PARTIAL_PROXY'] as const) {
            const assistedHandle = issueMediaHandle({
              kind: 'media',
              url: handleUrl,
              scope,
              rewriteManifest: true,
              resourceKind: candidateResourceKind === 'media' ? 'dash-manifest' : candidateResourceKind,
              parentResourceId: 'root',
              rootSourceIdentity: privateSource.finalUrl || descriptor.finalUrl,
              recursiveDepth: 0,
              allowRange: true,
              cachePolicyHint: 'future-slice-cache',
              manifestBody: bilibiliUnifiedManifest,
              transportMode: mode,
              headers: handleHeaders,
              credentialOrigins: credentialOriginsFor(handleUrl, handleHeaders, privateSource.credentialOrigins ?? descriptor.credentialOrigins),
              expiresAt: handle.expiresAt,
              providerId,
              providerData,
              session,
              targetPolicy,
              trustedPrivateHosts,
              sourceGeneration: requestedSourceGeneration,
            });
            const assisted = candidateFacts(descriptor, mode, withSourceGeneration(assistedHandle.url, requestedSourceGeneration), undefined, providerCandidate);
            privateCandidates.push(assisted);
            sessionUrls.set(assisted, sessionUrl);
          }
        }
      }
      // Keep the public candidate order compatible with the existing transport
      // fallback contract: a browser-safe direct route is tried first, while
      // the sealed gateway remains the same-quality fallback. Provider-only
      // routes still emit the gateway candidate as their first route.
      privateCandidates.push(full);
    }
    if (resolvedExpiry) descriptor.expiresAt = resolvedExpiry;
    const viability = filterPlaybackCandidates(descriptor, privateCandidates, profile, {
      pageProtocol: pageProtocolForRequest(req),
    });
    if (viability.viable.length === 0) {
      res.status(422).json({
        success: false,
        code: 'PLAYBACK_CAPABILITY_UNAVAILABLE',
        message: '当前客户端没有可行的同质量媒体传输路线',
        descriptor: toPublicDescriptor(descriptor, ''),
        viability: { removed: viability.removed },
      });
      return;
    }
    const transportPlan: TransportPlan = {
      reason: viability.viable.some((candidate) => candidate.qualityChanged)
        ? '仅在显式策略允许时提供标记为转码的不同媒体表示；其余候选保持原始质量'
        : viability.viable.some((candidate) => candidate.mode === 'DIRECT')
          ? '客户端按自身 profile 选择直连或同质量中转候选'
          : '源站需要私有请求头或私有 URL，使用同质量中转',
      candidates: viability.viable.map((candidate) => publicTransportCandidate(candidate, sessionUrls.get(candidate))),
    };
    const first = transportPlan.candidates[0];

    res.json({
      success: true,
      sourceReference: providerResolution.sourceReference,
      descriptor: { ...toPublicDescriptor(descriptor, first.url, first.audioUrl), transportPlan },
      viability: { removed: viability.removed },
    });
  } catch (error) {
    res.status(422).json({ success: false, message: redactMediaError(error) });
  } finally {
    clearTimeout(resolveTimer);
    req.off('aborted', abortResolve);
  }
});

router.post('/media/:id/session/start', authenticateToken, async (req: AuthenticatedRequest, res) => {
  await handlePlaybackSessionRequest(req, res, 'start');
});

router.post('/media/:id/session/progress', authenticateToken, async (req: AuthenticatedRequest, res) => {
  await handlePlaybackSessionRequest(req, res, 'progress');
});

router.post('/media/:id/session/stop', authenticateToken, async (req: AuthenticatedRequest, res) => {
  await handlePlaybackSessionRequest(req, res, 'stop');
});

router.post('/media/:id/session/cleanup', authenticateToken, async (req: AuthenticatedRequest, res) => {
  await handlePlaybackSessionRequest(req, res, 'cleanup');
});

async function pipeDashBaseResource(req: AuthenticatedRequest, res: import('express').Response): Promise<void> {
  const resource = await authorizedResource(req);
  if (!resource || resource.resourceKind !== 'dash-base' || !resource.assetPathPrefix) {
    res.status(403).end();
    return;
  }
  const rawPath = Array.isArray(req.params.splat) ? req.params.splat.join('/') : String(req.params.splat ?? '');
  let target: URL;
  try { target = new URL(rawPath || '.', resource.url); } catch { res.status(400).end(); return; }
  if (target.origin !== new URL(resource.url).origin || !target.pathname.startsWith(resource.assetPathPrefix)) {
    res.status(403).end();
    return;
  }
  await proxyHttpUpstream(req, res, {
    url: target.toString(),
    targetPolicy: resource.targetPolicy ?? 'public-only',
    trustedPrivateHosts: resource.trustedPrivateHosts,
    headers: { extra: headersForTarget(resource, target.toString()) },
    cors: 'global',
    logTag: 'media-dash-base',
    errorMessage: 'DASH BaseURL 请求失败',
  });
}

router.get('/media/:id/base', pipeDashBaseResource);
router.get('/media/:id/base/*splat', pipeDashBaseResource);

router.get('/media/:id/asset', async (req: AuthenticatedRequest, res) => {
  const id = String(req.params.id);
  const resource = await authorizedResource(req);
  const relativePath = typeof req.query.path === 'string' ? req.query.path : '';
  const assetKinds = new Set([
    'dash-media', 'dash-initialization', 'dash-index', 'dash-bitstream-switching',
    'dash-timing', 'dash-auxiliary',
  ]);
  if (!resource || !relativePath || !resource.resourceKind || !assetKinds.has(resource.resourceKind) || !resource.assetPathPrefix) {
    res.status(403).end(); return;
  }
  if (resource.allowRange === false && req.headers.range) { res.status(416).end(); return; }
  let target: URL;
  try { target = new URL(relativePath, resource.url); } catch { res.status(400).end(); return; }
  // Template requests can vary only within the manifest's origin; they cannot turn a handle into an open proxy.
  if (target.origin !== new URL(resource.url).origin) { res.status(403).end(); return; }
  if (resource.assetPathPrefix && !target.pathname.startsWith(resource.assetPathPrefix)) {
    res.status(403).end(); return;
  }
  await proxyHttpUpstream(req, res, {
      url: target.toString(), targetPolicy: resource.targetPolicy ?? 'public-only',
      trustedPrivateHosts: resource.trustedPrivateHosts,
      headers: { extra: headersForTarget(resource, target.toString()) },
    cors: 'global', logTag: 'media-segment', errorMessage: 'DASH 分片请求失败',
  });
});

router.get('/media/:id', async (req: AuthenticatedRequest, res) => {
  const resource = await authorizedResource(req);
  if (!resource || resource.kind === 'session') { res.status(403).json({ success: false, message: '媒体凭证无效或已过期' }); return; }
  if (resource.allowRange === false && req.headers.range) { res.status(416).end(); return; }
  if (resource.resourceKind === 'hls-key') {
    try {
      await pipeHlsKey(req, res, resource);
    } catch (error) {
      res.status(502).json({ success: false, message: redactMediaError(error) });
    }
    return;
  }
  if (!resource.rewriteManifest) {
    if (await pipeProviderMediaHandle(req, res, resource)) return;
    await proxyHttpUpstream(req, res, {
      url: resource.url, targetPolicy: resource.targetPolicy ?? 'public-only',
      trustedPrivateHosts: resource.trustedPrivateHosts,
      headers: { extra: resource.headers },
      defaultContentType: resource.contentType, cors: 'global', logTag: 'media-handle', errorMessage: '媒体网关请求失败',
    });
    return;
  }
  try {
    let contentType = resource.contentType ?? 'application/octet-stream';
    let body: string;
    let finalResource: MediaHandleResource = resource;
    if (resource.manifestBody !== undefined) {
      body = resource.manifestBody;
    } else {
      const fetched = await fetchWithProxyPolicyDetailed(
        resource.url,
        { method: 'GET', headers: resource.headers },
        resource.targetPolicy ?? 'public-only',
        resource.trustedPrivateHosts,
      );
      const upstream = fetched.response;
      if (!upstream.ok) { await upstream.body?.cancel(); res.sendStatus(upstream.status); return; }
      contentType = upstream.headers.get('content-type') ?? contentType;
      body = await readManifest(upstream);
      finalResource = {
        ...resource,
        url: fetched.finalUrl,
        headers: fetched.headers,
        credentialOrigins: fetched.credentialOrigins,
      };
    }
    const protocol: 'hls' | 'dash' =
      finalResource.resourceKind?.startsWith('hls-') || /mpegurl|m3u8/i.test(contentType) || body.trimStart().startsWith('#EXTM3U')
        ? 'hls'
        : 'dash';
    res.type(contentType).setHeader('Cache-Control', 'private, max-age=15');
    const mapped = rewriteTypedManifest(body, contentType, {
      protocol,
      sourceUrl: finalResource.url,
      parentResourceId: String(req.params.id),
      recursiveDepth: finalResource.recursiveDepth ?? 0,
      maxRecursiveDepth: MAX_MANIFEST_DEPTH,
      maxResources: MAX_MANIFEST_RESOURCES,
      mapResource: (mapping) => mapTypedManifestResource(finalResource, mapping, {
        token: typeof req.query.token === 'string' ? req.query.token : undefined,
        roomGrant: roomGrantToken(req),
      }),
    });
    res.send(mapped.body);
  } catch (error) {
    res.status(502).json({ success: false, message: redactMediaError(error) });
  }
});

export default router;
