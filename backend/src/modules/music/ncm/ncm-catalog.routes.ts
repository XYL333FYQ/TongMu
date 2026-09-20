import { Router, type Request, type Response } from 'express';
import { authenticateToken, type AuthenticatedRequest } from '../../../middleware/auth';
import { redactMediaError } from '../../../services/media/redact';
import { logger } from '../../../observability';
import { NcmProviderError } from './types';
import { ncmCatalogService, NcmCatalogService } from './ncm-catalog.service';
import type {
  NcmCatalogCommentInput,
  NcmCatalogCommentLikeInput,
  NcmCatalogPageInput,
  NcmCatalogSearchInput,
} from './ncm-catalog.service';

const ID_RE = /^[1-9][0-9]{0,19}$/;
const USER_ID_MAX = 2_147_483_647;

function errorPayload(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof NcmProviderError) {
    return {
      status: error.status,
      body: {
        success: false,
        code: error.code,
        message: error.message,
      },
    };
  }
  return { status: 502, body: { success: false, code: 'NCM_UPSTREAM_ERROR', message: '网易云音乐服务暂不可用' } };
}

function sendError(res: Response, error: unknown): void {
  const payload = errorPayload(error);
  logger.error('music-ncm-catalog', 'request_failed', { error });
  res.status(payload.status).json(payload.body);
}

function userIdOf(req: AuthenticatedRequest): number {
  const value = req.user?.userId;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= USER_ID_MAX ? value : 0;
}

function queryString(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === 'string' ? value : undefined;
}

function parsePage(req: Request): NcmCatalogPageInput {
  const limitValue = queryString(req, 'pageSize') ?? queryString(req, 'limit') ?? '20';
  const limit = Number(limitValue);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new NcmProviderError('MUSIC_INVALID_REQUEST', '分页大小无效', 400);
  }
  const offsetValue = queryString(req, 'offset');
  if (offsetValue !== undefined) {
    const offset = Number(offsetValue);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) {
      throw new NcmProviderError('MUSIC_INVALID_REQUEST', '分页位置无效', 400);
    }
    return { offset, limit };
  }
  const pageValue = queryString(req, 'page');
  if (pageValue === undefined) return { offset: 0, limit };
  const page = Number(pageValue);
  if (!Number.isSafeInteger(page) || page < 1 || page > 2_001) {
    throw new NcmProviderError('MUSIC_INVALID_REQUEST', '页码无效', 400);
  }
  const offset = (page - 1) * limit;
  if (offset > 100_000) throw new NcmProviderError('MUSIC_INVALID_REQUEST', '页码超出限制', 400);
  return { offset, limit };
}

function positiveId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    throw new NcmProviderError('MUSIC_INVALID_REQUEST', `${label} ID 无效`, 400);
  }
  return value;
}

function bodyRecord(req: Request): Record<string, unknown> {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {};
}

function requestSignal(req: Request): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  req.once('aborted', onAbort);
  req.once('close', onAbort);
  return {
    signal: controller.signal,
    cleanup: () => {
      req.off('aborted', onAbort);
      req.off('close', onAbort);
    },
  };
}

async function withRequestSignal<T>(req: Request, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const request = requestSignal(req);
  try {
    return await operation(request.signal);
  } finally {
    request.cleanup();
  }
}

function sendData(res: Response, value: Record<string, unknown>): void {
  res.json({ success: true, ...value });
}

function isSearchType(value: unknown): value is NcmCatalogSearchInput['type'] {
  return value === 'song' || value === 'playlist' || value === 'album' || value === 'artist';
}

function isResourceType(value: unknown): value is NcmCatalogCommentInput['resourceType'] {
  return value === 'song' || value === 'playlist' || value === 'album';
}

function isCommentMode(value: unknown): value is 'hot' | 'latest' {
  return value === 'hot' || value === 'latest';
}

export function createNcmCatalogRouter(catalog: NcmCatalogService = ncmCatalogService): Router {
  const router = Router();

  const search = async (req: Request, res: Response): Promise<void> => {
    try {
      const type = queryString(req, 'type') || 'song';
      const input: NcmCatalogSearchInput = {
        query: queryString(req, 'query') ?? queryString(req, 'keywords') ?? '',
        type: isSearchType(type) ? type : (() => { throw new NcmProviderError('MUSIC_INVALID_REQUEST', '搜索类型无效', 400); })(),
        ...parsePage(req),
      };
      sendData(res, await withRequestSignal(req, (signal) => catalog.search(input, signal)) as unknown as Record<string, unknown>);
    } catch (error) {
      sendError(res, error);
    }
  };
  router.get('/ncm/search', search);
  router.get('/ncm/catalog/search', search);

  const playlist = async (req: Request, res: Response): Promise<void> => {
    try {
      const result = await withRequestSignal(req, (signal) => catalog.getPlaylist(positiveId(req.params.playlistId, '歌单'), parsePage(req), signal));
      sendData(res, result as unknown as Record<string, unknown>);
    } catch (error) {
      sendError(res, error);
    }
  };
  router.get('/ncm/playlist/:playlistId', playlist);

  router.get('/ncm/album/:albumId', async (req, res) => {
    try {
      const result = await withRequestSignal(req, (signal) => catalog.getAlbum(positiveId(req.params.albumId, '专辑'), signal));
      sendData(res, result as unknown as Record<string, unknown>);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/ncm/artist/:artistId', async (req, res) => {
    try {
      const result = await withRequestSignal(req, (signal) => catalog.getArtist(positiveId(req.params.artistId, '歌手'), parsePage(req), signal));
      sendData(res, result as unknown as Record<string, unknown>);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/ncm/lyrics/:trackId', async (req, res) => {
    try {
      const result = await withRequestSignal(req, (signal) => catalog.getLyrics(positiveId(req.params.trackId, '歌词'), signal));
      sendData(res, result as unknown as Record<string, unknown>);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/ncm/comments/:resourceType/:resourceId', async (req, res) => {
    try {
      const resourceType = req.params.resourceType;
      if (!isResourceType(resourceType)) throw new NcmProviderError('MUSIC_INVALID_REQUEST', '评论资源类型无效', 400);
      const modeValue = queryString(req, 'mode') || 'latest';
      if (!isCommentMode(modeValue)) throw new NcmProviderError('MUSIC_INVALID_REQUEST', '评论排序方式无效', 400);
      const input: NcmCatalogCommentInput = {
        resourceType,
        resourceId: positiveId(req.params.resourceId, '评论资源'),
        mode: modeValue,
        ...parsePage(req),
      };
      const result = await withRequestSignal(req, (signal) => catalog.getComments(input, undefined, signal));
      sendData(res, result as unknown as Record<string, unknown>);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/ncm/playlists', authenticateToken, async (req: AuthenticatedRequest, res) => {
    try {
      sendData(res, await withRequestSignal(req, (signal) => catalog.getPlaylists(userIdOf(req), parsePage(req), signal)) as unknown as Record<string, unknown>);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/ncm/liked', authenticateToken, async (req: AuthenticatedRequest, res) => {
    try {
      sendData(res, await withRequestSignal(req, (signal) => catalog.getLiked(userIdOf(req), parsePage(req), signal)) as unknown as Record<string, unknown>);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/ncm/fm', authenticateToken, async (req: AuthenticatedRequest, res) => {
    try {
      sendData(res, await withRequestSignal(req, (signal) => catalog.getFm(userIdOf(req), signal)) as unknown as Record<string, unknown>);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/ncm/fm/dislike', authenticateToken, async (req: AuthenticatedRequest, res) => {
    try {
      const result = await withRequestSignal(req, (signal) => catalog.dislikeFm(userIdOf(req), positiveId(bodyRecord(req).trackId, 'FM 歌曲'), signal));
      sendData(res, result as unknown as Record<string, unknown>);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/ncm/cloud', authenticateToken, async (req: AuthenticatedRequest, res) => {
    try {
      sendData(res, await withRequestSignal(req, (signal) => catalog.getCloud(userIdOf(req), parsePage(req), signal)) as unknown as Record<string, unknown>);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/ncm/like', authenticateToken, async (req: AuthenticatedRequest, res) => {
    try {
      const body = bodyRecord(req);
      if (typeof body.liked !== 'boolean') throw new NcmProviderError('MUSIC_INVALID_REQUEST', '歌曲点赞状态无效', 400);
      const result = await withRequestSignal(req, (signal) => catalog.likeTrack(userIdOf(req), positiveId(body.trackId, '歌曲'), body.liked as boolean, signal));
      sendData(res, result as unknown as Record<string, unknown>);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/ncm/comment-like', authenticateToken, async (req: AuthenticatedRequest, res) => {
    try {
      const body = bodyRecord(req);
      if (!isResourceType(body.resourceType) || typeof body.liked !== 'boolean') {
        throw new NcmProviderError('MUSIC_INVALID_REQUEST', '评论点赞请求无效', 400);
      }
      const input: NcmCatalogCommentLikeInput = {
        resourceType: body.resourceType,
        resourceId: positiveId(body.resourceId, '评论资源'),
        commentId: positiveId(body.commentId, '评论'),
        liked: body.liked,
      };
      const result = await withRequestSignal(req, (signal) => catalog.likeComment(userIdOf(req), input, signal));
      sendData(res, result as unknown as Record<string, unknown>);
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
