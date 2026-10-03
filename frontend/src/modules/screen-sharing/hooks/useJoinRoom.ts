import { t, useTranslation } from '@/i18n'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Socket } from 'socket.io-client'
import { useRoomStore } from '@/store/roomStore'
import type { RoomMode } from '@/store/roomStore'
import { message } from '@/components/ui/message'
import type {
  JoinStatus,
  JoinApprovedPayload,
  JoinRejectedPayload,
  RoomModeChangedPayload,
  RequestJoinResponse,
} from '../types'
import { storeRoomMediaGrant } from '@/modules/media/roomMediaGrant'
import { useAuthStore } from '@/store/authStore'
import {
  getGuestNickname,
  saveGuestNickname,
} from '@/modules/room/guestNickname'
import { roomErrorMessage } from '@/modules/room/roomErrors'
import {
  ROOM_MEDIA_TEARDOWN_EVENT,
  type RoomMediaTeardownDetail,
} from '@/lib/mediaTeardown'

interface UseJoinRoomOptions {
  socket: Socket | null
  /** 当前 URL 中的 roomId */
  roomId: string | undefined
  /** 是否已连接 */
  connected: boolean
  /** 当 join-approved 且 mode === 'screen-share' 时调用（用于创建 PC） */
  onApprovedScreenShare?: () => void
  /** 当 join-approved 且 mode === 'watch-together' 时调用 */
  onApprovedWatchTogether?: () => void
  /** room-mode-changed 事件回调（含切换到 screen-share 时需要创建 PC） */
  onRoomModeChanged?: (data: RoomModeChangedPayload) => void
  /** 房间名称更新回调 */
  onRoomNameUpdated?: (data: { roomId: string; name: string }) => void
  /** 是否在 roomId 变化时自动 requestJoin（默认 true）。
   *  从房间列表进入有密码的房间时传 false，避免空密码触发"密码错误"提示，
   *  等待用户输入密码后手动调用 requestJoin。 */
  autoJoin?: boolean
}

interface UseJoinRoomResult {
  /** 当前加入状态 */
  joinStatus: JoinStatus
  /** 当前房间模式（由后端返回） */
  roomMode: RoomMode | null
  /** 请求加入房间 */
  requestJoin: (
    targetRoomId: string,
    password: string,
    nickname?: string
  ) => void
  joinError: string
  /** 手动重置 joinStatus（用于切换房间时清空状态） */
  resetJoinState: () => void
}

/**
 * 观众端加入房间流程 hook：
 * - 维护 joinStatus / roomMode 状态机
 * - 自动监听 roomId 变化触发 requestJoin
 * - 处理 socket 重连后重新加入
 * - 订阅 join-approved / join-rejected / room-name-updated / room-mode-changed 事件
 *
 * 不包含 WebRTC / video srcObject 逻辑，相关副作用由调用方在回调中处理。
 */
export function useJoinRoom(options: UseJoinRoomOptions): UseJoinRoomResult {
  useTranslation()

  const {
    socket,
    roomId,
    connected,
    onApprovedScreenShare,
    onApprovedWatchTogether,
    onRoomModeChanged,
    onRoomNameUpdated,
    autoJoin = true,
  } = options

  const setStoreMode = useRoomStore((state) => state.setMode)
  const setShareMethod = useRoomStore((state) => state.setShareMethod)
  const setStreamKey = useRoomStore((state) => state.setStreamKey)
  const resetRoomStore = useRoomStore((state) => state.reset)

  const [joinStatus, setJoinStatus] = useState<JoinStatus>('idle')
  const joinStatusRef = useRef(joinStatus)
  useEffect(() => {
    joinStatusRef.current = joinStatus
  }, [joinStatus])
  useEffect(
    () => () => {
      if (
        roomId &&
        (joinStatusRef.current === 'waiting' ||
          joinStatusRef.current === 'joining')
      ) {
        socket?.emit('room:join:cancel', { roomId })
      }
    },
    [socket, roomId]
  )
  const [joinError, setJoinError] = useState('')
  const [roomMode, setRoomMode] = useState<RoomMode | null>(null)
  const [connectionEpoch, setConnectionEpoch] = useState(0)

  const requestedRoomIdRef = useRef<string | null>(null)
  const hasJoinedRef = useRef(false)
  // Room passwords remain in this mounted room tree only, including transport
  // recovery. They must never enter storage, shared room state or public DTOs.
  const joinCredentialsRef = useRef<{
    roomId: string
    password: string
  } | null>(null)
  const roomScopeRef = useRef(roomId)
  const requestGenerationRef = useRef(0)
  const autoJoinSuppressedRef = useRef(false)
  const alreadyInRoomRetriesRef = useRef(0)
  const alreadyInRoomTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  )
  const requestJoinRef = useRef<
    (targetRoomId: string, password: string) => void
  >(() => {})
  const mountedRef = useRef(true)

  const clearAlreadyInRoomTimer = useCallback(() => {
    if (alreadyInRoomTimerRef.current) {
      clearTimeout(alreadyInRoomTimerRef.current)
      alreadyInRoomTimerRef.current = null
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      requestGenerationRef.current += 1
      joinCredentialsRef.current = null
      requestedRoomIdRef.current = null
      clearAlreadyInRoomTimer()
    }
  }, [clearAlreadyInRoomTimer])

  useEffect(() => {
    if (roomScopeRef.current === roomId) return
    roomScopeRef.current = roomId
    requestGenerationRef.current += 1
    joinCredentialsRef.current = null
    requestedRoomIdRef.current = null
    autoJoinSuppressedRef.current = false
    hasJoinedRef.current = false
    alreadyInRoomRetriesRef.current = 0
    clearAlreadyInRoomTimer()
    resetRoomStore()
    setJoinStatus('idle')
    setJoinError('')
    setRoomMode(null)
  }, [roomId, clearAlreadyInRoomTimer, resetRoomStore])

  // 用 ref 保存最新回调，避免回调变化导致事件订阅重建
  const callbacksRef = useRef({
    onApprovedScreenShare,
    onApprovedWatchTogether,
    onRoomModeChanged,
    onRoomNameUpdated,
  })
  useEffect(() => {
    callbacksRef.current = {
      onApprovedScreenShare,
      onApprovedWatchTogether,
      onRoomModeChanged,
      onRoomNameUpdated,
    }
  }, [
    onApprovedScreenShare,
    onApprovedWatchTogether,
    onRoomModeChanged,
    onRoomNameUpdated,
  ])

  const resetJoinState = useCallback(() => {
    requestGenerationRef.current += 1
    joinCredentialsRef.current = null
    autoJoinSuppressedRef.current = true
    clearAlreadyInRoomTimer()
    alreadyInRoomRetriesRef.current = 0
    setJoinStatus('idle')
    setJoinError('')
    setRoomMode(null)
    requestedRoomIdRef.current = null
    hasJoinedRef.current = false
  }, [clearAlreadyInRoomTimer])

  useEffect(() => {
    const handleTeardown = (event: Event) => {
      if ((event as CustomEvent<RoomMediaTeardownDetail>).detail?.full) {
        resetJoinState()
      }
    }
    window.addEventListener(ROOM_MEDIA_TEARDOWN_EVENT, handleTeardown)
    return () => {
      window.removeEventListener(ROOM_MEDIA_TEARDOWN_EVENT, handleTeardown)
    }
  }, [resetJoinState])

  const requestJoin = useCallback(
    (targetRoomId: string, password: string, nickname?: string) => {
      const previous = joinCredentialsRef.current
      if (previous?.roomId !== targetRoomId || previous.password !== password) {
        alreadyInRoomRetriesRef.current = 0
      }
      joinCredentialsRef.current = { roomId: targetRoomId, password }
      autoJoinSuppressedRef.current = false
      const generation = ++requestGenerationRef.current
      const roomScope = roomScopeRef.current
      clearAlreadyInRoomTimer()
      if (nickname) saveGuestNickname(nickname)
      if (!socket || !connected || !socket.connected) {
        requestedRoomIdRef.current = null
        setJoinError(
          t('Connection unavailable. Wait a moment, then try again.')
        )
        setJoinStatus('idle')
        return
      }

      const requestSocketId = socket.id
      requestedRoomIdRef.current = targetRoomId
      hasJoinedRef.current = false
      setJoinError('')
      setJoinStatus('joining')
      socket.emit(
        'request-join',
        {
          roomId: targetRoomId,
          password,
          nickname: nickname || getGuestNickname() || undefined,
        },
        (response: RequestJoinResponse) => {
          if (
            !mountedRef.current ||
            generation !== requestGenerationRef.current ||
            roomScope !== roomScopeRef.current ||
            requestedRoomIdRef.current !== targetRoomId ||
            !socket.connected ||
            socket.id !== requestSocketId
          )
            return
          if (response.success) {
            clearAlreadyInRoomTimer()
            alreadyInRoomRetriesRef.current = 0
            storeRoomMediaGrant(targetRoomId, response.data?.mediaGrant)
            // 房主身份恢复：后端检测到当前用户是房间 owner，已自动恢复房主身份。
            // 写入 sessionStorage 标记并刷新页面，让 RoomPage 重新以房主身份渲染。
            if (response.data?.isHost) {
              try {
                sessionStorage.setItem('zcontrol-host-room', targetRoomId)
              } catch {
                // ignore
              }
              message.success(t('Room ownership restored.'))
              // 刷新页面，触发 RoomPage 以房主身份重新渲染
              window.location.reload()
              return
            }

            // AckResponse 标准格式：mode 在 data 字段内
            const mode = response.data?.mode ?? 'screen-share'
            setRoomMode(mode)
            setStoreMode(mode)
            // 同步子模式与推流密钥（stream-push 子模式使用）
            if (response.data?.shareMethod) {
              setShareMethod(response.data.shareMethod)
            }
            if (response.data?.streamKey !== undefined) {
              setStreamKey(response.data.streamKey)
            }
            if (mode === 'watch-together') {
              if (response.message === '已加入房间') {
                hasJoinedRef.current = true
                useRoomStore.getState().setActiveRoomId(targetRoomId)
                setJoinStatus('approved')
                message.success(t('Joined the room.'))
                callbacksRef.current.onApprovedWatchTogether?.()
              } else {
                setJoinStatus('waiting')
              }
              return
            }
            if (response.message === '已加入房间') {
              hasJoinedRef.current = true
              useRoomStore.getState().setActiveRoomId(targetRoomId)
              setJoinStatus('approved')
              message.success(t('Joined the room.'))
              callbacksRef.current.onApprovedScreenShare?.()
            } else {
              setJoinStatus('waiting')
            }
          } else {
            setJoinError(roomErrorMessage(response.message, response.code))
            const isPasswordError = response.message === '密码错误'
            if (isPasswordError) {
              clearAlreadyInRoomTimer()
              alreadyInRoomRetriesRef.current = 0
              setJoinStatus('password-required')
              joinCredentialsRef.current = null
              autoJoinSuppressedRef.current = true
            } else if (response.code === 'ALREADY_IN_ROOM') {
              // 刷新/快速重进时旧 socket 的 session 可能尚未清理；有限
              // 重试后仍失败，才按真实的重复标签页处理。
              alreadyInRoomRetriesRef.current += 1
              if (alreadyInRoomRetriesRef.current <= 3) {
                clearAlreadyInRoomTimer()
                alreadyInRoomTimerRef.current = setTimeout(() => {
                  alreadyInRoomTimerRef.current = null
                  if (
                    !mountedRef.current ||
                    generation !== requestGenerationRef.current ||
                    roomScope !== roomScopeRef.current ||
                    !socket.connected
                  )
                    return
                  requestedRoomIdRef.current = null
                  requestJoinRef.current(targetRoomId, password)
                }, 1500)
                return
              }
              clearAlreadyInRoomTimer()
              alreadyInRoomRetriesRef.current = 0
              setJoinStatus('rejected')
            } else {
              clearAlreadyInRoomTimer()
              alreadyInRoomRetriesRef.current = 0
              setJoinStatus('idle')
            }
          }
        }
      )
    },
    [
      socket,
      connected,
      setStoreMode,
      setShareMethod,
      setStreamKey,
      clearAlreadyInRoomTimer,
    ]
  )

  useEffect(() => {
    requestJoinRef.current = requestJoin
  }, [requestJoin])

  // roomId 变化时自动加入房间（autoJoin=false 时跳过，等待手动 requestJoin）
  useEffect(() => {
    if (!socket || !connected || !roomId) return
    if (autoJoinSuppressedRef.current) return
    if (requestedRoomIdRef.current === roomId) return
    const credentials = joinCredentialsRef.current
    if (!autoJoin && credentials?.roomId !== roomId) return
    requestedRoomIdRef.current = roomId
    if (useAuthStore.getState().user?.role === 'guest' && !getGuestNickname())
      return
    const password = credentials?.roomId === roomId ? credentials.password : ''
    requestJoin(roomId, password)
  }, [
    socket,
    connected,
    connectionEpoch,
    roomId,
    requestJoin,
    autoJoin,
    clearAlreadyInRoomTimer,
  ])

  // Bug #3 修复：socket 断线重连后服务端分配新 socket.id，新 socket 不在任何房间内。
  // 监听 'connect' 事件重置 requestedRoomIdRef，触发上面的 effect 重新 requestJoin。
  // 同时重置 hasJoinedRef，让 join-approved 流程重新走完整。
  useEffect(() => {
    if (!socket) return
    const handleReconnect = () => {
      console.log('[useJoinRoom] socket reconnected, re-join room:', roomId)
      requestGenerationRef.current += 1
      clearAlreadyInRoomTimer()
      alreadyInRoomRetriesRef.current = 0
      requestedRoomIdRef.current = null
      hasJoinedRef.current = false
      setJoinStatus('idle')
      // A quick disconnect/connect can be batched before connected=false is
      // rendered. The connect event still needs one fresh room admission.
      setConnectionEpoch((epoch) => epoch + 1)
    }
    const handleDisconnect = () => {
      requestGenerationRef.current += 1
      clearAlreadyInRoomTimer()
      alreadyInRoomRetriesRef.current = 0
      requestedRoomIdRef.current = null
      hasJoinedRef.current = false
      setJoinStatus('idle')
    }
    socket.on('connect', handleReconnect)
    socket.on('disconnect', handleDisconnect)
    return () => {
      socket.off('connect', handleReconnect)
      socket.off('disconnect', handleDisconnect)
    }
  }, [socket, roomId, clearAlreadyInRoomTimer])

  // 事件订阅
  useEffect(() => {
    if (!socket) return

    const handleJoinApproved = (data: JoinApprovedPayload) => {
      if (
        !mountedRef.current ||
        !socket.connected ||
        autoJoinSuppressedRef.current ||
        data.roomId !== roomId ||
        requestedRoomIdRef.current !== data.roomId
      )
        return
      useRoomStore.getState().setActiveRoomId(data.roomId)
      storeRoomMediaGrant(data.roomId, data.mediaGrant)
      if (data.name) {
        callbacksRef.current.onRoomNameUpdated?.({
          roomId: data.roomId,
          name: data.name,
        })
      }
      const mode = data.mode ?? roomMode ?? 'screen-share'
      setRoomMode(mode)
      setStoreMode(mode)
      // 同步子模式与推流密钥（stream-push 子模式使用）
      if (data.shareMethod) {
        setShareMethod(data.shareMethod)
      }
      if (data.streamKey !== undefined) {
        setStreamKey(data.streamKey)
      }
      if (mode === 'watch-together') {
        if (hasJoinedRef.current) {
          setJoinStatus('approved')
          return
        }
        hasJoinedRef.current = true
        setJoinStatus('approved')
        message.success(
          t('You can now join room {value1}.', { value1: data.roomId })
        )
        callbacksRef.current.onApprovedWatchTogether?.()
        return
      }
      if (hasJoinedRef.current) {
        setJoinStatus('approved')
        return
      }
      hasJoinedRef.current = true
      setJoinStatus('approved')
      message.success(
        t('You can now join room {value1}.', { value1: data.roomId })
      )
      callbacksRef.current.onApprovedScreenShare?.()
    }

    const handleJoinRejected = (data: JoinRejectedPayload) => {
      if (
        !socket.connected ||
        data.roomId !== roomId ||
        requestedRoomIdRef.current !== data.roomId ||
        autoJoinSuppressedRef.current
      )
        return
      setJoinStatus('rejected')
      message.warning(
        t('The host declined your request to join room {value1}.', {
          value1: data.roomId,
        })
      )
    }

    const handleRoomNameUpdated = (data: { roomId: string; name: string }) => {
      if (data.roomId !== roomId) return
      callbacksRef.current.onRoomNameUpdated?.(data)
    }

    const handleRoomModeChanged = (data: RoomModeChangedPayload) => {
      if (!hasJoinedRef.current || !socket.connected) return
      setRoomMode(data.mode)
      setStoreMode(data.mode)
      callbacksRef.current.onRoomModeChanged?.(data)
    }

    socket.on('join-approved', handleJoinApproved)
    socket.on('join-rejected', handleJoinRejected)
    socket.on('room-name-updated', handleRoomNameUpdated)
    socket.on('room-mode-changed', handleRoomModeChanged)

    return () => {
      socket.off('join-approved', handleJoinApproved)
      socket.off('join-rejected', handleJoinRejected)
      socket.off('room-name-updated', handleRoomNameUpdated)
      socket.off('room-mode-changed', handleRoomModeChanged)
    }
  }, [
    socket,
    roomId,
    roomMode,
    joinStatus,
    setStoreMode,
    setShareMethod,
    setStreamKey,
  ])

  return {
    joinStatus,
    joinError,
    roomMode,
    requestJoin,
    resetJoinState,
  }
}
