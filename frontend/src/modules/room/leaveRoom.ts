import type { Socket } from 'socket.io-client'
import { useRoomStore } from '@/store/roomStore'
import { useRoomExperienceStore } from '@/store/roomExperienceStore'
import { dispatchRoomMediaTeardown } from '@/lib/mediaTeardown'
import { roomErrorMessage } from './roomErrors'

export async function leaveCurrentRoom(socket: Socket | null): Promise<void> {
  const roomId = useRoomStore.getState().activeRoomId
  if (!roomId) return
  if (socket?.connected) {
    await new Promise<void>((resolve, reject) => {
      socket
        .timeout(6000)
        .emit(
          'room:leave',
          { roomId },
          (
            error: Error | null,
            response: { success: boolean; message?: string }
          ) => {
            if (error)
              reject(
                new Error('The server did not respond. Try leaving again.')
              )
            else if (response?.success) resolve()
            else reject(new Error(roomErrorMessage(response?.message)))
          }
        )
    })
  }
  dispatchRoomMediaTeardown(true)
  useRoomStore.getState().exitRoom()
  useRoomExperienceStore.getState().setSnapshot(null)
  useRoomExperienceStore.getState().setLocalMuted(false)
  try {
    if (sessionStorage.getItem('zcontrol-host-room') === roomId)
      sessionStorage.removeItem('zcontrol-host-room')
  } catch {
    /* Ownership remains durable. */
  }
}
