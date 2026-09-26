// Register before BrowserRouter mounts so room Back can be intercepted before
// React Router unmounts the room and its media components.
type RoomBackState = {
  handler: ((event: PopStateEvent) => void) | null
  installed: boolean
}

const roomBackState: RoomBackState = (() => {
  if (typeof window === 'undefined') return { handler: null, installed: false }
  const browserWindow = window as Window & {
    __tongmuRoomBackState?: RoomBackState
  }
  return (browserWindow.__tongmuRoomBackState ??= {
    handler: null,
    installed: false,
  })
})()

if (typeof window !== 'undefined' && !roomBackState.installed) {
  const dispatchRoomBack = (event: PopStateEvent) =>
    roomBackState.handler?.(event)
  window.addEventListener('popstate', dispatchRoomBack, true)
  roomBackState.installed = true
}

export function setRoomBackHandler(handler: (event: PopStateEvent) => void) {
  roomBackState.handler = handler
  return () => {
    if (roomBackState.handler === handler) roomBackState.handler = null
  }
}
