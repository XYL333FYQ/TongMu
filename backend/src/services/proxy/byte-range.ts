/**
 * The single Range grammar used by local files, WebDAV/FTP and HTTP proxies.
 * Parsing deliberately keeps suffix/open-ended requests unresolved until the
 * representation size is known.
 */

export type ByteRangeRequest =
  | { kind: 'explicit'; start: number; end: number }
  | { kind: 'open-ended'; start: number }
  | { kind: 'suffix'; length: number }
  | { kind: 'multi'; ranges: Array<Exclude<ByteRangeRequest, { kind: 'multi' | 'invalid' }>> }
  | { kind: 'invalid'; reason: 'malformed' | 'overflow' };

export interface ResolvedByteRange {
  start: number;
  end: number;
  total: number;
  length: number;
}

export type ByteRangeResolution =
  | { kind: 'single'; range: ResolvedByteRange }
  | { kind: 'multi'; ranges: ResolvedByteRange[]; total: number }
  | { kind: 'unsatisfiable'; total: number }
  | { kind: 'invalid'; reason: 'malformed' | 'overflow' };

export interface ParsedContentRange {
  start: number;
  end: number;
  total: number;
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function parseSafeNumber(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  try {
    const value = BigInt(raw);
    return value <= MAX_SAFE ? Number(value) : null;
  } catch {
    return null;
  }
}

function headerText(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join(',') : value;
}

/** Parse only the header grammar; no total-size-dependent clamping happens here. */
export function parseByteRangeHeader(
  rangeHeader: string | string[] | undefined,
): ByteRangeRequest | null {
  const rawHeader = headerText(rangeHeader);
  if (rawHeader === undefined || !rawHeader.trim()) return null;
  const match = /^\s*bytes\s*=\s*(.*?)\s*$/i.exec(rawHeader);
  if (!match) return { kind: 'invalid', reason: 'malformed' };

  const parts = match[1].split(',').map((part) => part.trim());
  if (parts.length === 0 || parts.some((part) => !part)) {
    return { kind: 'invalid', reason: 'malformed' };
  }

  const parsed = parts.map((part) => {
    const range = /^([0-9]*)\s*-\s*([0-9]*)$/.exec(part);
    if (!range || (!range[1] && !range[2])) return null;
    const start = range[1] ? parseSafeNumber(range[1]) : null;
    const end = range[2] ? parseSafeNumber(range[2]) : null;
    if ((range[1] && start === null) || (range[2] && end === null)) return null;
    if (!range[1]) return { kind: 'suffix' as const, length: end as number };
    if (!range[2]) return { kind: 'open-ended' as const, start: start as number };
    return { kind: 'explicit' as const, start: start as number, end: end as number };
  });
  if (parsed.some((range) => range === null)) {
    const hasOverflow = parts.some((part) => {
      const range = /^([0-9]*)\s*-\s*([0-9]*)$/.exec(part);
      return !!range && ((!!range[1] && parseSafeNumber(range[1]) === null) || (!!range[2] && parseSafeNumber(range[2]) === null));
    });
    return { kind: 'invalid', reason: hasOverflow ? 'overflow' : 'malformed' };
  }
  const ranges = parsed as Array<Exclude<ByteRangeRequest, { kind: 'multi' | 'invalid' }>>;
  return ranges.length === 1 ? ranges[0] : { kind: 'multi', ranges };
}

function resolveSingle(
  request: Exclude<ByteRangeRequest, { kind: 'multi' | 'invalid' }>,
  total: number,
): ResolvedByteRange | null {
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new RangeError('total must be a non-negative safe integer');
  }
  if (total === 0) return null;
  if (request.kind === 'suffix') {
    if (request.length <= 0) return null;
    const start = Math.max(0, total - request.length);
    return { start, end: total - 1, total, length: total - start };
  }
  if (request.kind === 'open-ended') {
    if (request.start >= total) return null;
    return { start: request.start, end: total - 1, total, length: total - request.start };
  }
  if (request.start >= total || request.end < request.start) return null;
  const end = Math.min(request.end, total - 1);
  return { start: request.start, end, total, length: end - request.start + 1 };
}

/** Resolve a parsed request against the known representation size. */
export function resolveByteRange(
  request: ByteRangeRequest,
  total: number,
): ByteRangeResolution {
  if (request.kind === 'invalid') return request;
  if (request.kind === 'multi') {
    const ranges = request.ranges
      .map((range) => resolveSingle(range, total))
      .filter((range): range is ResolvedByteRange => range !== null);
    return ranges.length > 0
      ? { kind: 'multi', ranges, total }
      : { kind: 'unsatisfiable', total };
  }
  const range = resolveSingle(request, total);
  return range ? { kind: 'single', range } : { kind: 'unsatisfiable', total };
}

/** Parse a 206 Content-Range header and validate its bounds. */
export function parseContentRangeHeader(value: string | null | undefined): ParsedContentRange | null {
  if (!value) return null;
  const match = /^\s*bytes\s+(\d+)\s*-\s*(\d+)\s*\/\s*(\d+)\s*$/i.exec(value);
  if (!match) return null;
  const start = parseSafeNumber(match[1]);
  const end = parseSafeNumber(match[2]);
  const total = parseSafeNumber(match[3]);
  if (start === null || end === null || total === null || start > end || end >= total) return null;
  return { start, end, total };
}

export function formatContentRange(range: ResolvedByteRange): string {
  return `bytes ${range.start}-${range.end}/${range.total}`;
}
