/**
 * URLs that may be stored as public artwork metadata.
 *
 * The server never fetches artwork through this helper.  It only prevents a
 * catalog response or queue mutation from turning a browser-rendered image
 * into an obvious local-network or credential-leaking URL.
 */
export function safePublicHttpUrl(value: unknown, maxLength = 2_048): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) return null;
  if (/[\r\n]/.test(value) || /(?:authorization|cookie|password|passwd|secret|access[_-]?token|refresh[_-]?token|signature|[?&]token=)/i.test(value)) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
  if (isPrivateOrLocalHostname(parsed.hostname)) return null;
  return parsed.toString();
}

export function isPrivateOrLocalHostname(rawHostname: string): boolean {
  const hostname = rawHostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    return true;
  }
  if (hostname === '::1' || hostname.startsWith('fe80:') || hostname.startsWith('fc') || hostname.startsWith('fd')) return true;
  const mappedIpv4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(hostname);
  if (mappedIpv4) return isPrivateOrLocalHostname(mappedIpv4[1]);
  const parts = hostname.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some((part) => part > 255)) return true;
  const [first, second] = octets;
  return first === 0 || first === 10 || first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 100 && second >= 64 && second <= 127);
}
