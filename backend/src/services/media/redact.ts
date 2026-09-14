const MEDIA_HANDLE_PREFIX = '/api/stream/media/';
const MAX_SAFE_PATH_LENGTH = 120;

function parseMediaUrl(raw: string): { parsed: URL; relative: boolean } | null {
  try {
    return { parsed: new URL(raw), relative: false };
  } catch {
    if (!raw.startsWith('/')) return null;
    try {
      return { parsed: new URL(raw, 'http://redacted.invalid'), relative: true };
    } catch {
      return null;
    }
  }
}

function safePathname(pathname: string): string {
  const normalized = pathname.replace(/\/{2,}/g, '/') || '/';
  if (normalized.startsWith(MEDIA_HANDLE_PREFIX)) {
    return '/api/stream/media/<redacted>';
  }
  if (normalized.length <= MAX_SAFE_PATH_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_SAFE_PATH_LENGTH - 1)}…`;
}

/**
 * Return a diagnostic-safe URL summary. Query, fragment, userinfo and media
 * handle capabilities are deliberately never included in the result.
 */
export function redactMediaUrl(value: unknown): string {
  if (typeof value !== 'string') return '[redacted]';
  const raw = value.trim();
  if (!raw) return '[empty-url]';
  const result = parseMediaUrl(raw);
  if (!result) return '[invalid-url]';
  const path = safePathname(result.parsed.pathname);
  if (result.relative) return path;
  if (!/^https?:$/.test(result.parsed.protocol) || !result.parsed.hostname) {
    return `${result.parsed.protocol || 'url:'}//<redacted>`;
  }
  return `${result.parsed.protocol}//${result.parsed.host}${path}`;
}

// Match both header-style keys (`access-token`) and JavaScript-style keys
// (`accessToken`).  Secret-bearing metadata can be nested in provider errors,
// so a false positive is safer than allowing one token-shaped key through.
const SENSITIVE_KEY = /cookie|set[-_]?cookie|authorization|proxy[-_]?authorization|password|secret|token|room[-_]?grant|signature|sig|api[-_]?key|qrcode[-_]?key|sessdata|bili[-_]?jct|dedeuserid/i;

function redactString(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => redactMediaUrl(url))
    .replace(/\/api\/stream\/media\/[^\s"'<>?]+(?:\?[^\s"'<>]*)?/gi, '/api/stream/media/<redacted>')
    .replace(
      /\b(cookie|set-cookie|authorization|proxy-authorization|roomgrant|token|access[_-]?token|refresh[_-]?token|signature|sig|password|api[_-]?key|qrcode[_-]?key)\b\s*["']?\s*(?::|=)\s*(?:"[^"]*"|'[^']*'|[^,\r\n]*?(?=\s+(?:authorization|proxy-authorization|roomgrant|token|access[_-]?token|refresh[_-]?token|signature|sig|status|range|bytes|timing|resolver|engine)\b\s*["']?\s*(?::|=)|$))/gi,
      (_match, key: string) => `${key}=<redacted>`,
    )
    .replace(/\b(SESSDATA|bili[_-]?jct|DedeUserID(?:__ckMd5)?)\s*=\s*[^;\s,]+/gi, '$1=<redacted>');
}

/**
 * Recursively redact secret-bearing object keys before an error/metadata value
 * is serialized. This protects nested causes and provider metadata, not just a
 * flat error message.
 */
export function redactSensitiveValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (Buffer.isBuffer(value)) return '<redacted>';
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactSensitiveValue(item, seen));

  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SENSITIVE_KEY.test(key)
      ? '<redacted>'
      : redactSensitiveValue(nested, seen);
  }
  return output;
}

/** Sanitize an error/string before it is written to a media log or response. */
export function redactMediaError(value: unknown): string {
  let message: string;
  if (value instanceof Error) {
    const metadata: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as unknown as Record<string, unknown>)) {
      if (key !== 'name' && key !== 'message' && key !== 'stack') metadata[key] = nested;
    }
    // Error.cause is commonly non-enumerable when supplied to the Error
    // constructor, so include it explicitly alongside response/config
    // metadata that providers may attach to the error.
    if ('cause' in value) {
      metadata.cause = (value as Error & { cause?: unknown }).cause;
    }
    const safeMetadata = redactSensitiveValue(metadata);
    let metadataText = '';
    if (Object.keys(metadata).length > 0) {
      try {
        metadataText = ` metadata=${JSON.stringify(safeMetadata)}`;
      } catch {
        metadataText = ' metadata=[redacted]';
      }
    }
    message = `${value.name}: ${value.message}${metadataText}`;
  } else if (value && typeof value === 'object') {
    try {
      message = JSON.stringify(redactSensitiveValue(value));
    } catch {
      message = '[redacted object]';
    }
  } else {
    message = String(value);
  }
  return redactString(message);
}
