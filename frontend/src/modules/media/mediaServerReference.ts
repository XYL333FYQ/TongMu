export type MediaServerProviderId = 'emby' | 'jellyfin'

export interface MediaServerReference {
  provider: MediaServerProviderId
  mountId: number
  itemId: string
  mediaSourceId?: string
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,256}$/

function isProvider(value: string): value is MediaServerProviderId {
  return value === 'emby' || value === 'jellyfin'
}

export function buildMediaServerReference(
  reference: MediaServerReference
): string {
  if (
    !isProvider(reference.provider) ||
    !Number.isSafeInteger(reference.mountId) ||
    reference.mountId <= 0
  ) {
    throw new Error('This media server source reference is invalid.')
  }
  if (
    !SAFE_ID.test(reference.itemId) ||
    (reference.mediaSourceId !== undefined &&
      !SAFE_ID.test(reference.mediaSourceId))
  ) {
    throw new Error('This media server item reference is invalid.')
  }
  const params = new URLSearchParams({
    mountId: String(reference.mountId),
    itemId: reference.itemId,
  })
  if (reference.mediaSourceId)
    params.set('mediaSourceId', reference.mediaSourceId)
  return `provider://${reference.provider}?${params.toString()}`
}
