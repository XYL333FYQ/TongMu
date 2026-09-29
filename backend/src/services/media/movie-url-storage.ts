import type { ValueTransformer } from 'typeorm';
import { isSecretVaultEnvelope, secretVault, type SecretVault } from '../secret-vault';

const PRIVATE_QUERY_KEY = /token|cookie|auth|password|secret|api.?key|signature|(?:^|[_-])sig(?:$|[_-])|expires?|expiry|deadline|policy|key.?pair/i;

export function isTransientMediaHandle(value: string): boolean {
  return /^\/api\/stream\/media\/[^/?#]+/.test(value);
}

/** Public direct URLs remain plaintext; private queries and room capabilities do not. */
export function requiresProtectedMovieUrl(value: string): boolean {
  if (isTransientMediaHandle(value)) return true;
  try {
    const url = new URL(value);
    if (!['http:', 'https:', 'provider:', 'storage:'].includes(url.protocol)) return false;
    return Boolean(url.username || url.password || url.hash) ||
      [...url.searchParams.keys()].some((key) => PRIVATE_QUERY_KEY.test(key));
  } catch { return false; }
}

export function durableMovieUrl(
  url: string,
  movieId: number | undefined,
  sourceInput: string | null | undefined,
  mediaDescriptor: string | null | undefined,
): string {
  if (!isTransientMediaHandle(url) || !sourceInput || !mediaDescriptor) return url;
  try {
    const descriptor = JSON.parse(mediaDescriptor);
    if (typeof descriptor?.resolver === 'string' && descriptor.resolver) {
      return `media-movie:${movieId ?? 'pending'}`;
    }
  } catch { /* Old malformed metadata cannot prove a refresh path. */ }
  return url;
}

export function movieUrlTransformer(vault: Pick<SecretVault, 'encrypt' | 'decrypt'> = secretVault): ValueTransformer {
  return {
    to(value: unknown) {
      if (typeof value !== 'string' || !value) return value;
      if (isSecretVaultEnvelope(value)) { vault.decrypt(value); return value; }
      return requiresProtectedMovieUrl(value) ? vault.encrypt(value) : value;
    },
    from(value: unknown) {
      if (typeof value !== 'string' || !value) return value;
      if (isSecretVaultEnvelope(value)) return vault.decrypt(value);
      if (requiresProtectedMovieUrl(value)) throw new Error('影片敏感地址尚未完成迁移');
      return value;
    },
  };
}

/** Playback request headers can contain authorization even when the URL is public. */
export function playbackHeadersTransformer(vault: Pick<SecretVault, 'encrypt' | 'decrypt'> = secretVault): ValueTransformer {
  return {
    to(value: unknown) {
      if (typeof value !== 'string' || !value) return value;
      if (isSecretVaultEnvelope(value)) { vault.decrypt(value); return value; }
      return vault.encrypt(value);
    },
    from(value: unknown) {
      if (typeof value !== 'string' || !value) return value;
      if (!isSecretVaultEnvelope(value)) throw new Error('播放凭证尚未完成迁移');
      return vault.decrypt(value);
    },
  };
}
