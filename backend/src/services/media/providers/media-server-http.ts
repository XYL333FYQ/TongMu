import { assertProviderActive, type ProviderContext } from './types';
import type { MediaServerProviderId } from './media-server-types';

export interface MediaServerHttpOptions {
  providerId: MediaServerProviderId;
  baseUrl: string;
  apiPrefix: string;
  token?: string;
  userId?: string;
  context: ProviderContext;
}

export class MediaServerHttpError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly code = 'MEDIA_SERVER_REQUEST_FAILED',
  ) {
    super(message);
    this.name = 'MediaServerHttpError';
  }
}

export function normalizeMediaServerUrl(raw: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim().match(/^[a-z][a-z\d+.-]*:\/\//i) ? raw.trim() : `http://${raw.trim()}`);
  } catch {
    throw new MediaServerHttpError(`${label} 服务器地址无效`, undefined, 'INVALID_URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.hash || parsed.search) {
    throw new MediaServerHttpError(`${label} 服务器地址无效`, undefined, 'INVALID_URL');
  }
  parsed.pathname = parsed.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '');
  return parsed.toString().replace(/\/$/, '');
}

function linkedSignal(context: ProviderContext, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (context.signal.aborted) controller.abort();
  else context.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      context.signal.removeEventListener('abort', abort);
    },
  };
}

function endpointUrl(options: MediaServerHttpOptions, path: string, query?: Record<string, string | number | boolean | undefined>): string {
  const prefix = options.apiPrefix.replace(/^\/+|\/+$/g, '');
  const suffix = path.replace(/^\/+/, '');
  const url = new URL(`${options.baseUrl}/${[prefix, suffix].filter(Boolean).join('/')}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function authHeaders(options: MediaServerHttpOptions, includeToken = true): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (includeToken && options.token) headers['X-Emby-Token'] = options.token;
  return headers;
}

export function mediaServerUrl(options: MediaServerHttpOptions, path: string, query?: Record<string, string | number | boolean | undefined>): string {
  return endpointUrl(options, path, query);
}

export function mediaServerAuthHeaders(options: MediaServerHttpOptions): Record<string, string> {
  return authHeaders(options);
}

export async function mediaServerRequest<T>(
  options: MediaServerHttpOptions,
  path: string,
  request: {
    method?: 'GET' | 'POST' | 'DELETE';
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
    headers?: Record<string, string>;
    includeToken?: boolean;
    responseType?: 'json' | 'text';
  } = {},
): Promise<T> {
  assertProviderActive(options.context);
  const url = endpointUrl(options, path, request.query);
  const headers = { ...authHeaders(options, request.includeToken !== false), ...request.headers };
  const remaining = Math.max(1, options.context.deadline - Date.now());
  const linked = linkedSignal(options.context, Math.min(10_000, remaining));
  try {
    const response = await options.context.safeFetch(
      url,
      {
        method: request.method ?? 'GET',
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: linked.signal,
      },
      'trusted-private',
      [new URL(options.baseUrl).hostname],
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new MediaServerHttpError(`${options.providerId} 请求失败（HTTP ${response.status}）`, response.status);
    }
    if (response.status === 204) return undefined as T;
    if (request.responseType === 'text') return await response.text() as T;
    try {
      return await response.json() as T;
    } catch {
      throw new MediaServerHttpError(`${options.providerId} 返回了无效响应`, response.status, 'INVALID_RESPONSE');
    }
  } catch (error) {
    if (error instanceof MediaServerHttpError) throw error;
    if (options.context.signal.aborted) throw new MediaServerHttpError(`${options.providerId} 请求已取消`, undefined, 'CANCELLED');
    if (Date.now() >= options.context.deadline || (error instanceof Error && error.name === 'AbortError')) {
      throw new MediaServerHttpError(`${options.providerId} 请求超时`, undefined, 'TIMEOUT');
    }
    throw new MediaServerHttpError(`${options.providerId} 服务器不可达`, undefined, 'UNREACHABLE');
  } finally {
    linked.cleanup();
  }
}

