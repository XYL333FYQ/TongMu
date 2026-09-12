import { IsNull, type Repository } from 'typeorm';
import { AppDataSource } from '../../data-source';
import { Session } from '../../entities/Session';
import {
  issueRoomMediaGrant,
  resolveRoomMediaGrant,
  type RoomMediaGrant,
} from './handles';

export function createRoomMediaGrant(roomId: string, socketId: string): string {
  return issueRoomMediaGrant(roomId, socketId);
}

/**
 * A process restart cannot preserve a live Socket.IO connection. Close every
 * database session that was still marked active before accepting new requests,
 * so persisted room grants cannot survive a crash and restart.
 */
export async function cleanupStaleRoomSessions(
  sessionRepo: Pick<Repository<Session>, 'update'> = AppDataSource.getRepository(Session),
): Promise<number> {
  const result = await sessionRepo.update(
    { endedAt: IsNull() },
    { endedAt: new Date() },
  );
  return result.affected ?? 0;
}

/**
 * Verify both the encrypted capability and current room membership. The
 * Session lookup is authoritative: leaving, disconnecting or being kicked
 * sets endedAt and revokes the capability immediately, including for guests.
 */
export async function authorizeRoomMediaGrant(
  token: string | undefined,
  expectedRoomId?: string,
  isActive: (roomId: string, socketId: string) => Promise<boolean> = async (roomId, socketId) => {
    const session = await AppDataSource.getRepository(Session).findOneBy({
      roomId,
      socketId,
      endedAt: IsNull(),
    });
    return !!session;
  },
): Promise<RoomMediaGrant | undefined> {
  if (!token) return undefined;
  const grant = resolveRoomMediaGrant(token);
  if (!grant || (expectedRoomId && grant.roomId !== expectedRoomId)) return undefined;
  return (await isActive(grant.roomId, grant.socketId)) ? grant : undefined;
}
