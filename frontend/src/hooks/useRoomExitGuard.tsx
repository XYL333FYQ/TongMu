import { useNavigate } from 'react-router-dom'

// Ordinary navigation keeps the room alive. RoomRuntime asks before changing rooms.
export function useRoomExitGuard() {
  const navigate = useNavigate()
  return {
    guardNavigate: (path: string) => navigate(path),
    confirmModal: null,
    needsGuard: false,
  }
}
