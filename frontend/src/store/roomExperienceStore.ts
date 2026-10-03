import { create } from 'zustand'
import type { RoomExperience } from '@/modules/room/roomExperience'

export const useRoomExperienceStore = create<{
  snapshot: RoomExperience | null
  localMuted: boolean
  setSnapshot: (snapshot: RoomExperience | null) => void
  setLocalMuted: (muted: boolean) => void
}>((set) => ({
  snapshot: null,
  localMuted: false,
  setSnapshot: (snapshot) => set({ snapshot }),
  setLocalMuted: (localMuted) => set({ localMuted }),
}))
