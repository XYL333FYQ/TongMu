import { AsyncLocalStorage } from 'node:async_hooks';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface RequestLogContext {
  requestId?: string;
}

type LogContext = Record<string, unknown>;

const requestContext = new AsyncLocalStorage<RequestLogContext>();
const REDACTED = '[REDACTED]';
const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 50;
const MAX_STRING_LENGTH = 2_048;

const SECRET_KEY = /(?:^|[-_])(?:authorization|cookie|set[-_]?cookie|music[-_]?u|__csrf|password|passphrase|api[-_]?key|jwt|token|access[-_]?token|refresh[-_]?token|query[-_]?token|signed[-_]?(?:url|handle)|media[-_]?handle|private[-_]?key|signing[-_]?key|secret(?:[-_]?vault)?(?:[-_]?key)?|database[-_]?secret)(?:$|[-_])/i;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi;
const PRIVATE_KEY_PATTERN = /-----BEGIN(?: ENCRYPTED)? PRIVATE KEY-----[\s\S]*?-----END(?: ENCRYPTED)? PRIVATE KEY-----/g;
const COOKIE_VALUE_PATTERN = /\b(?:MUSIC_U|__csrf|access_token|refresh_token)\s*=\s*[^;\s,]+/gi;
const INLINE_SECRET_PATTERN = /\b(authorization|cookie|set-cookie|music_u|__csrf|password|api[-_ ]?key|jwt|access[-_ ]?token|refresh[-_ ]?token|private[-_ ]?key|signing[-_ ]?key|secret)\b\s*[:=]\s*([^\s,;]+)/gi;
const SECRET_QUERY_KEY = /(?:token|key|secret|signature|sig|auth|authorization|cookie|music_u|__csrf|jwt|password|credential)/i;

function isSecretKey(key: string): boolean {
  if (SECRET_KEY.test(key)) return true;
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return [
    'authorization',
    'cookie',
    'setcookie',
    'musicu',
    'csrf',
    'password',
    'passphrase',
    'apikey',
    'jwt',
    'token',
    'signedurl',
    'signedhandle',
    'mediahandle',
    'privatekey',
    'signingkey',
    'secretvaultkey',
    'databasesecret',
  ].some((suffix) => normalized === suffix || normalized.endsWith(suffix));
}

function boundedString(value: string): string {
  const withoutKnownSecrets = value
    .replace(PRIVATE_KEY_PATTERN, REDACTED)
    .replace(JWT_PATTERN, REDACTED)
    .replace(BEARER_PATTERN, `Bearer ${REDACTED}`)
    .replace(COOKIE_VALUE_PATTERN, (match) => `${match.split('=')[0]}=${REDACTED}`)
    .replace(INLINE_SECRET_PATTERN, (_match, key: string) => `${key}=${REDACTED}`);

  const withoutSensitiveQueries = withoutKnownSecrets.replace(/https?:\/\/[^\s"'<>]+/gi, (candidate) => {
    try {
      const parsed = new URL(candidate);
      for (const key of [...parsed.searchParams.keys()]) {
        if (SECRET_QUERY_KEY.test(key)) parsed.searchParams.set(key, REDACTED);
      }
      // Query strings are not useful in routine logs. Preserve only the safe
      // origin/path so signed provider URLs can never leak by omission.
      return `${parsed.origin}${parsed.pathname}${parsed.search ? '?[REDACTED_QUERY]' : ''}`;
    } catch {
      return '[INVALID_URL]';
    }
  });

  return withoutSensitiveQueries.length <= MAX_STRING_LENGTH
    ? withoutSensitiveQueries
    : `${withoutSensitiveQueries.slice(0, MAX_STRING_LENGTH)}...[TRUNCATED]`;
}

function errorRecord(error: Error, depth: number, seen: WeakSet<object>): LogContext {
  const source = error as Error & { code?: unknown; cause?: unknown };
  const result: LogContext = {
    name: boundedString(error.name || 'Error'),
    message: boundedString(error.message || 'error'),
  };
  if (typeof source.code === 'string' && /^[A-Z0-9_:-]{1,64}$/.test(source.code)) {
    result.code = source.code;
  }
  if (process.env.NODE_ENV !== 'production' && error.stack) {
    result.stack = boundedString(error.stack);
  }
  if (source.cause !== undefined) result.cause = redactValue(source.cause, depth + 1, seen);
  return result;
}

export function redactValue(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return boundedString(value);
  if (typeof value === 'function' || typeof value === 'symbol') return `[${typeof value}]`;
  if (depth >= MAX_DEPTH) return '[MAX_DEPTH]';
  if (typeof value !== 'object') return boundedString(String(value));
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);

  try {
    if (value instanceof Error) return errorRecord(value, depth, seen);
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `[BINARY:${value.byteLength}]`;
    if (Array.isArray(value)) {
      return value.slice(0, MAX_ARRAY_ITEMS).map((entry) => redactValue(entry, depth + 1, seen));
    }
    const output: LogContext = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = isSecretKey(key) ? REDACTED : redactValue(entry, depth + 1, seen);
    }
    return output;
  } catch {
    return '[UNSERIALIZABLE]';
  } finally {
    seen.delete(value);
  }
}

export function runWithRequestContext<T>(context: RequestLogContext, callback: () => T): T {
  return requestContext.run(context, callback);
}

export function createLogRecord(
  level: LogLevel,
  component: string,
  event: string,
  context: LogContext = {},
): LogContext {
  const active = requestContext.getStore();
  return {
    timestamp: new Date().toISOString(),
    level,
    component: /^[a-z0-9_.:-]{1,64}$/i.test(component) ? component : 'application',
    event: /^[a-z0-9_.:-]{1,96}$/i.test(event) ? event : 'event',
    ...(active?.requestId ? { requestId: active.requestId } : {}),
    ...(redactValue(context) as LogContext),
  };
}

type LogSink = (line: string, level: LogLevel) => void;

let sink: LogSink = (line, level) => {
  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
};

function write(level: LogLevel, component: string, event: string, context?: LogContext): void {
  try {
    sink(JSON.stringify(createLogRecord(level, component, event, context)), level);
  } catch {
    // Observability must fail soft. Never retry with raw context because that
    // could leak the exact value redaction was meant to protect.
  }
}

export const logger = {
  debug: (component: string, event: string, context?: LogContext) => write('debug', component, event, context),
  info: (component: string, event: string, context?: LogContext) => write('info', component, event, context),
  warn: (component: string, event: string, context?: LogContext) => write('warn', component, event, context),
  error: (component: string, event: string, context?: LogContext) => write('error', component, event, context),
};

export function __setLogSinkForTests(testSink?: LogSink): void {
  sink = testSink ?? ((line, level) => {
    if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  });
}
