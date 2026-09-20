import { createHash } from 'node:crypto';
import type { Request, Response as ExpressResponse } from 'express';
import {
  parseByteRangeHeader,
  parseContentRangeHeader,
  resolveByteRange,
  type ByteRangeRequest,
  type ResolvedByteRange,
} from './byte-range';
import {
  fetchWithProxyPolicyDetailed,
  type ProxyTargetPolicy,
} from './safe-fetch';
import { metrics } from '../../observability';

/**
 * Optional, single-process byte-slice cache for already-authorized media
 * handles.  This module deliberately does not expose a route: callers must
 * pass an authorization-scoped context after resolving the media handle.
 */

export type SliceCacheLifecycle = 'vod' | 'live' | 'event' | 'unknown';

export interface SliceCacheConfig {
  enabled: boolean;
  sliceBytes: number;
  ttlMs: number;
  maxBytes: number;
  maxResources: number;
  maxSlices: number;
  maxSlicesPerResource: number;
  maxInFlight: number;
  maxRequestSlices: number;
  upstreamTimeoutMs: number;
}

export interface SliceCacheRequestContext {
  /** Stable source identity from the sealed handle, never a raw secret. */
  resourceIdentity: string;
  resourceKind?: string;
  cachePolicyHint?: 'no-store' | 'future-slice-cache';
  representationIdentity?: string;
  sourceGeneration?: number;
  /** Scope/credential owner identity, safe to include in a hash-derived key. */
  authorizationIdentity?: string;
  credentialOrigins?: string[];
  lifecycle?: SliceCacheLifecycle;
  targetPolicy: ProxyTargetPolicy;
  trustedPrivateHosts?: string[];
  store?: MemorySliceCacheStore;
}

export type ResourceValidatorKind = 'strong-etag' | 'last-modified+length' | 'length-only' | 'none';

export interface ResourceValidator {
  kind: ResourceValidatorKind;
  value?: string;
  signature: string;
}

export interface SliceCacheMetadata {
  resourceKey: string;
  validator: ResourceValidator;
  totalSize: number;
  supportsRanges: boolean;
  contentType?: string;
  etag?: string;
  lastModified?: string;
  cacheControl?: string;
  vary?: string;
  contentEncoding?: string;
  validatedAt: number;
  lastAccessed: number;
}

export interface SliceCacheStats {
  hits: number;
  misses: number;
  bypasses: number;
  evictions: number;
  singleFlightJoins: number;
  bytesServed: number;
}

export interface SliceCacheEligibility {
  eligible: boolean;
  reason?: string;
}

interface StoredSlice {
  resourceKey: string;
  index: number;
  validatorSignature: string;
  data: Buffer;
  insertedAt: number;
  lastAccessed: number;
  expiresAt: number;
}

interface SharedFlight<T> {
  controller: AbortController;
  waiters: number;
  settled: boolean;
  promise: Promise<T>;
}

const DEFAULT_SLICE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_RESOURCES = 256;
const DEFAULT_MAX_SLICES = 4_096;
const DEFAULT_MAX_IN_FLIGHT = 64;
const DEFAULT_MAX_REQUEST_SLICES = 128;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;
const MAX_SLICE_BYTES = 16 * 1024 * 1024;
const MAX_CACHE_BYTES = 2 * 1024 * 1024 * 1024;

function positiveInteger(raw: string | undefined, fallback: number, max: number): number {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, max) : fallback;
}

function nonNegativeInteger(raw: string | undefined, fallback: number, max: number): number {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, max) : fallback;
}

function envBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

export function loadSliceCacheConfig(env: NodeJS.ProcessEnv = process.env): SliceCacheConfig {
  const maxSlices = positiveInteger(env.SLICE_CACHE_MAX_SLICES, DEFAULT_MAX_SLICES, 1_000_000);
  const maxBytes = positiveInteger(env.SLICE_CACHE_MAX_BYTES, DEFAULT_MAX_BYTES, MAX_CACHE_BYTES);
  return {
    // Cache is an optional optimization. Operators must opt in explicitly.
    enabled: envBoolean(env.SLICE_CACHE_ENABLED, false),
    sliceBytes: positiveInteger(env.SLICE_CACHE_SLICE_BYTES, DEFAULT_SLICE_BYTES, MAX_SLICE_BYTES),
    ttlMs: positiveInteger(env.SLICE_CACHE_TTL_MS, DEFAULT_TTL_MS, 24 * 60 * 60 * 1000),
    maxBytes,
    maxResources: positiveInteger(env.SLICE_CACHE_MAX_RESOURCES, DEFAULT_MAX_RESOURCES, 100_000),
    maxSlices,
    maxSlicesPerResource: positiveInteger(
      env.SLICE_CACHE_MAX_SLICES_PER_RESOURCE,
      Math.min(maxSlices, 256),
      maxSlices,
    ),
    maxInFlight: positiveInteger(env.SLICE_CACHE_MAX_IN_FLIGHT, DEFAULT_MAX_IN_FLIGHT, 10_000),
    maxRequestSlices: positiveInteger(env.SLICE_CACHE_MAX_REQUEST_SLICES, DEFAULT_MAX_REQUEST_SLICES, 100_000),
    upstreamTimeoutMs: positiveInteger(env.SLICE_CACHE_UPSTREAM_TIMEOUT_MS, DEFAULT_UPSTREAM_TIMEOUT_MS, 10 * 60 * 1000),
  };
}

function strongEtag(value: string | undefined): boolean {
  return !!value && !/^\s*W\//i.test(value);
}

/** Choose a whole-object validator; weak ETags are never treated as strong. */
export function resourceValidator(
  etag: string | undefined,
  lastModified: string | undefined,
  totalSize: number,
): ResourceValidator {
  if (strongEtag(etag)) {
    return { kind: 'strong-etag', value: etag, signature: `strong-etag:${etag}|length:${totalSize}` };
  }
  if (lastModified) {
    return {
      kind: 'last-modified+length',
      value: `${lastModified}|${totalSize}`,
      signature: `last-modified+length:${lastModified}|length:${totalSize}`,
    };
  }
  if (Number.isSafeInteger(totalSize) && totalSize >= 0) {
    return { kind: 'length-only', value: String(totalSize), signature: `length-only:${totalSize}` };
  }
  return { kind: 'none', signature: 'none' };
}

function isExpired(entry: StoredSlice, now = Date.now()): boolean {
  return entry.expiresAt <= now;
}

function cloneStats(stats: SliceCacheStats): SliceCacheStats {
  return { ...stats };
}

function abortError(): Error {
  const error = new Error('媒体缓存请求已取消');
  error.name = 'AbortError';
  return error;
}

/** A bounded LRU memory store. It contains bytes only; no disk/Redis daemon. */
export class MemorySliceCacheStore {
  readonly config: SliceCacheConfig;
  private readonly slices = new Map<string, StoredSlice>();
  private readonly metadata = new Map<string, SliceCacheMetadata>();
  private readonly sliceFlights = new Map<string, SharedFlight<StoredSliceResult>>();
  private readonly metadataFlights = new Map<string, SharedFlight<SliceCacheMetadata>>();
  private bytes = 0;
  private stats: SliceCacheStats = {
    hits: 0,
    misses: 0,
    bypasses: 0,
    evictions: 0,
    singleFlightJoins: 0,
    bytesServed: 0,
  };

  constructor(config: Partial<SliceCacheConfig> = {}) {
    const defaults = loadSliceCacheConfig();
    this.config = {
      ...defaults,
      ...config,
      sliceBytes: Math.min(config.sliceBytes ?? defaults.sliceBytes, MAX_SLICE_BYTES),
      maxBytes: Math.min(config.maxBytes ?? defaults.maxBytes, MAX_CACHE_BYTES),
    };
  }

  get enabled(): boolean { return this.config.enabled; }

  get currentBytes(): number { return this.bytes; }

  get currentSliceCount(): number { return this.slices.size; }

  get currentResourceCount(): number { return this.metadata.size; }

  get inFlightCount(): number { return this.sliceFlights.size + this.metadataFlights.size; }

  getStats(): SliceCacheStats { return cloneStats(this.stats); }

  resetStats(): void {
    this.stats = { hits: 0, misses: 0, bypasses: 0, evictions: 0, singleFlightJoins: 0, bytesServed: 0 };
  }

  recordBypass(): void {
    this.stats.bypasses += 1;
    metrics.increment('slice_cache_total', { outcome: 'bypass' });
  }

  recordBytesServed(bytes: number): void {
    if (Number.isSafeInteger(bytes) && bytes > 0) this.stats.bytesServed += bytes;
  }

  getMetadata(resourceKey: string, freshOnly = false): SliceCacheMetadata | undefined {
    const value = this.metadata.get(resourceKey);
    if (!value) return undefined;
    if (freshOnly && Date.now() - value.validatedAt > this.config.ttlMs) return undefined;
    value.lastAccessed = Date.now();
    this.metadata.delete(resourceKey);
    this.metadata.set(resourceKey, value);
    return { ...value, validator: { ...value.validator } };
  }

  touchMetadata(resourceKey: string): SliceCacheMetadata | undefined {
    const value = this.metadata.get(resourceKey);
    if (!value) return undefined;
    value.validatedAt = Date.now();
    value.lastAccessed = value.validatedAt;
    this.metadata.delete(resourceKey);
    this.metadata.set(resourceKey, value);
    return { ...value, validator: { ...value.validator } };
  }

  /** Replace metadata and purge every slice when the object version changes. */
  setMetadata(next: SliceCacheMetadata): SliceCacheMetadata {
    const previous = this.metadata.get(next.resourceKey);
    if (previous && (
      previous.validator.signature !== next.validator.signature ||
      previous.totalSize !== next.totalSize
    )) {
      this.invalidateResource(next.resourceKey);
    }
    if (!previous && this.metadata.size >= this.config.maxResources) this.evictOldestResource();
    const value = { ...next, lastAccessed: Date.now(), validator: { ...next.validator } };
    this.metadata.delete(next.resourceKey);
    this.metadata.set(next.resourceKey, value);
    this.evictToBounds();
    return { ...value, validator: { ...value.validator } };
  }

  getSlice(resourceKey: string, validatorSignature: string, index: number): Buffer | undefined {
    const key = this.sliceKey(resourceKey, validatorSignature, index);
    const entry = this.slices.get(key);
    if (!entry) {
      this.stats.misses += 1;
      metrics.increment('slice_cache_total', { outcome: 'miss' });
      return undefined;
    }
    if (isExpired(entry)) {
      this.removeSlice(key, true);
      this.stats.misses += 1;
      metrics.increment('slice_cache_total', { outcome: 'miss' });
      return undefined;
    }
    entry.lastAccessed = Date.now();
    this.slices.delete(key);
    this.slices.set(key, entry);
    this.stats.hits += 1;
    metrics.increment('slice_cache_total', { outcome: 'hit' });
    return Buffer.from(entry.data);
  }

  putSlice(resourceKey: string, validatorSignature: string, index: number, data: Buffer): boolean {
    if (!data.length || data.length > this.config.sliceBytes || data.length > this.config.maxBytes) return false;
    const metadata = this.metadata.get(resourceKey);
    if (!metadata || metadata.validator.signature !== validatorSignature) return false;
    const now = Date.now();
    const key = this.sliceKey(resourceKey, validatorSignature, index);
    const old = this.slices.get(key);
    if (old) this.removeSlice(key, false);
    const entry: StoredSlice = {
      resourceKey,
      index,
      validatorSignature,
      data: Buffer.from(data),
      insertedAt: now,
      lastAccessed: now,
      expiresAt: now + this.config.ttlMs,
    };
    this.slices.set(key, entry);
    this.bytes += entry.data.length;
    this.evictPerResource(resourceKey);
    this.evictToBounds();
    return this.slices.has(key);
  }

  invalidateResource(resourceKey: string): void {
    for (const [key, entry] of this.slices) {
      if (entry.resourceKey === resourceKey) this.removeSlice(key, true);
    }
    this.metadata.delete(resourceKey);
  }

  clear(): void {
    this.slices.clear();
    this.metadata.clear();
    this.bytes = 0;
    this.sliceFlights.clear();
    this.metadataFlights.clear();
  }

  /** Run one shared operation. Caller cancellation never rejects the shared promise. */
  async getOrFetchSlice(
    resourceKey: string,
    index: number,
    callerSignal: AbortSignal | undefined,
    fetcher: (signal: AbortSignal) => Promise<StoredSliceResult>,
  ): Promise<StoredSliceResult> {
    const existing = this.sliceFlights.get(this.flightKey(resourceKey, index));
    if (existing) {
      this.stats.singleFlightJoins += 1;
      return this.awaitShared(existing, callerSignal);
    }
    if (this.inFlightCount >= this.config.maxInFlight) throw new Error('媒体缓存并发上限已达到');
    const key = this.flightKey(resourceKey, index);
    const controller = new AbortController();
    const flight = {} as SharedFlight<StoredSliceResult>;
    flight.controller = controller;
    flight.waiters = 0;
    flight.settled = false;
    flight.promise = fetcher(controller.signal).finally(() => {
      flight.settled = true;
      if (this.sliceFlights.get(key) === flight) this.sliceFlights.delete(key);
    });
    // If every waiter disconnects, this catch prevents an unhandled rejection
    // while the shared fetch is being cancelled and its map entry is cleaned.
    flight.promise.catch(() => undefined);
    this.sliceFlights.set(key, flight);
    return this.awaitShared(flight, callerSignal);
  }

  async getOrFetchMetadata(
    resourceKey: string,
    callerSignal: AbortSignal | undefined,
    fetcher: (signal: AbortSignal) => Promise<SliceCacheMetadata>,
  ): Promise<SliceCacheMetadata> {
    const existing = this.metadataFlights.get(resourceKey);
    if (existing) {
      this.stats.singleFlightJoins += 1;
      return this.awaitShared(existing, callerSignal);
    }
    if (this.inFlightCount >= this.config.maxInFlight) throw new Error('媒体缓存并发上限已达到');
    const controller = new AbortController();
    const flight = {} as SharedFlight<SliceCacheMetadata>;
    flight.controller = controller;
    flight.waiters = 0;
    flight.settled = false;
    flight.promise = fetcher(controller.signal).finally(() => {
      flight.settled = true;
      if (this.metadataFlights.get(resourceKey) === flight) this.metadataFlights.delete(resourceKey);
    });
    flight.promise.catch(() => undefined);
    this.metadataFlights.set(resourceKey, flight);
    return this.awaitShared(flight, callerSignal);
  }

  private async awaitShared<T>(flight: SharedFlight<T>, signal: AbortSignal | undefined): Promise<T> {
    if (signal?.aborted) throw abortError();
    flight.waiters += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      flight.waiters -= 1;
      if (flight.waiters === 0 && !flight.settled) flight.controller.abort();
    };
    try {
      return await new Promise<T>((resolve, reject) => {
        let done = false;
        const finish = (callback: () => void) => {
          if (done) return;
          done = true;
          signal?.removeEventListener('abort', onAbort);
          callback();
        };
        const onAbort = () => finish(() => reject(abortError()));
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        flight.promise.then(
          (value) => finish(() => resolve(value)),
          (error: unknown) => finish(() => reject(error)),
        );
      });
    } finally {
      release();
    }
  }

  private sliceKey(resourceKey: string, validatorSignature: string, index: number): string {
    return `${resourceKey}\u0000${validatorSignature}\u0000${index}`;
  }

  private flightKey(resourceKey: string, index: number): string {
    return `${resourceKey}\u0000${index}`;
  }

  private removeSlice(key: string, countEviction: boolean): void {
    const entry = this.slices.get(key);
    if (!entry) return;
    this.slices.delete(key);
    this.bytes -= entry.data.length;
    if (countEviction) this.stats.evictions += 1;
  }

  private evictOldestResource(): void {
    const oldest = [...this.metadata.values()].sort((a, b) => a.lastAccessed - b.lastAccessed)[0];
    if (oldest) this.invalidateResource(oldest.resourceKey);
  }

  private evictPerResource(resourceKey: string): void {
    const entries = [...this.slices.entries()]
      .filter(([, value]) => value.resourceKey === resourceKey)
      .sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);
    while (entries.length > this.config.maxSlicesPerResource) {
      const oldest = entries.shift();
      if (oldest) this.removeSlice(oldest[0], true);
    }
  }

  private evictToBounds(): void {
    for (const [key, entry] of [...this.slices]) {
      if (isExpired(entry)) this.removeSlice(key, true);
    }
    while (this.bytes > this.config.maxBytes || this.slices.size > this.config.maxSlices) {
      const oldest = this.slices.keys().next().value as string | undefined;
      if (!oldest) break;
      this.removeSlice(oldest, true);
    }
    while (this.metadata.size > this.config.maxResources) this.evictOldestResource();
  }
}

interface StoredSliceResult {
  data: Buffer;
  start: number;
  end: number;
  total: number;
  metadata: SliceCacheMetadata;
}

const globalSliceCache = new MemorySliceCacheStore();

export function getGlobalSliceCache(): MemorySliceCacheStore {
  return globalSliceCache;
}

function headerValue(headers: Headers, name: string): string | undefined {
  const value = headers.get(name);
  return value === null ? undefined : value;
}

function contentLength(headers: Headers): number | undefined {
  const value = headerValue(headers, 'content-length');
  if (!value || !/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function responseMetadata(
  resourceKey: string,
  headers: Headers,
  totalSize: number,
  supportsRanges: boolean,
): SliceCacheMetadata {
  const etag = headerValue(headers, 'etag');
  const lastModified = headerValue(headers, 'last-modified');
  return {
    resourceKey,
    validator: resourceValidator(etag, lastModified, totalSize),
    totalSize,
    supportsRanges,
    contentType: headerValue(headers, 'content-type'),
    etag,
    lastModified,
    cacheControl: headerValue(headers, 'cache-control'),
    vary: headerValue(headers, 'vary'),
    contentEncoding: headerValue(headers, 'content-encoding'),
    validatedAt: Date.now(),
    lastAccessed: Date.now(),
  };
}

function hasNoStore(value: string | undefined): boolean {
  return !!value && /(?:^|,)\s*no-store\s*(?:,|$)/i.test(value);
}

function cacheHeadersSafe(metadata: SliceCacheMetadata): boolean {
  if (hasNoStore(metadata.cacheControl)) return false;
  // A Vary response may depend on a request header not represented by this
  // conservative key. Bypass rather than guess, especially for auth/cookies.
  if (metadata.vary?.trim()) return false;
  if (metadata.contentEncoding && !/^identity$/i.test(metadata.contentEncoding.trim())) return false;
  return metadata.validator.kind !== 'none';
}

function cacheKindAllowed(kind: string | undefined): boolean {
  return !kind || new Set(['media', 'hls-segment', 'dash-media', 'dash-base']).has(kind);
}

function conditionalRequest(req: Request): boolean {
  return ['if-none-match', 'if-modified-since', 'if-match', 'if-unmodified-since', 'if-range']
    .some((name) => Boolean(req.headers[name]));
}

export function assessSliceCacheEligibility(
  req: Request,
  context: SliceCacheRequestContext,
  store: MemorySliceCacheStore,
): SliceCacheEligibility {
  if (!store.enabled) return { eligible: false, reason: 'disabled' };
  if (req.method.toUpperCase() !== 'GET') return { eligible: false, reason: 'method' };
  if (context.cachePolicyHint !== 'future-slice-cache') return { eligible: false, reason: 'policy-hint' };
  if (!cacheKindAllowed(context.resourceKind)) return { eligible: false, reason: 'resource-kind' };
  if (context.lifecycle === 'live' || context.lifecycle === 'event' || context.lifecycle === 'unknown') {
    return { eligible: false, reason: 'live-or-unknown-lifecycle' };
  }
  if (conditionalRequest(req)) return { eligible: false, reason: 'conditional-request' };
  const parsed = parseByteRangeHeader(req.headers.range);
  if (parsed?.kind === 'invalid') return { eligible: false, reason: 'invalid-range' };
  if (parsed?.kind === 'multi') return { eligible: false, reason: 'multi-range' };
  if (context.authorizationIdentity === undefined || !context.authorizationIdentity) {
    return { eligible: false, reason: 'missing-authorization-partition' };
  }
  return { eligible: true };
}

function cacheKey(reqUrl: string, context: SliceCacheRequestContext): string {
  const headers = contextHeadersForKey(context);
  const canonical = [
    'tongmu-slice-v1',
    context.resourceIdentity,
    reqUrl,
    context.resourceKind ?? 'media',
    context.representationIdentity ?? '',
    String(context.sourceGeneration ?? ''),
    context.authorizationIdentity ?? '',
    (context.credentialOrigins ?? []).slice().sort().join(','),
    ...Object.entries(headers).sort(([a], [b]) => a.localeCompare(b)).flat(),
  ].join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

function contextHeadersForKey(context: SliceCacheRequestContext): Record<string, string> {
  // The actual request headers are included by tryServeSliceCache. This
  // context-only helper keeps the identity domain explicit for future callers.
  return {
    targetPolicy: context.targetPolicy,
    trustedPrivateHosts: (context.trustedPrivateHosts ?? []).slice().sort().join(','),
  };
}

function omitCacheControlHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => ![
    'range', 'if-none-match', 'if-modified-since', 'if-match', 'if-unmodified-since', 'if-range',
  ].includes(name.toLowerCase())));
}

async function fetchWithTimeout(
  url: string,
  init: { method: string; headers: Record<string, string>; signal: AbortSignal },
  context: SliceCacheRequestContext,
  timeoutMs: number,
): Promise<Awaited<ReturnType<typeof fetchWithProxyPolicyDetailed>>> {
  const controller = new AbortController();
  const relayAbort = () => controller.abort();
  if (init.signal.aborted) controller.abort();
  else init.signal.addEventListener('abort', relayAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchWithProxyPolicyDetailed(
      url,
      { method: init.method, headers: init.headers, signal: controller.signal },
      context.targetPolicy,
      context.trustedPrivateHosts,
    );
  } finally {
    clearTimeout(timeout);
    init.signal.removeEventListener('abort', relayAbort);
  }
}

async function cancelResponse(
  response: Awaited<ReturnType<typeof fetchWithProxyPolicyDetailed>>['response'],
): Promise<void> {
  try { await response.body?.cancel?.(); } catch { /* best effort */ }
}

async function readBoundedBody(response: Awaited<ReturnType<typeof fetchWithProxyPolicyDetailed>>['response'], maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error('媒体缓存响应超出切片上限');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks, total);
}

function metadataFromHead(
  resourceKey: string,
  response: Awaited<ReturnType<typeof fetchWithProxyPolicyDetailed>>['response'],
): SliceCacheMetadata | undefined {
  const range = parseContentRangeHeader(response.headers.get('content-range'));
  const total = range?.total ?? contentLength(response.headers);
  if (total === undefined) return undefined;
  return responseMetadata(
    resourceKey,
    response.headers,
    total,
    response.status === 206 || /^bytes$/i.test(response.headers.get('accept-ranges') ?? ''),
  );
}

async function discoverMetadata(
  resourceKey: string,
  url: string,
  context: SliceCacheRequestContext,
  baseHeaders: Record<string, string>,
  store: MemorySliceCacheStore,
  signal: AbortSignal,
): Promise<SliceCacheMetadata> {
  const previous = store.getMetadata(resourceKey);
  const headers = omitCacheControlHeaders(baseHeaders);
  if (previous?.etag) headers['If-None-Match'] = previous.etag;
  if (previous?.lastModified) headers['If-Modified-Since'] = previous.lastModified;
  const head = await fetchWithTimeout(url, { method: 'HEAD', headers, signal }, context, store.config.upstreamTimeoutMs);
  if (head.response.status === 304 && previous) {
    await cancelResponse(head.response);
    const refreshed = store.touchMetadata(resourceKey);
    if (refreshed) return refreshed;
  }
  if (head.response.ok) {
    const candidate = metadataFromHead(resourceKey, head.response);
    await cancelResponse(head.response);
    if (candidate && cacheHeadersSafe(candidate) && candidate.supportsRanges) return store.setMetadata(candidate);
    if (candidate && !cacheHeadersSafe(candidate)) store.invalidateResource(resourceKey);
  } else {
    await cancelResponse(head.response);
  }

  // HEAD is advisory. One bounded 0-0 probe is the only fallback; a 200
  // proves a complete response but does not prove range support, so it is not
  // admitted to the slice cache.
  const probeHeaders = { ...omitCacheControlHeaders(baseHeaders), Range: 'bytes=0-0' };
  const probe = await fetchWithTimeout(url, { method: 'GET', headers: probeHeaders, signal }, context, store.config.upstreamTimeoutMs);
  if (probe.response.status === 206) {
    const parsed = parseContentRangeHeader(probe.response.headers.get('content-range'));
    const declared = contentLength(probe.response.headers);
    const expected = parsed ? parsed.end - parsed.start + 1 : undefined;
    if (!parsed || parsed.start !== 0 || parsed.total <= 0 || (declared !== undefined && declared !== expected)) {
      await cancelResponse(probe.response);
      throw new Error('上游 0-0 探测返回了无效 Content-Range');
    }
    const body = await readBoundedBody(probe.response, 1);
    if (body.length !== expected) throw new Error('上游 0-0 探测 body 长度不一致');
    const candidate = responseMetadata(resourceKey, probe.response.headers, parsed.total, true);
    if (!cacheHeadersSafe(candidate)) {
      store.invalidateResource(resourceKey);
      throw new Error('上游响应不满足切片缓存策略');
    }
    return store.setMetadata(candidate);
  }
  if (probe.response.status === 200) {
    await cancelResponse(probe.response);
    throw new Error('上游不支持 Range，切片缓存旁路');
  }
  const status = probe.response.status;
  await cancelResponse(probe.response);
  throw new Error(`上游元数据探测失败: ${status}`);
}

async function fetchSlice(
  resourceKey: string,
  url: string,
  context: SliceCacheRequestContext,
  baseHeaders: Record<string, string>,
  store: MemorySliceCacheStore,
  index: number,
  signal: AbortSignal,
): Promise<StoredSliceResult> {
  const start = index * store.config.sliceBytes;
  const requestedEnd = start + store.config.sliceBytes - 1;
  const headers = { ...omitCacheControlHeaders(baseHeaders), Range: `bytes=${start}-${requestedEnd}` };
  const fetched = await fetchWithTimeout(url, { method: 'GET', headers, signal }, context, store.config.upstreamTimeoutMs);
  const response = fetched.response;
  if (response.status !== 206) {
    await cancelResponse(response);
    if (response.status === 200) throw new Error('上游忽略切片 Range，拒绝把完整 body 当作切片');
    if (response.status === 416) throw new Error('上游切片 Range 不可满足');
    throw new Error(`上游切片请求失败: ${response.status}`);
  }
  const range = parseContentRangeHeader(response.headers.get('content-range'));
  if (!range || range.start !== start || range.total <= start) {
    await cancelResponse(response);
    throw new Error('上游切片 Content-Range 无效');
  }
  const expectedEnd = Math.min(requestedEnd, range.total - 1);
  if (range.end !== expectedEnd) {
    await cancelResponse(response);
    throw new Error('上游切片 Content-Range 与请求不一致');
  }
  const expectedLength = range.end - range.start + 1;
  const declared = contentLength(response.headers);
  if (declared !== undefined && declared !== expectedLength) {
    await cancelResponse(response);
    throw new Error('上游切片 Content-Length 与 Content-Range 不一致');
  }
  const data = await readBoundedBody(response, Math.min(store.config.sliceBytes, expectedLength));
  if (data.length !== expectedLength) throw new Error('上游切片 body 长度不一致');
  const candidate = responseMetadata(resourceKey, response.headers, range.total, true);
  if (!cacheHeadersSafe(candidate)) {
    store.invalidateResource(resourceKey);
    throw new Error('上游响应不满足切片缓存策略');
  }
  const metadata = store.setMetadata(candidate);
  if (metadata.validator.kind === 'none') throw new Error('上游没有可靠 validator');
  store.putSlice(resourceKey, metadata.validator.signature, index, data);
  return { data, start: range.start, end: range.end, total: range.total, metadata };
}

function resourceKeyFor(
  url: string,
  context: SliceCacheRequestContext,
  baseHeaders: Record<string, string>,
): string {
  const keyContext = {
    ...context,
    // Include the effective upstream request headers, but never expose the
    // raw values: the final cache identity is a SHA-256 digest.
  };
  const canonical = [
    cacheKey(url, keyContext),
    ...Object.entries(omitCacheControlHeaders(baseHeaders))
      .sort(([a], [b]) => a.localeCompare(b))
      .flat(),
  ].join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

function cropSlice(data: Buffer, sliceStart: number, range: ResolvedByteRange): Buffer {
  const from = Math.max(range.start, sliceStart) - sliceStart;
  const to = Math.min(range.end, sliceStart + data.length - 1) - sliceStart + 1;
  if (from < 0 || to > data.length || from >= to) throw new Error('缓存切片裁剪范围无效');
  return data.subarray(from, to);
}

function rangeFromParsed(parsed: ByteRangeRequest | null, total: number): ResolvedByteRange | 'multi' | 'invalid' | null {
  if (!parsed) return null;
  const resolved = resolveByteRange(parsed, total);
  if (resolved.kind === 'single') return resolved.range;
  if (resolved.kind === 'multi') return 'multi';
  return resolved.kind === 'invalid' ? 'invalid' : 'invalid';
}

function wildcardCors(res: ExpressResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
}

async function writeWithBackpressure(res: ExpressResponse, data: Buffer, signal: AbortSignal): Promise<void> {
  if (!data.length) return;
  if (signal.aborted) throw abortError();
  if (res.write(data)) return;
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(abortError()); };
    const onDrain = () => { cleanup(); resolve(); };
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
      res.off('drain', onDrain);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    res.once('drain', onDrain);
  });
}

function responseContentType(value: string | undefined, fallback: string): string {
  if (value && !/application\/json/i.test(value)) return value;
  return fallback;
}

function setCachedHeaders(
  res: ExpressResponse,
  metadata: SliceCacheMetadata,
  range: ResolvedByteRange | null,
  defaultContentType: string,
  cors: 'wildcard' | 'global',
  cacheControl?: string,
): void {
  if (cors === 'wildcard') wildcardCors(res);
  res.setHeader('Content-Type', responseContentType(metadata.contentType, defaultContentType));
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Length', String(range ? range.length : metadata.totalSize));
  if (metadata.etag) res.setHeader('ETag', metadata.etag);
  if (metadata.lastModified) res.setHeader('Last-Modified', metadata.lastModified);
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('X-Proxy-Buffering', 'no');
  res.setHeader('Cache-Control', cacheControl ? `${cacheControl}, no-transform` : 'no-transform');
  if (range) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${range.total}`);
  } else {
    res.status(200);
  }
}

/**
 * Try the cache after route-level authorization. `false` means the caller
 * should execute the ordinary uncached proxy path. If a response has already
 * started and a later slice fails, the response is terminated rather than
 * falling through and appending a different upstream object version.
 */
export async function tryServeSliceCache(
  req: Request,
  res: ExpressResponse,
  options: {
    url: string;
    context: SliceCacheRequestContext;
    headers: Record<string, string>;
    defaultContentType: string;
    cors: 'wildcard' | 'global';
    cacheControl?: string;
    logTag: string;
  },
): Promise<boolean> {
  const store = options.context.store ?? globalSliceCache;
  const eligibility = assessSliceCacheEligibility(req, options.context, store);
  if (!eligibility.eligible) {
    store.recordBypass();
    return false;
  }

  const parsed = parseByteRangeHeader(req.headers.range);
  const baseHeaders = omitCacheControlHeaders(options.headers);
  const resourceKey = resourceKeyFor(options.url, options.context, baseHeaders);
  const caller = new AbortController();
  const abortCaller = () => caller.abort();
  req.once('aborted', abortCaller);
  res.once('close', abortCaller);
  let responseStarted = false;
  try {
    let metadata = store.getMetadata(resourceKey, true);
    let first: StoredSliceResult | undefined;
    if (!metadata && parsed && parsed.kind !== 'multi' && parsed.kind !== 'invalid' && parsed.kind === 'explicit') {
      const firstIndex = Math.floor(parsed.start / store.config.sliceBytes);
      first = await store.getOrFetchSlice(resourceKey, firstIndex, caller.signal, (signal) =>
        fetchSlice(resourceKey, options.url, options.context, baseHeaders, store, firstIndex, signal));
      metadata = first.metadata;
    }
    if (!metadata) {
      metadata = await store.getOrFetchMetadata(resourceKey, caller.signal, (signal) =>
        discoverMetadata(resourceKey, options.url, options.context, baseHeaders, store, signal));
    }
    if (!metadata.supportsRanges || !cacheHeadersSafe(metadata)) return false;

    const requested = rangeFromParsed(parsed, metadata.totalSize);
    if (requested === 'multi' || requested === 'invalid') return false;
    const sliceStart = requested ? Math.floor(requested.start / store.config.sliceBytes) : 0;
    const sliceEnd = requested
      ? Math.floor(requested.end / store.config.sliceBytes)
      : Math.ceil(metadata.totalSize / store.config.sliceBytes) - 1;
    const sliceCount = sliceEnd >= sliceStart ? sliceEnd - sliceStart + 1 : 0;
    if (!sliceCount || sliceCount > store.config.maxRequestSlices) return false;

    const version = metadata.validator.signature;
    const slices: Array<{ index: number; data?: Buffer; result?: StoredSliceResult }> = [];
    for (let index = sliceStart; index <= sliceEnd; index += 1) {
      if (first && index === Math.floor((parsed as { start: number }).start / store.config.sliceBytes)) {
        if (first.metadata.validator.signature !== version) throw new Error('缓存 validator 在请求内发生变化');
        slices.push({ index, result: first });
        first = undefined;
        continue;
      }
      const cached = store.getSlice(resourceKey, version, index);
      if (cached) slices.push({ index, data: cached });
      else {
        const result = await store.getOrFetchSlice(resourceKey, index, caller.signal, (signal) =>
          fetchSlice(resourceKey, options.url, options.context, baseHeaders, store, index, signal));
        if (result.metadata.validator.signature !== version) throw new Error('缓存 validator 在请求内发生变化');
        slices.push({ index, result });
      }
    }

    const responseRange = requested;
    setCachedHeaders(res, metadata, responseRange, options.defaultContentType, options.cors, options.cacheControl);
    responseStarted = true;
    for (const item of slices) {
      if (caller.signal.aborted) throw abortError();
      const data = item.data ?? item.result?.data;
      if (!data) throw new Error('缓存切片缺失');
      const start = item.index * store.config.sliceBytes;
      const output = responseRange ? cropSlice(data, start, responseRange) : data;
      await writeWithBackpressure(res, output, caller.signal);
      store.recordBytesServed(output.length);
    }
    res.end();
    return true;
  } catch (error) {
    metrics.increment('slice_cache_total', { outcome: 'error' });
    if (responseStarted || res.headersSent) {
      console.warn(`[${options.logTag}] slice cache response stopped: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.writableEnded) res.destroy();
      return true;
    }
    // Cache errors, including invalid upstream protocol responses, fall back
    // to the existing proxy. That path performs the authoritative 200/206/416
    // validation and therefore never turns invalid bytes into a valid cache hit.
    if (error instanceof Error && error.name !== 'AbortError') {
      console.warn(`[${options.logTag}] slice cache bypass: ${error.message}`);
    }
    return false;
  } finally {
    req.off('aborted', abortCaller);
    res.off('close', abortCaller);
  }
}
