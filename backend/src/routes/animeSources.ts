import { Router, Response } from 'express';
import {
  authenticateToken,
  AuthenticatedRequest,
} from '../middleware/auth';
import {
  listAnimeSources,
  getAnimeProvider,
  AnimeEpisode,
} from '../services/anime';
import { proxyHttpUpstream } from '../services/proxy';
import {
  buildAnimeProviderReference,
  sanitizeAnimePlaybackParams,
} from '../services/media/providers/anime-provider';
import { createAnimeRouteRequestContext } from './anime-request-context';

const router = Router();

router.use(authenticateToken);

/**
 * 通用媒体代理：转发带防盗链的视频流。
 * 查询参数：
 *   url       必填，目标视频地址
 *   referer   可选，自定义 Referer
 *   userAgent 可选，自定义 User-Agent
 *   origin    可选，自定义 Origin
 */
router.get('/proxy', async (req: AuthenticatedRequest, res: Response) => {
  const url = req.query.url;
  const referer = req.query.referer;
  const userAgent = req.query.userAgent;
  const origin = req.query.origin;

  if (typeof url !== 'string' || !url.trim()) {
    res.status(400).json({ success: false, message: '缺少 url 参数' });
    return;
  }

  await proxyHttpUpstream(req, res, {
    url: url.trim(),
    targetPolicy: 'public-only',
    headers: {
      userAgent: typeof userAgent === 'string' ? userAgent : undefined,
      referer: typeof referer === 'string' ? referer : undefined,
      origin: typeof origin === 'string' ? origin : undefined,
    },
    cors: 'wildcard',
    logTag: 'animeSources',
    errorMessage: '代理媒体失败',
  });
});

// 列出可用番剧数据源
router.get('/sources', async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const sources = await listAnimeSources();
    res.json({ success: true, sources });
  } catch (err) {
    console.error('[animeSources] list sources error:', err);
    res.status(500).json({ success: false, message: '获取番剧数据源列表失败' });
  }
});

// 搜索番剧
router.get('/search', async (req: AuthenticatedRequest, res: Response) => {
  const source = req.query.source;
  const keyword = req.query.keyword;

  if (typeof source !== 'string' || !source.trim()) {
    res.status(400).json({ success: false, message: '缺少 source 参数' });
    return;
  }
  if (typeof keyword !== 'string' || !keyword.trim()) {
    res.status(400).json({ success: false, message: '缺少 keyword 参数' });
    return;
  }

  const provider = await getAnimeProvider(source.trim());
  if (!provider) {
    res.status(400).json({ success: false, message: '未知的番剧数据源' });
    return;
  }

  const requestContext = createAnimeRouteRequestContext(req);
  try {
    const results = await provider.search(keyword.trim(), requestContext);
    res.json({ success: true, results });
  } catch (err) {
    console.error('[animeSources] search error:', err);
    res.status(502).json({
      success: false,
      message: err instanceof Error ? err.message : '搜索番剧数据源失败',
    });
  } finally {
    requestContext.cleanup();
  }
});

// 获取集数列表
router.get('/episodes', async (req: AuthenticatedRequest, res: Response) => {
  const source = req.query.source;
  const identifier = req.query.identifier;

  if (typeof source !== 'string' || !source.trim()) {
    res.status(400).json({ success: false, message: '缺少 source 参数' });
    return;
  }
  if (typeof identifier !== 'string' || !identifier.trim()) {
    res.status(400).json({ success: false, message: '缺少 identifier 参数' });
    return;
  }

  const provider = await getAnimeProvider(source.trim());
  if (!provider) {
    res.status(400).json({ success: false, message: '未知的番剧数据源' });
    return;
  }

  const requestContext = createAnimeRouteRequestContext(req);
  try {
    const episodes = await provider.getEpisodes(identifier.trim(), requestContext);
    res.json({
      success: true,
      episodes: episodes.map((episode) => ({
        ...episode,
        playbackParams: sanitizeAnimePlaybackParams(episode.playbackParams),
      })),
    });
  } catch (err) {
    console.error('[animeSources] episodes error:', err);
    res.status(502).json({
      success: false,
      message: err instanceof Error ? err.message : '获取集数列表失败',
    });
  } finally {
    requestContext.cleanup();
  }
});

// 解析播放地址
router.post('/resolve', async (req: AuthenticatedRequest, res: Response) => {
  const source = req.body.source;
  const episode = req.body.episode;

  if (typeof source !== 'string' || !source.trim()) {
    res.status(400).json({ success: false, message: '缺少 source 参数' });
    return;
  }
  if (!episode || typeof episode !== 'object') {
    res.status(400).json({ success: false, message: '缺少 episode 参数' });
    return;
  }

  const provider = await getAnimeProvider(source.trim());
  if (!provider) {
    res.status(400).json({ success: false, message: '未知的番剧数据源' });
    return;
  }

  const normalized: AnimeEpisode = {
    id: String(episode.id ?? ''),
    title: String(episode.title ?? ''),
    episodeNumber: Number(episode.episodeNumber) || 1,
    playbackParams:
      episode.playbackParams && typeof episode.playbackParams === 'object'
        ? (episode.playbackParams as Record<string, unknown>)
        : {},
  };

  res.json({
    success: true,
    sourceReference: buildAnimeProviderReference('anime', source.trim(), normalized),
    message: '播放地址由统一 Media Core 在实际播放时解析',
  });
});

export default router;
