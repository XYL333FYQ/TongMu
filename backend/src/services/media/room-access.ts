import { IsNull } from 'typeorm';
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
