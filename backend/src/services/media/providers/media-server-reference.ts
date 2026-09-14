import type { MediaServerProviderId } from './media-server-types';

export interface MediaServerReference {
  provider: MediaServerProviderId;
  mountId: number;
  itemId: string;
  mediaSourceId?: string;
}

const MAX_REFERENCE_LENGTH = 2048;
const SAFE_ID = /^[A-Za-z0-9_-]{1,256}$/;

function isProvider(value: string): value is MediaServerProviderId {
  return value === 'emby' || value === 'jellyfin';
}

function boundedId(value: string | null): string | undefined {
  if (!value || !SAFE_ID.test(value)) return undefined;
  return value;
}

/**
 * Parse a credential-free reference to a saved media-server mount.
 * The reference deliberately contains no server URL, token, password or
 * temporary stream URL.
 */
export function parseMediaServerReference(input: string): MediaServerReference | undefined {
  if (!input.startsWith('provider://') || input.length > MAX_REFERENCE_LENGTH) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return undefined;
  }
  if (!isProvider(parsed.hostname)) return undefined;
  const mountId = Number(parsed.searchParams.get('mountId'));
  if (!Number.isSafeInteger(mountId) || mountId <= 0) return undefined;
  const itemId = boundedId(parsed.searchParams.get('itemId'));
  if (!itemId) return undefined;
  const mediaSourceId = parsed.searchParams.get('mediaSourceId');
  if (mediaSourceId !== null && !boundedId(mediaSourceId)) return undefined;
  for (const key of parsed.searchParams.keys()) {
    if (!['mountId', 'itemId', 'mediaSourceId'].includes(key)) return undefined;
  }
  return { provider: parsed.hostname as MediaServerProviderId, mountId, itemId, mediaSourceId: mediaSourceId ?? undefined };
}

export function buildMediaServerReference(reference: MediaServerReference): string {
  if (!isProvider(reference.provider) || !Number.isSafeInteger(reference.mountId) || reference.mountId <= 0) {
    throw new Error('媒体服务器挂载引用无效');
  }
  if (!SAFE_ID.test(reference.itemId) || (reference.mediaSourceId !== undefined && !SAFE_ID.test(reference.mediaSourceId))) {
    throw new Error('媒体服务器条目引用无效');
  }
  const params = new URLSearchParams({
    mountId: String(reference.mountId),
    itemId: reference.itemId,
  });
  if (reference.mediaSourceId) params.set('mediaSourceId', reference.mediaSourceId);
  const output = `provider://${reference.provider}?${params.toString()}`;
  if (output.length > MAX_REFERENCE_LENGTH) throw new Error('媒体服务器引用过长');
  return output;
}

export function assertMediaServerReference(
  input: string,
  expected?: MediaServerProviderId,
): MediaServerReference {
  const reference = parseMediaServerReference(input);
  if (!reference || (expected && reference.provider !== expected)) {
    throw new Error('媒体服务器播放引用无效');
  }
  return reference;
}
