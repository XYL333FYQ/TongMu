import { useEffect } from 'react'
import { create } from 'zustand'
import { apiFetch } from '@/lib/api'
import type { RoomListItem } from '@/lib/roomDirectory'

interface DirectoryState {
  rooms: RoomListItem[]
  loading: boolean
  error: string
}

const useDirectoryStore = create<DirectoryState>(() => ({
  rooms: [],
  loading: true,
  error: '',
}))

let identity: string | null = null
let currentRequest: {
  key: string
  controller: AbortController
  promise: Promise<void>
} | null = null
let generation = 0
let loadedAt = 0

function clearDirectory() {
  generation += 1
  currentRequest?.controller.abort()
  currentRequest = null
  identity = null
  loadedAt = 0
  useDirectoryStore.setState({ rooms: [], loading: false, error: '' })
}

function loadDirectory(key: string, force = false): Promise<void> {
  if (identity !== key) {
    generation += 1
    currentRequest?.controller.abort()
    currentRequest = null
    identity = key
    loadedAt = 0
    useDirectoryStore.setState({ rooms: [], loading: true, error: '' })
  }
  if (!force && currentRequest?.key === key) return currentRequest.promise
  // A route switch or StrictMode remount immediately after a response needs no second GET.
  if (!force && Date.now() - loadedAt < 1000) return Promise.resolve()

  generation += 1
  currentRequest?.controller.abort()
  const requestGeneration = generation
  const controller = new AbortController()
  useDirectoryStore.setState({ loading: true, error: '' })
  const promise = (async () => {
    try {
      const response = await apiFetch('/api/rooms', {
        signal: controller.signal,
      })
      const data = (await response.json()) as {
        success: boolean
        rooms?: RoomListItem[]
        message?: string
      }
      if (!response.ok || !data.success || !Array.isArray(data.rooms)) {
        throw new Error(data.message || '暂时无法获取房间，请稍后刷新重试。')
      }
      if (controller.signal.aborted || requestGeneration !== generation) return
      loadedAt = Date.now()
      useDirectoryStore.setState({ rooms: data.rooms, error: '' })
    } catch (error) {
      if (controller.signal.aborted || requestGeneration !== generation) return
      useDirectoryStore.setState({
        error:
          error instanceof Error
            ? error.message
            : '暂时无法获取房间，请稍后刷新重试。',
      })
    } finally {
      if (requestGeneration === generation) {
        currentRequest = null
        useDirectoryStore.setState({ loading: false })
      }
    }
  })()
  currentRequest = { key, controller, promise }
  return promise
}

export function useRoomDirectory(
  authResolved: boolean,
  isAuthenticated: boolean,
  userId?: string
) {
  const rooms = useDirectoryStore((state) => state.rooms)
  const loading = useDirectoryStore((state) => state.loading)
  const error = useDirectoryStore((state) => state.error)

  useEffect(() => {
    if (!authResolved) return
    if (!isAuthenticated) {
      clearDirectory()
      return
    }
    void loadDirectory(userId ?? 'authenticated')
  }, [authResolved, isAuthenticated, userId])

  return {
    rooms,
    loading: !authResolved || (isAuthenticated && loading),
    error,
    refresh: () => loadDirectory(userId ?? 'authenticated', true),
  }
}

export type RoomDirectoryView = ReturnType<typeof useRoomDirectory>
