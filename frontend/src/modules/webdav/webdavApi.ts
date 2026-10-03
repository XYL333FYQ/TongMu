import { t } from '@/i18n'
/**
 * WebDAV / OpenList 挂载 API 工厂
 *
 * OpenList（AList）兼容 WebDAV 协议，前后端逻辑与 WebDAV 基本一致，
 * 因此共用一个 API 工厂，OpenList 仅传入不同的 basePath / label / module。
 * 各模块类型独立，保证调用方类型安全。
 */
import { apiFetch } from '@/lib/api'
import { englishErrorMessage } from '@/lib/errorMessage'
import { buildProxyUrl } from '@/modules/direct-link/directLinkApi'
import type { MediaFormat } from '@/lib/mediaFormat'
import type {
  WebDAVMount,
  WebDAVMountFormPayload,
  WebDAVConnectionParams,
  WebDAVDirectoryEntry,
  WebDAVResolvedSource,
} from './types'

export interface WebDAVTestResult {
  success: boolean
  itemCount: number
}

export interface ResolvedSourceBase {
  title: string
  videoUrl: string
  format: MediaFormat
  duration: number
}

export interface MountApiOptions {
  basePath: string
  label: string
  module: 'webdav' | 'openlist'
}

export interface MountApi<
  TMount extends { id: number },
  TForm,
  TConnection,
  TEntry,
  TResolved extends ResolvedSourceBase,
> {
  getMounts: () => Promise<TMount[]>
  createMount: (payload: TForm) => Promise<TMount & { warning?: string }>
  updateMount: (
    id: number,
    payload: TForm
  ) => Promise<TMount & { warning?: string }>
  deleteMount: (id: number) => Promise<void>
  testMount: (
    params: TConnection
  ) => Promise<{ success: boolean; itemCount: number }>
  browseMount: (id: number, path?: string) => Promise<TEntry[]>
  resolveMount: (mountId: number, path: string) => Promise<TResolved>
  buildProxyUrl: (mountId: number, path: string) => string
  fetchDirectUrl: (mountId: number, path: string) => Promise<string>
}

function jsonHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json' }
}

export function createMountApi<
  TMount extends { id: number },
  TForm,
  TConnection,
  TEntry,
  TResolved extends ResolvedSourceBase,
>(
  opts: MountApiOptions
): MountApi<TMount, TForm, TConnection, TEntry, TResolved> {
  const { basePath, label, module } = opts

  return {
    async getMounts(): Promise<TMount[]> {
      const res = await apiFetch(`${basePath}/mounts`)
      const data = (await res.json()) as {
        success: boolean
        mounts?: TMount[]
        message?: string
      }
      if (!res.ok || !data.success) {
        throw new Error(
          englishErrorMessage(data.message, `Unable to load ${label} sources.`)
        )
      }
      return data.mounts || []
    },

    async createMount(payload: TForm): Promise<TMount & { warning?: string }> {
      const res = await apiFetch(`${basePath}/mounts`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify(payload),
      })
      const data = (await res.json()) as {
        success: boolean
        mount?: TMount
        message?: string
        warning?: string
      }
      if (!res.ok || !data.success || !data.mount) {
        throw new Error(
          englishErrorMessage(
            data.message,
            `Unable to add this ${label} source.`
          )
        )
      }
      return {
        ...data.mount,
        warning: data.warning
          ? englishErrorMessage(
              data.warning,
              t(
                'This source was saved, but direct access is unavailable. Use server forwarding or check the source HTTPS settings.'
              )
            )
          : undefined,
      }
    },

    async updateMount(
      id: number,
      payload: TForm
    ): Promise<TMount & { warning?: string }> {
      const res = await apiFetch(`${basePath}/mounts/${id}`, {
        method: 'PUT',
        headers: jsonHeaders(),
        body: JSON.stringify(payload),
      })
      const data = (await res.json()) as {
        success: boolean
        mount?: TMount
        message?: string
        warning?: string
      }
      if (!res.ok || !data.success || !data.mount) {
        throw new Error(
          englishErrorMessage(
            data.message,
            `Unable to update this ${label} source.`
          )
        )
      }
      return {
        ...data.mount,
        warning: data.warning
          ? englishErrorMessage(
              data.warning,
              t(
                'This source was saved, but direct access is unavailable. Use server forwarding or check the source HTTPS settings.'
              )
            )
          : undefined,
      }
    },

    async deleteMount(id: number): Promise<void> {
      const res = await apiFetch(`${basePath}/mounts/${id}`, {
        method: 'DELETE',
      })
      const data = (await res.json()) as { success: boolean; message?: string }
      if (!res.ok || !data.success) {
        throw new Error(
          englishErrorMessage(
            data.message,
            `Unable to remove this ${label} source.`
          )
        )
      }
    },

    async testMount(
      params: TConnection
    ): Promise<{ success: boolean; itemCount: number }> {
      const res = await apiFetch(`${basePath}/mounts/test`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify(params),
      })
      const data = (await res.json()) as {
        success: boolean
        itemCount?: number
        message?: string
        code?: string
      }
      if (!res.ok || !data.success) {
        throw new Error(
          englishErrorMessage(
            data.message,
            `Unable to connect to ${label}. Check the address and credentials.`
          )
        )
      }
      return {
        success: true,
        itemCount: data.itemCount ?? 0,
      }
    },

    async browseMount(id: number, path?: string): Promise<TEntry[]> {
      const query = path ? `?path=${encodeURIComponent(path)}` : ''
      const res = await apiFetch(`${basePath}/mounts/${id}/browse${query}`)
      const data = (await res.json()) as {
        success: boolean
        entries?: TEntry[]
        message?: string
      }
      if (!res.ok || !data.success) {
        throw new Error(
          englishErrorMessage(
            data.message,
            `Unable to browse this ${label} folder.`
          )
        )
      }
      return data.entries || []
    },

    async resolveMount(mountId: number, path: string): Promise<TResolved> {
      const query = new URLSearchParams({
        mountId: String(mountId),
        path,
      }).toString()
      const res = await apiFetch(`${basePath}/resolve?${query}`)
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
          englishErrorMessage(
            data.message,
            `Unable to open this ${label} file.`
          )
        )
      }
      return {
        title: data.title || '',
        videoUrl: data.videoUrl,
        format: data.format || 'mp4',
        duration: data.duration ?? 0,
      } as TResolved
    },

    buildProxyUrl(mountId: number, path: string): string {
      return buildProxyUrl(module, { mountId, path })
    },

    /**
     * 调用后端 /direct-url 接口获取直链 URL。
     * 后端使用挂载凭证：优先 AList API（带签名直链），WebDAV 失败时回退拼接。
     */
    async fetchDirectUrl(mountId: number, path: string): Promise<string> {
      const query = new URLSearchParams({
        mountId: String(mountId),
        path,
      }).toString()
      const res = await apiFetch(`${basePath}/direct-url?${query}`)
      const data = (await res.json()) as {
        success: boolean
        message?: string
        directUrl?: string
      }
      if (!res.ok || !data.success || !data.directUrl) {
        throw new Error(
          englishErrorMessage(
            data.message,
            `Unable to obtain a direct link from ${label}.`
          )
        )
      }
      return data.directUrl
    },
  }
}

// ==================== WebDAV 实例与兼容具名导出 ====================

const webdavApi = createMountApi<
  WebDAVMount,
  WebDAVMountFormPayload,
  WebDAVConnectionParams,
  WebDAVDirectoryEntry,
  WebDAVResolvedSource
>({
  basePath: '/api/webdav',
  label: 'WebDAV',
  module: 'webdav',
})

export const getWebDAVMounts = webdavApi.getMounts
export const createWebDAVMount = webdavApi.createMount
export const updateWebDAVMount = webdavApi.updateMount
export const deleteWebDAVMount = webdavApi.deleteMount
export const testWebDAVMount = webdavApi.testMount
export const browseWebDAVMount = webdavApi.browseMount
export const resolveWebDAV = webdavApi.resolveMount
export const buildWebDAVProxyUrl = webdavApi.buildProxyUrl
export const fetchWebDAVDirectUrl = webdavApi.fetchDirectUrl
