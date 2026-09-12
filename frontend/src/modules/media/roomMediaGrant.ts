const CURRENT_KEY = 'zviewer-room-media-grant';
export const ROOM_MEDIA_GRANT_CHANGED_EVENT = 'zviewer-room-media-grant-changed';

interface StoredRoomGrant {
  roomId: string;
  grant: string;
}

export function storeRoomMediaGrant(roomId: string, grant: unknown): void {
  if (!roomId || typeof grant !== 'string' || !grant) return;
  try {
    const previous = getRoomMediaGrant(roomId);
    sessionStorage.setItem(CURRENT_KEY, JSON.stringify({ roomId, grant } satisfies StoredRoomGrant));
    if (previous !== grant && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(ROOM_MEDIA_GRANT_CHANGED_EVENT, {
        detail: { roomId, grant, previousGrant: previous },
      }));
    }
  } catch {
    // Storage may be unavailable in privacy-restricted contexts.
  }
}

/** Remove volatile auth parameters before reattaching the original signed handle. */
export function stripMediaGatewayAuth(url: string): string {
  try {
    const parsed = new URL(url, window.location.origin);
    if (!parsed.pathname.startsWith('/api/stream/media/')) return url;
    parsed.searchParams.delete('roomGrant');
    parsed.searchParams.delete('token');
    if (url.startsWith('/') && !url.startsWith('//')) {
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

export function getRoomMediaGrant(roomId?: string): string {
  try {
    const raw = sessionStorage.getItem(CURRENT_KEY);
    if (!raw) return '';
    const value = JSON.parse(raw) as Partial<StoredRoomGrant>;
    if (typeof value.grant !== 'string' || typeof value.roomId !== 'string') return '';
    if (roomId && value.roomId !== roomId) return '';
    return value.grant;
  } catch {
    return '';
  }
}

export function appendRoomMediaGrant(url: string, roomId?: string): string {
  const grant = getRoomMediaGrant(roomId);
  if (!grant) return url;
  try {
    const parsed = new URL(url, window.location.origin);
    if (!parsed.pathname.startsWith('/api/stream/media/')) return url;
    if (parsed.searchParams.has('roomGrant')) return url;
    return `${url}${url.includes('?') ? '&' : '?'}roomGrant=${encodeURIComponent(grant)}`;
  } catch {
    return url;
  }
}

export function clearRoomMediaGrant(): void {
  try { sessionStorage.removeItem(CURRENT_KEY); } catch { /* ignore */ }
}
