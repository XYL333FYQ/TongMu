import { Agent, fetch, type RequestInit, type Response } from 'undici';
import { lookup as dnsLookup } from 'node:dns';
import { promises as dns } from 'node:dns';
import { BlockList, isIP } from 'node:net';

export type ProxyTargetPolicy = 'public-only' | 'trusted-private';

const MAX_REDIRECTS = 10;
const blocked = new BlockList();

for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10],
  ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(network, prefix, 'ipv4');

for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48],
  ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) blocked.addSubnet(network, prefix, 'ipv6');

export class ProxyTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProxyTargetError';
  }
}

function normalizeHostname(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

export function isPublicIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  if (family === 6) {
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
    if (mapped) {
      const high = Number.parseInt(mapped[1], 16);
      const low = Number.parseInt(mapped[2], 16);
      return isPublicIp(
        `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`,
      );
    }
    return !blocked.check(address, 'ipv6');
  }
  return false;
}

export function validateProxyUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ProxyTargetError('非法的代理 URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ProxyTargetError('代理仅允许 HTTP/HTTPS URL');
  }
  if (!parsed.hostname || parsed.username || parsed.password) {
    throw new ProxyTargetError('代理 URL 不允许凭证或空主机名');
  }
  return parsed;
}

function assertLiteralHostIsPublic(url: URL): void {
  const hostname = normalizeHostname(url.hostname);
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new ProxyTargetError('代理目标不是公网地址');
  }
  if (isIP(hostname) && !isPublicIp(hostname)) {
    throw new ProxyTargetError('代理目标不是公网地址');
  }
}

/** Browser automation cannot use the Undici dispatcher, so validate every navigation/request first. */
type LookupAll = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const lookupAll: LookupAll = (hostname) => dns.lookup(hostname, { all: true, verbatim: true });

export async function assertPublicUrl(rawUrl: string, lookup: LookupAll = lookupAll): Promise<URL> {
  const parsed = validateProxyUrl(rawUrl);
  assertLiteralHostIsPublic(parsed);
  const hostname = normalizeHostname(parsed.hostname);
  if (!isIP(hostname)) {
    await resolvePublicAddresses(hostname, lookup);
  }
  return parsed;
}

/** Resolve once and return only addresses that are safe to connect to directly. */
export async function resolvePublicAddresses(
  hostname: string,
  lookup: LookupAll = lookupAll,
): Promise<Array<{ address: string; family: number }>> {
  const normalized = normalizeHostname(hostname);
  if (isIP(normalized)) {
    if (!isPublicIp(normalized)) throw new ProxyTargetError('目标 DNS 解析到非公网地址');
    return [{ address: normalized, family: isIP(normalized) }];
  }
  const addresses = await lookup(normalized);
  if (!addresses.length || addresses.some((entry) => !isPublicIp(entry.address))) {
    throw new ProxyTargetError('目标 DNS 解析到非公网地址');
  }
  return addresses;
}

const publicDispatcher = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      dnsLookup(hostname, { ...options, all: true, verbatim: true }, (error, addresses) => {
        if (error) return callback(error, '', 4);
        if (!addresses.length || addresses.some((entry) => !isPublicIp(entry.address))) {
          return callback(new ProxyTargetError('代理目标 DNS 解析到非公网地址'), '', 4);
        }
        if (options.all) return callback(null, addresses as never);
        const selected = addresses[0];
        return callback(null, selected.address, selected.family);
      });
    },
  },
});

const FORBIDDEN_REQUEST_HEADERS = new Set([
  'host', 'content-length', 'transfer-encoding', 'connection', 'proxy-authorization',
  'proxy-connection', 'keep-alive', 'te', 'trailer', 'upgrade', 'x-real-ip',
]);

function isExplicitE2eFixture(url: URL): boolean {
  if (process.env.NODE_ENV !== 'test') return false;
  const configured = process.env.MEDIA_E2E_FIXTURE_ORIGIN?.trim();
  if (!configured) return false;
  try { return url.origin === new URL(configured).origin; } catch { return false; }
}

export function sanitizeProxyHeaders(input?: Record<string, string>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(input ?? {})) {
    const lower = name.toLowerCase();
    if (
      FORBIDDEN_REQUEST_HEADERS.has(lower) ||
      lower.startsWith('x-forwarded-') ||
      lower.startsWith('sec-')
    ) continue;
    output[name] = value;
  }
  return output;
}

function stripCrossOriginCredentials(headers: Record<string, string>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (
      lower === 'cookie' ||
      lower === 'authorization' ||
      lower === 'proxy-authorization' ||
      lower.includes('token') ||
      /(?:^|[-_])api[-_]?key$/.test(lower)
    ) continue;
    output[name] = value;
  }
  return output;
}

export interface ProxyFetchResult {
  response: Response;
  /** URL reached after the redirect chain. */
  finalUrl: string;
  /** Headers actually sent to the final request. */
  headers: Record<string, string>;
  /** Origins that may receive credential-like headers, or [] after a cross-origin strip. */
  credentialOrigins: string[];
}

export async function fetchWithProxyPolicyDetailed(
  rawUrl: string,
  init: RequestInit,
  policy: ProxyTargetPolicy,
  trustedPrivateHosts: string[] = [],
): Promise<ProxyFetchResult> {
  let current = validateProxyUrl(rawUrl);
  let headers = sanitizeProxyHeaders(init.headers as Record<string, string> | undefined);
  let credentialOrigins = Object.keys(headers).some((name) => {
    const lower = name.toLowerCase();
    return lower === 'cookie' || lower === 'authorization' || lower.includes('token') || /(?:^|[-_])api[-_]?key$/.test(lower);
  }) ? [current.origin] : [];
  const trustedHosts = new Set(trustedPrivateHosts.map(normalizeHostname).map((host) => host.toLowerCase()));

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const privateHostAllowed =
      isExplicitE2eFixture(current) ||
      (policy === 'trusted-private' &&
        trustedHosts.has(normalizeHostname(current.hostname).toLowerCase()));
    if (!privateHostAllowed) assertLiteralHostIsPublic(current);
    let response: Response;
    try {
      response = await fetch(current, {
        ...init,
        headers,
        redirect: 'manual',
        dispatcher: privateHostAllowed ? undefined : publicDispatcher,
      });
    } catch (error) {
      let cause: unknown = error;
      for (let depth = 0; depth < 5 && cause instanceof Error; depth += 1) {
        if (cause instanceof ProxyTargetError) throw cause;
        cause = (cause as Error & { cause?: unknown }).cause;
      }
      throw error;
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return {
        response,
        finalUrl: current.toString(),
        headers,
        credentialOrigins,
      };
    }
    if (redirects === MAX_REDIRECTS) {
      await response.body?.cancel();
      throw new ProxyTargetError('代理重定向次数过多');
    }
    const location = response.headers.get('location');
    if (!location) {
      return {
        response,
        finalUrl: current.toString(),
        headers,
        credentialOrigins,
      };
    }
    const next = validateProxyUrl(new URL(location, current).toString());
    const nextPrivateHostAllowed =
      isExplicitE2eFixture(next) ||
      (policy === 'trusted-private' &&
        trustedHosts.has(normalizeHostname(next.hostname).toLowerCase()));
    if (!nextPrivateHostAllowed) assertLiteralHostIsPublic(next);
    if (next.origin !== current.origin) {
      headers = stripCrossOriginCredentials(headers);
      // Once credentials have crossed an origin boundary they are permanently
      // disassociated from the redirect chain. A later redirect back to the
      // original origin must not resurrect them.
      credentialOrigins = [];
    }
    await response.body?.cancel();
    current = next;
  }
  throw new ProxyTargetError('代理重定向次数过多');
}

export async function fetchWithProxyPolicy(
  rawUrl: string,
  init: RequestInit,
  policy: ProxyTargetPolicy,
  trustedPrivateHosts: string[] = [],
): Promise<Response> {
  return (await fetchWithProxyPolicyDetailed(rawUrl, init, policy, trustedPrivateHosts)).response;
}
