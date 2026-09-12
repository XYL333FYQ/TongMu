import {
  fetchWithProxyPolicy,
  fetchWithProxyPolicyDetailed,
  type ProxyTargetPolicy,
} from '../proxy/safe-fetch';
import type { MediaContainer, MediaDescriptor, MediaTransport } from './types';
import { redactMediaError } from './redact';

const MAX_PROBE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 8_000;

let activeProbes = 0;
const waiters: Array<() => void> = [];
const MAX_CONCURRENT_PROBES = 4;

async function withProbeSlot<T>(work: () => Promise<T>): Promise<T> {
  if (activeProbes >= MAX_CONCURRENT_PROBES) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  activeProbes += 1;
  try {
    return await work();
  } finally {
    activeProbes -= 1;
    waiters.shift()?.();
  }
}

export function containerFromContentType(contentType?: string | null): MediaContainer {
  const value = contentType?.toLowerCase() ?? '';
  if (value.includes('mpegurl')) return 'hls';
  if (value.includes('dash+xml')) return 'dash';
  if (value.includes('matroska')) return 'mkv';
  if (value.includes('x-msvideo') || value.includes('video/avi')) return 'avi';
  if (value.includes('x-ms-wmv') || value.includes('x-ms-asf')) return 'wmv';
  if (value.includes('webm')) return 'webm';
  if (value.includes('mp4')) return 'mp4';
  if (value.includes('quicktime')) return 'mov';
  if (value.includes('flv')) return 'flv';
  if (value.includes('mp2t')) return 'ts';
  return 'unknown';
}

export function containerFromUrl(url: string): MediaContainer {
  const pathname = (() => { try { return new URL(url).pathname.toLowerCase(); } catch { return ''; } })();
  if (/\.m3u8$/.test(pathname)) return 'hls';
  if (/\.mpd$/.test(pathname)) return 'dash';
  if (/\.(mp4|m4v)$/.test(pathname)) return 'mp4';
  if (/\.webm$/.test(pathname)) return 'webm';
  if (/\.mkv$/.test(pathname)) return 'mkv';
  if (/\.avi$/.test(pathname)) return 'avi';
  if (/\.wmv$/.test(pathname)) return 'wmv';
  if (/\.mov$/.test(pathname)) return 'mov';
  if (/\.flv$/.test(pathname)) return 'flv';
  if (/\.(ts|m2ts)$/.test(pathname)) return 'ts';
  return 'unknown';
}

export function sniffMediaMagic(bytes: Uint8Array): { container: MediaContainer; magic?: string; drm?: string[] } {
  const ascii = Buffer.from(bytes).toString('utf8');
  const trimmed = ascii.replace(/^\uFEFF/, '').trimStart();
  if (/^(?:<!doctype\s+html|<html|<head|<body)\b/i.test(trimmed)) {
    return { container: 'unknown', magic: 'HTML' };
  }
  if (trimmed.startsWith('#EXTM3U')) {
    const drmSystems = new Set<string>();
    const keyLines = trimmed.match(/^#EXT-X-(?:SESSION-)?KEY:.*$/gim) ?? [];
    for (const line of keyLines) {
      if (/METHOD=SAMPLE-AES/i.test(line) || /KEYFORMAT="?(?!identity)[^",]+/i.test(line)) {
        if (/fairplay|com\.apple\.streamingkeydelivery/i.test(line)) drmSystems.add('FairPlay');
        else if (/widevine/i.test(line)) drmSystems.add('Widevine');
        else drmSystems.add('HLS SAMPLE-AES');
      }
    }
    return { container: 'hls', magic: 'EXTM3U', drm: [...drmSystems] };
  }
  if (/<MPD(?:\s|>)/i.test(trimmed.slice(0, 8192))) {
    const systems = new Set<string>();
    if (/widevine|edef8ba9/i.test(ascii)) systems.add('Widevine');
    if (/playready|9a04f079/i.test(ascii)) systems.add('PlayReady');
    if (/fairplay|com\.apple\.fps/i.test(ascii)) systems.add('FairPlay');
    if (/ContentProtection|cenc:/i.test(ascii)) systems.add('CENC');
    return { container: 'dash', magic: 'MPD XML', drm: [...systems] };
  }
  if (bytes.length >= 8 && Buffer.from(bytes.slice(4, 8)).toString('ascii') === 'ftyp') {
    return { container: 'mp4', magic: 'ISO BMFF ftyp' };
  }
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return { container: /webm/i.test(ascii) ? 'webm' : 'mkv', magic: 'EBML' };
  }
  if (
    bytes.length >= 12 &&
    Buffer.from(bytes.slice(0, 4)).toString('ascii') === 'RIFF' &&
    Buffer.from(bytes.slice(8, 12)).toString('ascii') === 'AVI '
  ) return { container: 'avi', magic: 'RIFF AVI' };
  const asfGuid = [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c];
  if (bytes.length >= asfGuid.length && asfGuid.every((value, index) => bytes[index] === value)) {
    return { container: 'wmv', magic: 'ASF Header GUID' };
  }
  if (bytes.length >= 3 && bytes[0] === 0x46 && bytes[1] === 0x4c && bytes[2] === 0x56) {
    return { container: 'flv', magic: 'FLV' };
  }
  if (bytes.length > 376 && bytes[0] === 0x47 && bytes[188] === 0x47 && bytes[376] === 0x47) {
    return { container: 'ts', magic: 'MPEG-TS sync' };
  }
  return { container: 'unknown' };
}

function transportFor(container: MediaContainer): MediaTransport {
  if (container === 'hls') return 'hls';
  if (container === 'dash') return 'dash';
  if (container === 'flv') return 'flv';
  return 'direct';
}

async function readAtMost(response: Awaited<ReturnType<typeof fetchWithProxyPolicy>>, limit: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      const part = value.slice(0, limit - total);
      chunks.push(part);
      total += part.length;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

export interface ProbeOptions {
  headers?: Record<string, string>;
  sourceType?: string;
  resolver?: string;
  timeoutMs?: number;
  headTimeoutMs?: number;
  targetPolicy?: ProxyTargetPolicy;
  trustedPrivateHosts?: string[];
}

/** HEAD is advisory; a bounded Range GET supplies the actual format evidence. */
export async function probeMediaUrl(input: string, options: ProbeOptions = {}): Promise<MediaDescriptor> {
  return withProbeSlot(async () => {
    const warnings: string[] = [];
    let head: Awaited<ReturnType<typeof fetchWithProxyPolicy>> | undefined;
    try {
      try {
        const headController = new AbortController();
        const headTimeout = setTimeout(
          () => headController.abort(),
          options.headTimeoutMs ?? Math.min(2_500, options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        );
        try {
          head = await fetchWithProxyPolicy(input, {
            method: 'HEAD', headers: options.headers, signal: headController.signal,
          }, options.targetPolicy ?? 'public-only', options.trustedPrivateHosts);
          if (!head.ok) warnings.push(`HEAD returned ${head.status}`);
        } finally {
          clearTimeout(headTimeout);
        }
      } catch (error) {
        warnings.push(`HEAD failed: ${redactMediaError(error)}`);
      } finally {
        await head?.body?.cancel().catch(() => undefined);
      }

      const getHeaders = { ...options.headers, Range: `bytes=0-${MAX_PROBE_BYTES - 1}` };
      const getController = new AbortController();
      const getTimeout = setTimeout(() => getController.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const fetched = await fetchWithProxyPolicyDetailed(input, {
        method: 'GET', headers: getHeaders, signal: getController.signal,
      }, options.targetPolicy ?? 'public-only', options.trustedPrivateHosts);
      const response = fetched.response;
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`媒体探测失败（HTTP ${response.status}）`);
      }
      if (response.status === 200) warnings.push('上游忽略 Range；探测器已在读取上限处中止');
      const bytes = await readAtMost(response, MAX_PROBE_BYTES);
      clearTimeout(getTimeout);
      const magic = sniffMediaMagic(bytes);
      const contentType = response.headers.get('content-type') ?? head?.headers.get('content-type') ?? undefined;
      const headerContainer = containerFromContentType(contentType);
      const urlContainer = containerFromUrl(response.url || input);
      const explicitHtml = magic.magic === 'HTML' || /(?:text\/html|application\/xhtml\+xml)/i.test(contentType ?? '');
      const container = explicitHtml ? 'unknown' : magic.container !== 'unknown'
        ? magic.container
        : headerContainer !== 'unknown' ? headerContainer : urlContainer;
      const contentLengthRaw = response.headers.get('content-range')?.match(/\/(\d+)$/)?.[1]
        ?? response.headers.get('content-length')
        ?? head?.headers.get('content-length');
      const contentLength = contentLengthRaw ? Number(contentLengthRaw) : undefined;
      const rangeSupported = response.status === 206 || !!response.headers.get('content-range') ||
        (response.headers.get('accept-ranges') ?? head?.headers.get('accept-ranges'))?.toLowerCase() === 'bytes';
      const drmSystems = magic.drm ?? [];
      const mediaHeaders = Object.fromEntries(
        Object.entries(fetched.headers).filter(([name]) => name.toLowerCase() !== 'range'),
      );
      return {
        title: (() => { try { return decodeURIComponent(new URL(response.url || input).pathname.split('/').pop() || '媒体'); } catch { return '媒体'; } })(),
        sourceType: options.sourceType ?? 'url', resolver: options.resolver ?? 'direct-url',
        input, originalUrl: input, finalUrl: fetched.finalUrl || response.url || input,
        transport: transportFor(container), container, contentType,
        contentLength: Number.isFinite(contentLength) ? contentLength : undefined,
        rangeSupported, contentDisposition: response.headers.get('content-disposition') ?? undefined,
        drm: { protected: drmSystems.length > 0, systems: drmSystems.length ? drmSystems : undefined,
          reason: drmSystems.length ? 'manifest contains unsupported DRM encryption' : undefined },
        headers: mediaHeaders,
        credentialOrigins: fetched.credentialOrigins,
        probe: { method: 'range-get', bytesRead: bytes.length, magic: magic.magic, warnings },
      };
    } finally { /* each request owns an independent abort budget */ }
  });
}

export function isHtmlDescriptor(descriptor: MediaDescriptor): boolean {
  return (
    descriptor.container === 'unknown' &&
    (/(?:text\/html|application\/xhtml\+xml)/i.test(descriptor.contentType ?? '') || descriptor.probe.magic === 'HTML')
  );
}
