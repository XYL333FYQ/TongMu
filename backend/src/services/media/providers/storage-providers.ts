import path from 'node:path';
import { AppDataSource } from '../../../data-source';
import { Movie } from '../../../entities/Movie';
import { UserMount, type MountType } from '../../../entities/UserMount';
import { detectMediaFormat, getContentType, type MediaFormat } from '../../mediaFormat';
import { resolveSafeExistingPath, loadRootRegistry, type RootRegistry } from '../../server-files/pathResolver';
import {
  fetchOpenListFileInfo,
  type OpenListDirectUrlResult,
} from '../../openlist';
import {
  statFTPFile,
  type FTPConnectionParams,
  type FTPFileInfo,
} from '../../ftp';
import {
  statWebDAVFile,
  type WebDAVConnectionParams,
  type WebDAVFileInfo,
} from '../../webdav';
import type { MediaDescriptor, MediaTransport } from '../types';
import type { PlaybackCandidate, PrivateMediaSource } from '../protocol';
import {
  assertProviderActive,
  type MediaProvider,
  type ProviderAvailability,
  type ProviderContext,
  type ProviderCredentialDependency,
  type ProviderPrivateContext,
  type ProviderResolution,
} from './types';
import {
  assertStorageReference,
  buildStorageReference,
  canPublishStorageDirectUrl,
  type StorageProviderId,
  type StorageReference,
} from './storage-reference';
import { normalizeOpenListServerUrl } from '../../openlist-errors';
import { isInternalNetworkHost, normalizeServerUrlWithScheme } from '../../network-utils';
import { assertPublicUrl } from '../../proxy/safe-fetch';

type StorageInfo = {
  name: string;
  path: string;
  size: number;
  lastModified?: Date;
};

export interface StorageProviderDependencies {
  loadMovie?: (context: ProviderContext, provider: StorageProviderId) => Promise<Movie | undefined>;
  loadMount?: (context: ProviderContext, reference: StorageReference, type: MountType) => Promise<UserMount>;
  loadRoots?: () => Promise<RootRegistry>;
  statWebDAV?: (params: WebDAVConnectionParams, signal?: AbortSignal) => Promise<WebDAVFileInfo>;
  statFTP?: (params: FTPConnectionParams, signal?: AbortSignal) => Promise<FTPFileInfo>;
  fetchOpenList?: (
    serverUrl: string,
    username: string | undefined,
    password: string | undefined,
    filePath: string,
    signal?: AbortSignal,
  ) => Promise<OpenListDirectUrlResult>;
  assertPublicUrl?: (url: string) => Promise<URL>;
}

function throwIfCancelled(context: ProviderContext): void {
  assertProviderActive(context);
}

function pipelinesFor(container: MediaFormat | MediaDescriptor['container']): PlaybackCandidate['requiredPipelines'] {
  return container === 'mkv' || container === 'avi' || container === 'wmv' || container === 'ts'
    ? ['native', 'playsvideo']
    : ['native'];
}

function fileDescriptor(
  input: string,
  providerId: StorageProviderId,
  info: StorageInfo,
  format: MediaFormat,
  finalUrl: string,
  contentType: string,
  extras: Partial<MediaDescriptor> = {},
): MediaDescriptor {
  return {
    title: info.name,
    sourceType: providerId === 'local-file' ? 'server-files' : providerId,
    resolver: providerId,
    input,
    originalUrl: finalUrl,
    finalUrl,
    transport: 'direct',
    container: format,
    contentType,
    contentLength: info.size,
    rangeSupported: true,
    contentDisposition: info.name,
    drm: { protected: false },
    probe: { method: 'resolver', bytesRead: 0, warnings: [] },
    ...extras,
  };
}

function privateSource(
  input: string,
  descriptor: MediaDescriptor,
  providerId: StorageProviderId,
  providerData: Record<string, unknown>,
): PrivateMediaSource {
  return {
    input,
    originalUrl: descriptor.originalUrl,
    finalUrl: descriptor.finalUrl,
    headers: descriptor.headers,
    credentialOrigins: descriptor.credentialOrigins,
    providerId,
    providerData,
  };
}

function candidateFor(
  descriptor: MediaDescriptor,
  url: string,
  requiresCustomHeaders = false,
): PlaybackCandidate {
  return {
    mode: 'DIRECT',
    url,
    transport: descriptor.transport,
    container: descriptor.container,
    requiredPipelines: pipelinesFor(descriptor.container),
    requiresCustomHeaders,
  };
}

function currentUserId(context: ProviderContext): number {
  const userId = Number(context.userId);
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('媒体来源用户无效');
  return userId;
}

async function movieForContext(
  context: ProviderContext,
  provider: StorageProviderId,
  deps?: StorageProviderDependencies,
): Promise<Movie | undefined> {
  if (context.movieId === undefined) return undefined;
  if (deps?.loadMovie) return deps.loadMovie(context, provider);
  const movie = await AppDataSource.getRepository(Movie).findOneBy({ id: context.movieId });
  if (!movie || !context.roomId || movie.roomId !== context.roomId) throw new Error('媒体来源不属于当前房间');
  const expected = provider === 'local-file' ? 'server-files' : provider;
  if (movie.source !== expected) throw new Error('媒体来源 Provider 不匹配');
  return movie;
}

async function mountForReference(
  context: ProviderContext,
  reference: StorageReference,
  type: MountType,
  deps?: StorageProviderDependencies,
): Promise<UserMount> {
  const mountId = reference.mountId;
  if (!mountId) throw new Error('播放引用缺少已保存的挂载');
  if (deps?.loadMount) return deps.loadMount(context, reference, type);
  const mount = await AppDataSource.getRepository(UserMount).findOneBy({
    id: mountId,
    userId: currentUserId(context),
    type,
  });
  if (!mount) throw new Error('无权访问该存储挂载');
  return mount;
}

function normalizedRemotePath(value: string): string {
  const output = value.replace(/\\/g, '/');
  if (output.includes('\0') || output.split('/').some((part) => part === '..')) throw new Error('存储路径越权');
  return output.startsWith('/') ? output : `/${output}`;
}

function validateFtpEndpoint(params: FTPConnectionParams): void {
  let parsed: URL;
  try { parsed = new URL(params.serverUrl); } catch { throw new Error('FTP 服务器地址无效'); }
  if (!['ftp:', 'ftps:'].includes(parsed.protocol) || parsed.username || parsed.password || !parsed.hostname) {
    throw new Error('FTP 服务器地址无效');
  }
  const port = params.port ?? (parsed.port ? Number(parsed.port) : 21);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('FTP 端口无效');
}

function validateHttpEndpoint(serverUrl: string, label: string): void {
  let parsed: URL;
  try { parsed = new URL(serverUrl); } catch { throw new Error(`${label} 服务器地址无效`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || !parsed.hostname) {
    throw new Error(`${label} 服务器地址无效`);
  }
}

function remoteUrl(serverUrl: string, filePath: string): string {
  const base = serverUrl.endsWith('/') ? serverUrl : `${serverUrl}/`;
  return new URL(normalizedRemotePath(filePath).replace(/^\/+/, ''), base).toString();
}

function remoteHost(serverUrl: string): string {
  return new URL(serverUrl).hostname;
}

function providerInputForMovie(input: string, movie: Movie | undefined): string {
  if (!movie?.path) return input;
  const reference = assertStorageReference(input);
  if (reference.provider === 'local-file') {
    const prefixed = /^(uploads|custom:\d+):(.*)$/.exec(movie.path);
    if (prefixed) return buildStorageReference({ ...reference, rootKey: prefixed[1], path: prefixed[2] || '/' });
  }
  return buildStorageReference({ ...reference, path: movie.path });
}

function commonDependencies(providerId: string, owner: ProviderCredentialDependency['owner'] = 'source-creator'): ProviderCredentialDependency[] {
  return [{ providerId, owner, requirement: 'required', scope: 'playback' }];
}

abstract class StorageProviderBase implements MediaProvider {
  abstract readonly id: StorageProviderId;
  abstract readonly sourceKinds: readonly string[];
  protected readonly deps: StorageProviderDependencies;

  constructor(deps: StorageProviderDependencies = {}) { this.deps = deps; }

  canHandle(input: string): boolean {
    return input.startsWith(`storage://${this.id}`);
  }

  validateInput(_context: ProviderContext, input: string): void {
    assertStorageReference(input, this.id);
  }

  normalizeInput(input: string): string {
    const reference = assertStorageReference(input, this.id);
    return buildStorageReference(reference);
  }

  availability(_context: ProviderContext): ProviderAvailability { return { available: true }; }

  credentialDependencies(_context: ProviderContext, _input: string): ProviderCredentialDependency[] {
    return commonDependencies(this.id);
  }

  abstract resolve(context: ProviderContext, input: string, privateContext: ProviderPrivateContext): Promise<ProviderResolution>;

  async cleanup(context: ProviderContext, sourceGeneration: number): Promise<void> {
    throwIfCancelled(context);
    void sourceGeneration;
  }
}

export class LocalFileProvider extends StorageProviderBase {
  readonly id = 'local-file' as const;
  readonly sourceKinds = ['server-files'] as const;

  override credentialDependencies(): ProviderCredentialDependency[] { return []; }

  async resolve(context: ProviderContext, input: string): Promise<ProviderResolution> {
    throwIfCancelled(context);
    const movie = await movieForContext(context, this.id, this.deps);
    const effectiveInput = providerInputForMovie(input, movie);
    const reference = assertStorageReference(effectiveInput, this.id);
    const roots = await (this.deps.loadRoots ?? loadRootRegistry)();
    const resolved = await resolveSafeExistingPath(
      `${reference.rootKey ?? 'uploads'}:${reference.path}`,
      roots,
    );
    throwIfCancelled(context);
    const format = detectMediaFormat(resolved.abs);
    const descriptor = fileDescriptor(
      effectiveInput,
      this.id,
      { name: path.basename(resolved.abs), path: reference.path, size: resolved.stat.size, lastModified: resolved.stat.mtime },
      format,
      effectiveInput,
      getContentType(format),
    );
    const data: Record<string, unknown> = {
      kind: 'local-file',
      filePath: resolved.abs,
      rootPath: resolved.rootReal,
      fileSize: resolved.stat.size,
      mtimeMs: resolved.stat.mtimeMs,
      contentType: getContentType(format),
      format,
      relativePath: reference.path,
    };
    return { privateSource: privateSource(effectiveInput, descriptor, this.id, data), descriptor, candidates: [] };
  }
}

export class WebDavProvider extends StorageProviderBase {
  readonly id = 'webdav' as const;
  readonly sourceKinds = ['webdav'] as const;

  async resolve(context: ProviderContext, input: string): Promise<ProviderResolution> {
    throwIfCancelled(context);
    const reference = assertStorageReference(input, this.id);
    const movie = await movieForContext(context, this.id, this.deps);
    const effectiveInput = providerInputForMovie(input, movie);
    const effectiveReference = assertStorageReference(effectiveInput, this.id);
    const mount = await mountForReference(context, effectiveReference, 'webdav', this.deps);
    if (!mount.serverUrl) throw new Error('WebDAV 挂载未配置服务器地址');
    const params: WebDAVConnectionParams = {
      serverUrl: normalizeServerUrlWithScheme(mount.serverUrl),
      path: normalizedRemotePath(effectiveReference.path),
      username: mount.username || undefined,
      password: mount.password || undefined,
    };
    validateHttpEndpoint(params.serverUrl, 'WebDAV');
    const stat = await (this.deps.statWebDAV ?? statWebDAVFile)(params, context.signal);
    throwIfCancelled(context);
    const finalUrl = remoteUrl(params.serverUrl, stat.path);
    const hasCredentials = !!(params.username || params.password);
    const format = detectMediaFormat(stat.name || stat.path);
    const descriptor = fileDescriptor(effectiveInput, this.id, stat, format, finalUrl, getContentType(format), {
      headers: hasCredentials ? { Authorization: `Basic ${Buffer.from(`${params.username ?? ''}:${params.password ?? ''}`).toString('base64')}` } : undefined,
      credentialOrigins: hasCredentials ? [new URL(params.serverUrl).origin] : undefined,
    });
    const data: Record<string, unknown> = {
      kind: 'webdav',
      serverUrl: params.serverUrl,
      path: stat.path,
      trustedPrivateHosts: [remoteHost(params.serverUrl)],
      contentType: getContentType(format),
      fileSize: stat.size,
    };
    let directAllowed = !hasCredentials && canPublishStorageDirectUrl(finalUrl);
    if (directAllowed) {
      try { await (this.deps.assertPublicUrl ?? assertPublicUrl)(finalUrl); } catch { directAllowed = false; }
    }
    const candidates = directAllowed ? [candidateFor(descriptor, finalUrl)] : [];
    return { privateSource: privateSource(effectiveInput, descriptor, this.id, data), descriptor, candidates };
  }
}

export class FtpProvider extends StorageProviderBase {
  readonly id = 'ftp' as const;
  readonly sourceKinds = ['ftp'] as const;

  async resolve(context: ProviderContext, input: string): Promise<ProviderResolution> {
    throwIfCancelled(context);
    const reference = assertStorageReference(input, this.id);
    const movie = await movieForContext(context, this.id, this.deps);
    const effectiveInput = providerInputForMovie(input, movie);
    const effectiveReference = assertStorageReference(effectiveInput, this.id);
    const mount = await mountForReference(context, effectiveReference, 'ftp', this.deps);
    if (!mount.serverUrl) throw new Error('FTP 挂载未配置服务器地址');
    const params: FTPConnectionParams = {
      serverUrl: normalizeServerUrlWithScheme(mount.serverUrl),
      path: normalizedRemotePath(effectiveReference.path),
      port: mount.port ?? undefined,
      username: mount.username || undefined,
      password: mount.password || undefined,
    };
    validateFtpEndpoint(params);
    const stat = await (this.deps.statFTP ?? statFTPFile)(params, context.signal);
    throwIfCancelled(context);
    const format = detectMediaFormat(stat.name || stat.path);
    const descriptor = fileDescriptor(effectiveInput, this.id, stat, format, effectiveInput, getContentType(format));
    const data: Record<string, unknown> = {
      kind: 'ftp',
      params,
      seekSupported: true,
      contentType: getContentType(format),
      fileSize: stat.size,
    };
    return { privateSource: privateSource(effectiveInput, descriptor, this.id, data), descriptor, candidates: [] };
  }
}

export class OpenListProvider extends StorageProviderBase {
  readonly id = 'openlist' as const;
  readonly sourceKinds = ['openlist'] as const;

  async resolve(context: ProviderContext, input: string): Promise<ProviderResolution> {
    throwIfCancelled(context);
    const reference = assertStorageReference(input, this.id);
    const movie = await movieForContext(context, this.id, this.deps);
    const effectiveInput = providerInputForMovie(input, movie);
    const effectiveReference = assertStorageReference(effectiveInput, this.id);
    const mount = await mountForReference(context, effectiveReference, 'openlist', this.deps);
    if (!mount.serverUrl) throw new Error('OpenList 挂载未配置服务器地址');
    const serverUrl = normalizeOpenListServerUrl(mount.serverUrl);
    validateHttpEndpoint(serverUrl, 'OpenList');
    const fetchFile = this.deps.fetchOpenList ?? fetchOpenListFileInfo;
    const file = await fetchFile(serverUrl, mount.username || undefined, mount.password || undefined, effectiveReference.path, context.signal);
    throwIfCancelled(context);
    const format = detectMediaFormat(file.name || effectiveReference.path);
    const descriptor = fileDescriptor(effectiveInput, this.id, {
      name: file.name || path.basename(effectiveReference.path),
      path: effectiveReference.path,
      size: file.size,
    }, format, file.rawUrl, getContentType(format), {
      // OpenList raw_url is commonly a short-lived signed URL. It is never
      // public merely because it uses HTTP; the candidate policy below decides.
      expiresAt: Date.now() + 5 * 60 * 1000,
    });
    const rawHost = new URL(file.rawUrl).hostname;
    const serverHost = new URL(serverUrl).hostname;
    if (isInternalNetworkHost(rawHost) && rawHost.toLowerCase() !== serverHost.toLowerCase()) {
      throw new Error('OpenList 返回了不属于已配置挂载边界的内网地址');
    }
    const data: Record<string, unknown> = {
      kind: 'openlist',
      rawUrl: file.rawUrl,
      serverUrl,
      path: effectiveReference.path,
      trustedPrivateHosts: [...new Set([serverHost, rawHost])],
      contentType: getContentType(format),
      fileSize: file.size,
      urlVisibility: canPublishStorageDirectUrl(file.rawUrl) ? 'public-or-short-lived' : 'server-private',
      expiresAt: descriptor.expiresAt,
    };
    let directAllowed = canPublishStorageDirectUrl(file.rawUrl);
    if (directAllowed) {
      try { await (this.deps.assertPublicUrl ?? assertPublicUrl)(file.rawUrl); } catch { directAllowed = false; }
    }
    const candidates = directAllowed ? [candidateFor(descriptor, file.rawUrl)] : [];
    return { privateSource: privateSource(effectiveInput, descriptor, this.id, data), descriptor, candidates };
  }

  async refresh(context: ProviderContext, source: ProviderResolution): Promise<ProviderResolution> {
    return this.resolve(context, source.privateSource.input);
  }
}

export function storageProviderFor(id: StorageProviderId): MediaProvider {
  if (id === 'local-file') return new LocalFileProvider();
  if (id === 'webdav') return new WebDavProvider();
  if (id === 'ftp') return new FtpProvider();
  return new OpenListProvider();
}
