import type { Server as SocketIOServer } from 'socket.io';

/**
 * Targeted emission always checks Socket.IO room membership first. The caller
 * supplies the domain relationship check (pending request, active session,
 * etc.); a client-provided socket id is never sufficient on its own.
 */
export async function emitToAuthorizedMember(
  io: SocketIOServer,
  roomId: string,
  targetSocketId: string,
  event: string,
  payload: unknown,
  isAuthorized: (target: import('socket.io').Socket) => Promise<boolean> | boolean,
): Promise<boolean> {
  const target = io.sockets.sockets.get(targetSocketId);
  if (!target || !target.connected || !target.rooms.has(roomId)) return false;
  if (!(await isAuthorized(target))) return false;
  io.to(targetSocketId).emit(event, payload);
  return true;
}

