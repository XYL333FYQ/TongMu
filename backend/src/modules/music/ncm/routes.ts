import { Router, type Request, type Response } from 'express';
import { authenticateToken, type AuthenticatedRequest } from '../../../middleware/auth';
import { redactMediaError, redactSensitiveValue } from '../../../services/media/redact';
import { isMusicQuality } from '../music-provider';
import { musicPlaybackService, type MusicResolveRequest } from './music-playback.service';
import { ncmCredentialService } from './ncm-credential.service';
import { ncmLoginService } from './ncm-login.service';
import { NcmProviderError, type NcmQrSessionDto } from './types';
import type { NcmLoginService } from './ncm-login.service';
import type { MusicPlaybackService } from './music-playback.service';
import type { NcmCredentialService } from './ncm-credential.service';

const SESSION_ID_RE = /^[0-9a-f-]{20,64}$/i;
const ROOM_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const SOURCE_REF_RE = /^music:\/\/ncm\/track\/[1-9][0-9]{0,19}$/;

function errorPayload(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof NcmProviderError) {
    return {
      status: error.status,
      body: {
        success: false,
        code: error.code,
        message: error.message,
        ...(error.details ? { details: redactSensitiveValue(error.details) } : {}),
      },
    };
  }
  return {
    status: 500,
    body: { success: false, code: 'NCM_UPSTREAM_ERROR', message: '网易云音乐服务暂不可用' },
  };
}

function sendError(res: Response, error: unknown): void {
  const payload = errorPayload(error);
  res.status(payload.status).json(payload.body);
}

function userIdOf(req: AuthenticatedRequest): number {
  const value = req.user?.userId;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function bodyRecord(req: Request): Record<string, unknown> | null {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : null;
}

function resolveRequest(req: Request): MusicResolveRequest | null {
  const body = bodyRecord(req);
  if (!body || typeof body.roomId !== 'string' || !ROOM_ID_RE.test(body.roomId) ||
      typeof body.roomGrant !== 'string' || body.roomGrant.length < 20 || body.roomGrant.length > 8192 ||
      typeof body.queueItemId !== 'number' || !Number.isSafeInteger(body.queueItemId) || body.queueItemId <= 0 ||
      typeof body.sourceRef !== 'string' || !SOURCE_REF_RE.test(body.sourceRef) ||
      typeof body.musicGeneration !== 'number' || !Number.isSafeInteger(body.musicGeneration) || body.musicGeneration < 0 ||
      !isMusicQuality(body.requestedQuality)) return null;
  return {
    roomId: body.roomId,
    roomGrant: body.roomGrant,
    queueItemId: body.queueItemId,
    sourceRef: body.sourceRef,
    musicGeneration: body.musicGeneration,
    requestedQuality: body.requestedQuality,
  };
}

/** NCM login/status/resolve/playback routes; no arbitrary upstream forwarding. */
export interface NcmMusicRouterDependencies {
  credentials?: NcmCredentialService;
  login?: NcmLoginService;
  playback?: MusicPlaybackService;
}

export function createNcmMusicRouter(dependencies: NcmMusicRouterDependencies = {}): Router {
  const credentials = dependencies.credentials || ncmCredentialService;
  const login = dependencies.login || ncmLoginService;
  const playbackService = dependencies.playback || musicPlaybackService;
  const router = Router();

  router.get('/ncm/status', authenticateToken, async (req: AuthenticatedRequest, res) => {
    try {
      res.json({ success: true, ...(await credentials.getStatus(userIdOf(req))) });
    } catch (error) {
      console.error('[music:ncm] status error:', redactMediaError(error));
      sendError(res, error);
    }
  });

  router.get('/ncm/login/qr', authenticateToken, async (req: AuthenticatedRequest, res) => {
    const userId = userIdOf(req);
    if (!userId) {
      res.status(403).json({ success: false, code: 'MUSIC_ROOM_FORBIDDEN', message: '游客不能保存网易云登录凭据' });
      return;
    }
    try {
      res.json({ success: true, ...(await login.createQr(userId)) });
    } catch (error) {
      console.error('[music:ncm] qr create error:', redactMediaError(error));
      sendError(res, error);
    }
  });

  router.get('/ncm/login/qr/:sessionId', authenticateToken, async (req: AuthenticatedRequest, res) => {
    const userId = userIdOf(req);
    const sessionId = typeof req.params.sessionId === 'string' ? req.params.sessionId : '';
    if (!userId || !SESSION_ID_RE.test(sessionId)) {
      res.status(404).json({ success: false, code: 'NCM_QR_SESSION_NOT_FOUND', message: '二维码会话不存在' });
      return;
    }
    try {
      const status: NcmQrSessionDto = await login.pollQr(userId, sessionId);
      res.json({ success: true, ...status });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/ncm/logout', authenticateToken, async (req: AuthenticatedRequest, res) => {
    const userId = userIdOf(req);
    if (!userId) {
      res.json({ success: true, loggedIn: false });
      return;
    }
    try {
      await login.logout(userId);
      res.json({ success: true, loggedIn: false });
    } catch (error) {
      console.error('[music:ncm] logout error:', redactMediaError(error));
      sendError(res, error);
    }
  });

  router.post('/resolve', async (req, res) => {
    const request = resolveRequest(req);
    if (!request) {
      res.status(400).json({ success: false, code: 'MUSIC_INVALID_REQUEST', message: '音乐解析请求无效' });
      return;
    }
    try {
      res.json({ success: true, ...(await playbackService.resolve(request)) });
    } catch (error) {
      sendError(res, error);
    }
  });

  const playbackHandler = async (req: Request, res: Response): Promise<void> => {
    const token = typeof req.params.id === 'string' ? req.params.id : '';
    const roomGrant = typeof req.query.roomGrant === 'string' ? req.query.roomGrant : undefined;
    if (!token || token.length > 8192) {
      res.status(403).json({ success: false, code: 'MUSIC_CAPABILITY_INVALID', message: '音乐播放授权无效或已过期' });
      return;
    }
    try {
      await playbackService.proxy(req, res, token, roomGrant);
    } catch (error) {
      sendError(res, error);
    }
  };

  router.get('/playback/:id', playbackHandler);
  router.head('/playback/:id', playbackHandler);
  return router;
}
