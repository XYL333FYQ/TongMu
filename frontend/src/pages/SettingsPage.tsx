import { Navigate } from 'react-router-dom'
import { useAuthStore } from '@/store/authStore'

/** Preserve old bookmarks while controls live at their real destinations. */
export default function SettingsPage() {
  const { user, authResolved } = useAuthStore()
  if (!authResolved) return null
  return (
    <Navigate
      to={user && user.role !== 'guest' ? '/profile#preferences' : '/'}
      replace
    />
  )
}
