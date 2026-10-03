import type { Viewer } from '@/store/roomStore'

export type RoomActivity = 'watch' | 'listen' | 'screen'
export interface RoomPolicy {
  visibility: 'public' | 'private'
  lifetime: 'temporary' | 'persistent'
  allowGuests: boolean
  guestCollaboration: boolean
  collaboration: 'host' | 'shared'
  showContentTitle: boolean
  permissions: Partial<
    Record<
      'selectContent' | 'playback' | 'switchActivity' | 'screenShare',
      boolean
    >
  >
}
export const defaultRoomPolicy: RoomPolicy = {
  visibility: 'public',
  lifetime: 'temporary',
  allowGuests: true,
  guestCollaboration: false,
  collaboration: 'host',
  showContentTitle: false,
  permissions: {},
}
export interface RoomExperience {
  roomId: string
  name: string | null
  coverUrl?: string | null
  activity: RoomActivity
  policy: RoomPolicy
  hasPassword: boolean
  maxViewers: number
  requireApproval: boolean
  isDelegate: boolean
  screenPresenter: string | null
  members?: Viewer[]
  joinRequests: { socketId: string; username: string }[]
  permissions: Record<
    | 'selectContent'
    | 'playback'
    | 'switchActivity'
    | 'screenShare'
    | 'settings'
    | 'manageMembers',
    boolean
  >
  host: { socketId: string | null; userId: number | null; online: boolean }
  requests: {
    id: string
    activity: RoomActivity
    username: string
    createdAt: number
  }[]
  suggestions: {
    id: string
    title: string
    username: string
    createdAt: number
  }[]
  poll: {
    id: string
    activity: RoomActivity
    username: string
    expiresAt: number
    ended: boolean
    yes: number
    no: number
    ownVote: boolean | null
  } | null
}
