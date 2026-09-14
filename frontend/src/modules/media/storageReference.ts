export type StorageProviderId = 'local-file' | 'webdav' | 'ftp' | 'openlist'

export interface StorageReference {
  provider: StorageProviderId
  mountId?: number
  path: string
  rootKey?: string
}

function normalizePath(value: string): string {
  const normalized = decodeURIComponent(value).replace(/\\/g, '/')
  if (!normalized || normalized.length > 1024 || normalized.includes('\0')) {
    throw new Error('存储文件路径无效')
  }
  return normalized.startsWith('/') ? normalized : `/${normalized}`
}

export function buildStorageReference(reference: StorageReference): string {
  const path = normalizePath(reference.path)
  if (reference.provider === 'local-file') {
    const rootKey = reference.rootKey ?? 'uploads'
    if (!/^(?:uploads|custom:\d+)$/.test(rootKey)) throw new Error('服务器文件根目录无效')
  } else if (reference.rootKey) {
    throw new Error('远程存储不支持 rootKey')
  }
  const query = new URLSearchParams({ path })
  if (reference.mountId !== undefined) query.set('mountId', String(reference.mountId))
  if (reference.rootKey) query.set('rootKey', reference.rootKey)
  return `storage://${reference.provider}?${query.toString()}`
}

export function buildServerFileStorageReference(input: string): string {
  const trimmed = input.trim()
  const match = /^(uploads|custom:\d+):(.*)$/.exec(trimmed)
  return buildStorageReference({
    provider: 'local-file',
    rootKey: match?.[1] ?? 'uploads',
    path: match?.[2] || trimmed || '/',
  })
}
