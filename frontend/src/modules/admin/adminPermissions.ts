import type { UserRole } from '@/store/authStore'

/** Mirrors the existing DELETE /api/admin/rooms/:roomId guard for UI affordances. */
export function canCloseAdminRoom(
  role: UserRole | undefined,
  userId: string | undefined,
  ownerUserId: number | null
): boolean {
  if (role === 'root') return true
  return (
    role === 'admin' && ownerUserId !== null && String(ownerUserId) === userId
  )
}
