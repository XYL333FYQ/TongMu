import { Router, type Response, type NextFunction } from 'express';
import type { Server } from 'socket.io';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AppDataSource } from '../data-source';
import { Room } from '../entities/Room';
import { User } from '../entities/User';
import type { AuthenticatedRequest } from '../middleware/auth';
import { ROOM_COVERS_DIR } from '../services/paths';
import { realtimeSyncCore } from '../modules/realtime-sync-core';
import { roomExperienceService } from '../modules/room/room-experience.service';
import { getRoomCover, roomCoverExtension, withRoomCover, removeStoredRoomCover } from '../modules/room/room-cover';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0 },
  fileFilter: (_req, file, done) => {
    if (['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype)) done(null, true);
    else done(new Error('Use a JPG, PNG or WebP image.'));
  },
}).single('cover');

async function canManageCover(req: AuthenticatedRequest, room: Room): Promise<boolean> {
  if (!req.user || req.user.role === 'guest' || req.user.userId <= 0) return false;
  const user = await AppDataSource.getRepository(User).findOneBy({ id: req.user.userId });
  return !!user && user.status === 'active' && (user.role === 'root' || user.role === 'admin' || room.ownerUserId === user.id);
}

export function createRoomCoverRouter(io: Server): Router {
  const router = Router();
  const authorize = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const room = await AppDataSource.getRepository(Room).findOneBy({ roomId: req.params.roomId as string, status: 'active' });
      if (!room) { res.status(404).json({ success: false, message: 'This room could not be found.' }); return; }
      if (!(await canManageCover(req, room))) { res.status(403).json({ success: false, message: 'You do not have permission to change the room cover.' }); return; }
      next();
    } catch {
      res.status(500).json({ success: false, message: 'Could not update the room cover. Try again.' });
    }
  };
  const updateCover = async (req: AuthenticatedRequest, res: Response, replacing: boolean) => {
    let newUrl: string | null = null;
    try {
      const extension = replacing && req.file ? roomCoverExtension(req.file.buffer, req.file.mimetype) : null;
      if (replacing && !extension) { res.status(400).json({ success: false, message: 'Use a valid JPG, PNG or WebP image.' }); return; }
      await realtimeSyncCore.withRoomLock(req.params.roomId as string, async () => {
        const rooms = AppDataSource.getRepository(Room);
        const room = await rooms.findOneBy({ roomId: req.params.roomId as string, status: 'active' });
        if (!room) { res.status(404).json({ success: false, message: 'This room could not be found.' }); return; }
        // Recheck ownership and the live platform role after queued work.
        if (!(await canManageCover(req, room))) { res.status(403).json({ success: false, message: 'You do not have permission to change the room cover.' }); return; }
        const previous = getRoomCover(room.policyJson);
        if (replacing) {
          const filename = `${randomUUID()}.${extension}`;
          await fs.mkdir(ROOM_COVERS_DIR, { recursive: true });
          await fs.writeFile(path.join(ROOM_COVERS_DIR, filename), req.file!.buffer, { flag: 'wx' });
          newUrl = `/uploads/room-covers/${filename}`;
        }
        await rooms.update({ roomId: room.roomId }, { policyJson: withRoomCover(room.policyJson, newUrl) });
        const savedUrl = newUrl;
        newUrl = null; // A committed file must survive a later broadcast failure.
        await removeStoredRoomCover(previous);
        await roomExperienceService.broadcast(io, room.roomId);
        res.json({ success: true, coverUrl: savedUrl });
      });
    } catch {
      await removeStoredRoomCover(newUrl);
      if (!res.headersSent) res.status(500).json({ success: false, message: 'Could not update the room cover. Try again.' });
    }
  };

  // The parent room router has already authenticated the request.
  router.post('/:roomId/cover', authorize, (req: AuthenticatedRequest, res, next) => {
    upload(req, res, error => {
      if (error) {
        res.status(400).json({ success: false, message: error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE'
          ? 'Choose an image smaller than 5 MB.' : 'Use a JPG, PNG or WebP image.' });
        return;
      }
      next();
    });
  }, (req, res) => updateCover(req, res, true));
  router.delete('/:roomId/cover', authorize, (req, res) => updateCover(req, res, false));
  return router;
}
