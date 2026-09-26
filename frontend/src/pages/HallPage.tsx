import { useAuthStore } from '@/store/authStore'
import { useRoomDirectory } from '@/hooks/useRoomDirectory'
import HomePage from './HomePage'
import RoomsListPage from './RoomsListPage'

/** Both routes use one hall data source while keeping their own presentation. */
export default function HallPage({ mode }: { mode: 'home' | 'discover' }) {
  const { authResolved, isAuthenticated, user } = useAuthStore()
  const directory = useRoomDirectory(authResolved, isAuthenticated, user?.id)

  return (
    <div className={`tongmu-hall tongmu-hall--${mode}`}>
      {mode === 'home' ? (
        <HomePage directory={directory} />
      ) : (
        <RoomsListPage directory={directory} />
      )}
    </div>
  )
}
