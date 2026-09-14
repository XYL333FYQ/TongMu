import { fetchWithProxyPolicyDetailed } from '../../services/proxy/safe-fetch';
import type { Response as UndiciResponse } from 'undici';

const MAX_TEXT_BYTES = 4 * 1024 * 1024;

export interface FetchTextOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  deadline?: number;
}

export interface FetchTextResult {
  status: number;
  body: string;
  ok: boolean;
  headers: Record<string, string>;
  error?: string;
  finalUrl?: string;
}

function boundedTimeout(options: FetchTextOptions): number {
  const configured = Math.max(1, Math.min(options.timeoutMs ?? 20_000, 30_000));
  if (options.deadline === undefined) return configured;
  return Math.max(1, Math.min(configured, options.deadline - Date.now()));
}

async function readBoundedText(response: UndiciResponse, signal?: AbortSignal): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_TEXT_BYTES) throw new Error('anime response exceeds the 4MB safety limit');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal?.aborted) throw new Error('anime request cancelled');
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_TEXT_BYTES) throw new Error('anime response exceeds the 4MB safety limit');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

/** All anime/rule/catalog requests use the same SSRF-safe redirect policy. */
export async function fetchText(
  url: string,
  options: FetchTextOptions = {},
): Promise<FetchTextResult> {
  const timeoutMs = boundedTimeout(options);
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  try {
    const fetched = await fetchWithProxyPolicyDetailed(
      url,
      { method: 'GET', headers: options.headers, signal: controller.signal },
      'public-only',
    );
    const responseHeaders: Record<string, string> = {};
    for (const name of ['server', 'cf-ray', 'content-type', 'content-length']) {
      const value = fetched.response.headers.get(name);
      if (value) responseHeaders[name] = value;
    }
    const body = await readBoundedText(fetched.response, controller.signal);
    return {
      status: fetched.response.status,
      body,
      ok: fetched.response.ok,
      headers: responseHeaders,
      finalUrl: fetched.finalUrl,
    };
  } catch (error) {
    if (options.signal?.aborted) throw new Error('anime request cancelled');
    return {
      status: 0,
      body: '',
      ok: false,
      headers: {},
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abortFromCaller);
  }
}
