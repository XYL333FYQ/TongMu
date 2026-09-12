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

/** Sanitize an error/string before it is written to a media log. */
export function redactMediaError(value: unknown): string {
  const message = value instanceof Error
    ? `${value.name}: ${value.message}`
    : String(value);
  return message
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => redactMediaUrl(url))
    .replace(/\/api\/stream\/media\/[^\s"'<>?]+(?:\?[^\s"'<>]*)?/gi, '/api/stream/media/<redacted>')
    .replace(
      /\b(cookie|set-cookie)\b\s*["']?\s*(?::|=)\s*(?:"[^"]*"|'[^']*'|[^,\r\n]*?(?=\s+(?:authorization|proxy-authorization|roomgrant|token|access[_-]?token|signature|sig|status|range|bytes|timing|resolver|engine)\b\s*["']?\s*(?::|=)|$))/gi,
      (_match, key: string) => `${key}=<redacted>`,
    )
    .replace(
      /\b(authorization|proxy-authorization|roomgrant|token|access[_-]?token|signature|sig)\b\s*["']?\s*(?::|=)\s*["']?(?:Bearer\s+)?[^,\s;"'}]+["']?/gi,
      (_match, key: string) => `${key}=<redacted>`,
    );
}
