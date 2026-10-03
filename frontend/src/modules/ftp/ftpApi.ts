import { apiFetch } from '@/lib/api'
import { englishErrorMessage } from '@/lib/errorMessage'
import type {
  FTPMount,
  FTPMountFormPayload,
  FTPConnectionParams,
  FTPDirectoryEntry,
  FTPResolvedSource,
} from './types'
import type { MediaFormat } from '@/lib/mediaFormat'

export interface FTPTestResult {
  success: boolean
  itemCount: number
}

function jsonHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json' }
}

export async function getFTPMounts(): Promise<FTPMount[]> {
  const res = await apiFetch('/api/ftp/mounts')
  const data = (await res.json()) as {
    success: boolean
    mounts?: FTPMount[]
    message?: string
  }
  if (!res.ok || !data.success) {
    throw new Error(
      englishErrorMessage(data.message, 'Unable to load FTP sources.')
    )
  }
  return data.mounts || []
}

export async function createFTPMount(
  payload: FTPMountFormPayload
): Promise<FTPMount> {
  const res = await apiFetch('/api/ftp/mounts', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(payload),
  })
  const data = (await res.json()) as {
    success: boolean
    mount?: FTPMount
    message?: string
  }
  if (!res.ok || !data.success || !data.mount) {
    throw new Error(
      englishErrorMessage(data.message, 'Unable to add this FTP source.')
    )
  }
  return data.mount
}

export async function updateFTPMount(
  id: number,
  payload: FTPMountFormPayload
): Promise<FTPMount> {
  const res = await apiFetch(`/api/ftp/mounts/${id}`, {
    method: 'PUT',
    headers: jsonHeaders(),
    body: JSON.stringify(payload),
  })
  const data = (await res.json()) as {
    success: boolean
    mount?: FTPMount
    message?: string
  }
  if (!res.ok || !data.success || !data.mount) {
    throw new Error(
      englishErrorMessage(data.message, 'Unable to update this FTP source.')
    )
  }
  return data.mount
}

export async function deleteFTPMount(id: number): Promise<void> {
  const res = await apiFetch(`/api/ftp/mounts/${id}`, {
    method: 'DELETE',
  })
  const data = (await res.json()) as { success: boolean; message?: string }
  if (!res.ok || !data.success) {
    throw new Error(
      englishErrorMessage(data.message, 'Unable to remove this FTP source.')
    )
  }
}

export async function testFTPMount(
  params: FTPConnectionParams
): Promise<FTPTestResult> {
  const res = await apiFetch('/api/ftp/mounts/test', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(params),
  })
  const data = (await res.json()) as {
    success: boolean
    itemCount?: number
    message?: string
  }
  if (!res.ok || !data.success) {
    throw new Error(
      englishErrorMessage(
        data.message,
        'Unable to connect to FTP. Check the address and credentials.'
      )
    )
  }
  return {
    success: true,
    itemCount: data.itemCount ?? 0,
  }
}

export async function browseFTPMount(
  id: number,
  path?: string
): Promise<FTPDirectoryEntry[]> {
  const query = path ? `?path=${encodeURIComponent(path)}` : ''
  const res = await apiFetch(`/api/ftp/mounts/${id}/browse${query}`)
  const data = (await res.json()) as {
    success: boolean
    entries?: FTPDirectoryEntry[]
    message?: string
  }
  if (!res.ok || !data.success) {
    throw new Error(
      englishErrorMessage(data.message, 'Unable to browse this FTP library.')
    )
  }
  return data.entries || []
}

export async function resolveFTP(
  mountId: number,
  path: string
): Promise<FTPResolvedSource> {
  const query = new URLSearchParams({
    mountId: String(mountId),
    path,
  }).toString()
  const res = await apiFetch(`/api/ftp/resolve?${query}`)
  const data = (await res.json()) as {
    success: boolean
    message?: string
    title?: string
    videoUrl?: string
    format?: MediaFormat
    duration?: number
    size?: number
  }
  if (!res.ok || !data.success || !data.videoUrl) {
    throw new Error(
      englishErrorMessage(data.message, 'Unable to open this FTP file.')
    )
  }
  return {
    title: data.title || '',
    videoUrl: data.videoUrl,
    format: data.format || 'mp4',
    duration: data.duration ?? 0,
    size: data.size,
  }
}
