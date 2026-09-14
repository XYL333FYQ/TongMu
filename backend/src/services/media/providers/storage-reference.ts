import { isInternalNetworkHost } from '../../network-utils';

export type StorageProviderId = 'local-file' | 'webdav' | 'ftp' | 'openlist';

export interface StorageReference {
  provider: StorageProviderId;
  mountId?: number;
  path: string;
  rootKey?: string;
}

const MAX_REFERENCE_LENGTH = 2048;

function isProvider(value: string): value is StorageProviderId {
  return value === 'local-file' || value === 'webdav' || value === 'ftp' || value === 'openlist';
}

function normalizePath(value: string): string {
  const decoded = decodeURIComponent(value).replace(/\\/g, '/');
  if (!decoded || decoded.length > 1024 || decoded.includes('\0')) throw new Error('存储文件路径无效');
  return decoded.startsWith('/') ? decoded : `/${decoded}`;
}

/**
 * A playback input is an identifier for a configured source, not a URL that
 * contains credentials.  It is intentionally small enough to safely persist
 * in Movie.sourceInput and is resolved again by the server-side provider.
 */
export function parseStorageReference(input: string): StorageReference | undefined {
  if (!input.startsWith('storage://') || input.length > MAX_REFERENCE_LENGTH) return undefined;
  let parsed: URL;
  try { parsed = new URL(input); } catch { return undefined; }
  const provider = parsed.hostname;
  if (!isProvider(provider)) return undefined;
  const path = parsed.searchParams.get('path');
  if (!path) return undefined;
  const mountRaw = parsed.searchParams.get('mountId');
  const mountId = mountRaw === null ? undefined : Number(mountRaw);
  if (mountRaw !== null && (!Number.isSafeInteger(mountId) || (mountId as number) <= 0)) return undefined;
  const rootKey = parsed.searchParams.get('rootKey') ?? undefined;
  if (provider === 'local-file' && rootKey && !/^(?:uploads|custom:\d+)$/.test(rootKey)) return undefined;
  if (provider !== 'local-file' && rootKey) return undefined;
  try {
    return {
      provider,
      mountId,
      path: normalizePath(path),
      rootKey,
    };
  } catch {
    return undefined;
  }
}

export function buildStorageReference(reference: StorageReference): string {
  if (!isProvider(reference.provider)) throw new Error('未知的存储 Provider');
  const path = normalizePath(reference.path);
  if (reference.provider === 'local-file') {
    const rootKey = reference.rootKey ?? 'uploads';
    if (!/^(?:uploads|custom:\d+)$/.test(rootKey)) throw new Error('未知的服务器文件根目录');
  } else if (reference.rootKey) {
    throw new Error('远程存储不支持 rootKey');
  }
  const params = new URLSearchParams({ path });
  if (reference.mountId !== undefined) params.set('mountId', String(reference.mountId));
  if (reference.rootKey) params.set('rootKey', reference.rootKey);
  const output = `storage://${reference.provider}?${params.toString()}`;
  if (output.length > MAX_REFERENCE_LENGTH) throw new Error('存储引用过长');
  return output;
}

export type UrlVisibility = 'public' | 'short-lived-bearer' | 'credentialed' | 'private-network' | 'invalid';

/**
 * Classify a resolved URL before it can become a browser-visible DIRECT
 * candidate.  HTTP/HTTPS alone is not enough: long-lived API credentials and
 * private-LAN endpoints remain server-private.
 */
export function classifyPlaybackUrl(rawUrl: string): UrlVisibility {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return 'invalid'; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) return 'invalid';
  if (isInternalNetworkHost(url.hostname)) return 'private-network';
  const keys = [...url.searchParams.keys()].map((key) => key.toLowerCase());
  if (keys.some((key) => /^(?:authorization|auth|cookie|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)$/.test(key))) {
    return 'credentialed';
  }
  const hasSignature = keys.some((key) => /^(?:sign|signature|sig)$/.test(key));
  const hasExpiry = keys.some((key) => /^(?:exp|expires|expiry|expire|expires_at)$/.test(key));
  return hasSignature && hasExpiry ? 'short-lived-bearer' : 'public';
}

export function canPublishStorageDirectUrl(rawUrl: string): boolean {
  const visibility = classifyPlaybackUrl(rawUrl);
  return visibility === 'public' || visibility === 'short-lived-bearer';
}

export function assertStorageReference(input: string, expected?: StorageProviderId): StorageReference {
  const reference = parseStorageReference(input);
  if (!reference || (expected && reference.provider !== expected)) throw new Error('存储播放引用无效');
  return reference;
}
