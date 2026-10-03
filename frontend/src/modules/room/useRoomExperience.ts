import { useEffect } from 'react'
import type { Socket } from 'socket.io-client'
import { useRoomExperienceStore } from '@/store/roomExperienceStore'
import { useRoomStore } from '@/store/roomStore'
import type { RoomExperience } from './roomExperience'

export function useRoomExperience(
  roomId: string | undefined,
  socket: Socket | null
) {
  const snapshot = useRoomExperienceStore((state) => state.snapshot)
  useEffect(() => {
    if (!roomId || !socket) return
    const receive = (data: RoomExperience) => {
      if (data.roomId !== roomId) return
      useRoomExperienceStore.getState().setSnapshot(data)
      if (data.members) useRoomStore.getState().setViewers(data.members)
      if (data.name) useRoomStore.getState().setRoomName(data.name)
      useRoomStore
        .getState()
        .setMode(data.activity === 'screen' ? 'screen-share' : 'watch-together')
    }
    const refresh = () =>
      socket.emit(
        'room:experience:get',
        { roomId },
        (response: { success: boolean; data?: RoomExperience }) => {
          if (response.success && response.data) receive(response.data)
        }
      )
    socket.on('room:experience', receive)
    socket.on('join-approved', refresh)
    socket.on('sharer-ready', refresh)
    socket.on('host-transferred', refresh)
    socket.on('connect', refresh)
    refresh()
    return () => {
      socket.off('room:experience', receive)
      socket.off('join-approved', refresh)
      socket.off('sharer-ready', refresh)
      socket.off('host-transferred', refresh)
      socket.off('connect', refresh)
      if (useRoomExperienceStore.getState().snapshot?.roomId === roomId)
        useRoomExperienceStore.getState().setSnapshot(null)
    }
  }, [roomId, socket])
  return snapshot?.roomId === roomId ? snapshot : null
}
