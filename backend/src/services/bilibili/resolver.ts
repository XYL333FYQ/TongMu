import { fetchWithProxyPolicyDetailed } from '../proxy/safe-fetch';
/**
 * B站 视频解析独立编排模块。
 *
 * 分离架构核心：
 * - 路由层（stream.ts）只负责 HTTP 参数解析与 NDJSON 输出，不感知解析细节。
 * - 本模块对外暴露 resolveBilibiliVideo，封装完整解析流程：VIP 校验、视频信息、播放地址、清晰度匹配、CDN 选择、MP4 降级。
 * - 信号源层（video/playurl/vip）保持单一职责；本模块负责编排与错误归一。
 *
 * 效率优化：
 * - VIP 校验与视频信息获取并行（无依赖），节省 1 个 RTT。
 * - 视频信息短期缓存，重复解析同一 BV 号时跳过 nav/view 调用。
 * - CDN 健康检查使用 race 模式，先返回的可达 URL 立即采用。
 */

import { getVideoInfo, type BilibiliVideoInfo } from './video';
import {
  getPlayUrl,
  NoPermissionError,
} from './playurl';
import {
  getVipStatus,
  VIP_ONLY_QNS,
  QN_QUALITY_MAP,
} from './permission';
import { findReachableMediaUrl, upgradeBilibiliUrlToHttps } from './cdn';
import {
  getCachedVideoInfo,
  setCachedVideoInfo,
} from './cache';
import { redactMediaError, redactMediaUrl } from '../media/redact';
import type { PlaybackClientProfileV1 } from '../media/playback-profile';

export interface ResolveProgress {
  status: 'parsing' | 'done' | 'error';
  step?: string;
  message?: string;
}

/**
 * B站 MP4 直链（fnval=1 + platform=html5 + high_quality=1）实际最高清晰度。
 *
 * 实测：B站 对 MP4 格式有硬性限制，无论是否会员，html5 接口最高仅返回 720P(qn=64)。
 * 1080P / 1080P+ / 4K / HDR / 杜比视界 / 8K 仅 DASH 格式支持，MP4 无法获取。
 */
export const MP4_MAX_QN = 64; // 720P

/** B站 请求 UA（与 client.ts / cdn.ts 一致，短链展开请求也使用） */
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * 收窄清晰度列表到 MP4 支持的范围（qn ≤ MP4_MAX_QN）。
 *
 * 收窄后为空时回退到 [480P, 360P] 兜底，保证前端至少有可选项展示。
 */
export function narrowAcceptQualityForMp4(
  list: { id: number; label: string; resolution?: string }[],
): { id: number; label: string; resolution?: string }[] {
  const filtered = list.filter((q) => q.id <= MP4_MAX_QN);
  if (filtered.length > 0) return filtered;
  // 兜底：B站 MP4 至少支持 480P/360P
  return [
    { id: 32, label: QN_QUALITY_MAP[32]?.label ?? '480P', resolution: '854x480' },
    { id: 16, label: QN_QUALITY_MAP[16]?.label ?? '360P', resolution: '640x360' },
  ];
}

export interface ResolveOptions {
  /** 原始输入：BV 号 / av 号 / 完整 URL。 */
  url: string;
  /** 当前用户 ID，用于读取 B站 Cookie。 */
  userId?: string;
  /** B站 Cookie（由上层从 credential 取出后传入，避免本模块直接访问 DB）。 */
  cookie?: string;
  /** 指定清晰度 qn。 */
  qn?: number;
  /** 编码偏好：auto / avc / hevc / av1。 */
  codec?: string;
  /** 解析进度回调，用于 NDJSON 流式输出。 */
  onProgress?: (msg: ResolveProgress) => void;
  /**
   * 优先 MP4 单流格式（fnval=1 + platform=html5）。
   * - true：先请求 MP4 直链，浏览器原生 video.src 播放，无需 MSE，seek 流畅
   * - false/undefined：默认 DASH 路径（分离 m4s，需 MSE 双轨合并）
   * 兼容 MP4 模式最高请求 720P(qn=64)；1080P 及以上画质使用 DASH。
   * 失败时自动回退 DASH。
   */
  preferMp4?: boolean;
  /**
   * 指定播放分集（P），从 1 开始。
   * - 未传或 <=0：使用视频默认 cid（第一 P）
   * - 有效值：使用 info.pages[page-1].cid 获取对应分集的播放地址
   * 多 P 视频每个分集有独立的 cid 和 m4s 文件，必须用对应 cid 请求 playurl。
   */
  page?: number;
  /**
   * 直接指定分集 cid（优先级低于 page）。
   * - 当 page 未指定但 cid 已提供时，从 info.pages 中查找匹配的 page
   * - 用于 CLI 代理场景：前端已知目标分集的 cid，直接传入而无需先查 page 序号
   */
  cid?: number;
  /** Request-scoped DASH tuple capabilities; never persisted as provider state. */
  playbackClientProfile?: PlaybackClientProfileV1;
  /**
   * 跳过 CDN 健康检查（advisory HEAD + bounded Range GET）。
   * - false/undefined（默认）：播放场景需要选择可达 URL，执行有界探测
   * - true：下载场景直接返回 baseUrl，下载失败时由调用方重试 backupUrl
   *
   * 下载场景无需 HEAD 探测，因为 downloadToFile 本身就是连接验证；
   * 跳过可省去 3.5s 超时等待，显著提升解析速度。
   */
  skipCdnCheck?: boolean;
  /**
   * 强制使用 DASH 格式并禁用 MP4 降级。
   * - 用于 CLI 高画质代理场景：用户明确选择 DASH 后，即使 CDN 不可达
   *   也不应自动降级为 MP4，避免画质/格式与用户预期不符。
   */
  forceDash?: boolean;
}

/** 分集信息（前端用于展示分P列表和切换） */
export interface ResolvePageInfo {
  /** 分集序号，从 1 开始 */
  page: number;
  /** 分集 cid */
  cid: number;
  /** 分集标题（part） */
  part: string;
  /** 分集时长（秒） */
  duration: number;
}

export interface ResolveResult {
  title: string;
  duration: number;
  cid: number;
  videoUrl: string;
  audioUrl?: string;
  videoCodec?: string;
  audioCodec?: string;
  format: 'dash' | 'mp4';
  loggedIn: boolean;
  vipStatus: number;
  currentQn?: number;
  /** 用户/客户端请求的清晰度，用于识别是否发生降级。 */
  requestedQn?: number;
  /** 实际清晰度的人类可读标签。 */
  qualityLabel?: string;
  /** 实际选中视频 representation 的带宽。 */
  videoBandwidth?: number;
  /** 发生格式、权限或网络降级时的明确原因。 */
  fallbackReason?: string;
  acceptQuality?: { id: number; label: string; resolution?: string }[];
  /**
   * 视频所有分集列表（多 P 视频才有，单 P 视频为单元素数组）。
   * 前端用于在影片列表中显示分P选择器，切换分P时使用对应 cid 重新解析。
   */
  pages?: ResolvePageInfo[];
  /** 当前播放的分集序号（从 1 开始，默认 1） */
  currentPage?: number;
  /**
   * 展开短链后的完整视频地址（非短链输入时与入参 url 一致）。
   * 前端存影片时用它替换原始短链（如 b23.tv/xxx），
   * 下游 BV 号提取 / 分 P 解析 / 弹幕匹配不再依赖短链可达性。
   */
  resolvedUrl: string;
}

/**
 * 根据账号权限生成低于请求值的候选清晰度，严格按从高到低尝试。
 * 与旧的 `requestedQn > 32 ? 32 : 16` 相比，不会从 4K 直接跳崖到 480P。
 */
export function getQualityFallbackCandidates(
  requestedQn: number,
  isVip: boolean,
  hasCookie: boolean,
): number[] {
  return Object.keys(QN_QUALITY_MAP)
    .map(Number)
    .filter((candidate) => candidate < requestedQn)
    .filter((candidate) => (isVip ? true : !VIP_ONLY_QNS.includes(candidate)))
    .filter((candidate) => (hasCookie ? true : candidate <= 32))
    .sort((a, b) => b - a);
}

/** Choose from the service-returned accept_quality list, never from a guessed cliff. */
export function selectBestAvailableQuality(
  requestedQn: number,
  available: Array<{ id: number }>,
): number | undefined {
  return available
    .map((item) => item.id)
    .filter((id) => Number.isFinite(id) && id <= requestedQn)
    .sort((a, b) => b - a)[0];
}

function qualityLabel(qn: number | undefined): string | undefined {
  return qn === undefined ? undefined : (QN_QUALITY_MAP[qn]?.label ?? String(qn));
}

export class ResolveError extends Error {
  code: string;
  constructor(message: string, code: string = 'RESOLVE_FAILED') {
    super(message);
    this.name = 'ResolveError';
    this.code = code;
  }
}

/** 从任意输入提取 BV 号或 av 号。 */
export function extractBvid(input: string): string | null {
  const bvMatch = input.match(/BV[0-9A-Za-z]{10}/);
  if (bvMatch) return bvMatch[0];
  const avMatch = input.match(/av(\d+)/i);
  if (avMatch) return `av${avMatch[1]}`;
  return null;
}

/** B站 短链域名（host 精确匹配，小写） */
const BILIBILI_SHORT_LINK_HOSTS = new Set(['b23.tv', 'bili2233.cn']);

/**
 * 展开 B站 短链（如 https://b23.tv/RGkO5sW）为完整视频地址。
 *
 * 短链对分享链接返回 302 重定向到 www.bilibili.com/video/BVxxx?p=N
 * （可能附带分 P 与分享来源参数）。通过跟随重定向读取最终 URL 展开，
 * 使 extractBvid 与分 P 参数解析能继续工作。
 *
 * 展开失败（网络 / 超时 / 非法重定向）时原样返回输入，
 * 由后续解析流程按原始地址报错，不因短链服务抖动放大失败。
 */
export async function expandBilibiliShortLink(input: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return input;
  }
  if (!BILIBILI_SHORT_LINK_HOSTS.has(parsed.hostname.toLowerCase())) {
    return input;
  }
  try {
    // GET + redirect: 'follow'：Response.url 即重定向后的最终地址。
    // 取到最终 URL 后立即释放响应体（无需内容，避免下载整页 HTML）。
    const fetched = await fetchWithProxyPolicyDetailed(parsed.toString(), {
      method: 'GET',
      headers: { 'user-agent': DEFAULT_USER_AGENT },
      signal: AbortSignal.timeout(8000),
    }, 'public-only');
    const res = fetched.response;
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    if (fetched.finalUrl && /^https?:\/\//.test(fetched.finalUrl)) {
      console.log('[bilibili-resolver] 短链已展开:', redactMediaUrl(input), '->', redactMediaUrl(res.url));
      return fetched.finalUrl;
    }
  } catch (err) {
    console.warn('[bilibili-resolver] 短链展开失败，使用原地址继续:', redactMediaError(err));
  }
  return input;
}

async function fetchVideoInfo(bvid: string, cookie?: string) {
  const cached = getCachedVideoInfo(bvid);
  if (cached) {
    console.log('[bilibili-resolver] video info served from cache:', bvid);
    return cached;
  }
  let info: import('./video').BilibiliVideoInfo | null = null;
  try {
    info = await getVideoInfo(bvid, cookie);
  } catch (err) {
    // 将 B站 API 业务错误转换为对用户更友好的 ResolveError
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('[-404]')) {
      throw new ResolveError(
        `视频不存在或已被删除（${bvid}），请检查 BV 号是否正确`,
        'VIDEO_NOT_FOUND',
      );
    }
    if (msg.includes('[-101]')) {
      throw new ResolveError(
        'B站账号未登录或登录已过期，请重新扫码登录',
        'NOT_LOGGED_IN',
      );
    }
    if (msg.includes('[-403]') || msg.includes('[-514]')) {
      throw new ResolveError(
        '无权限访问该视频，可能为会员专享或地区限制',
        'NO_PERMISSION',
      );
    }
    // 其他未知错误保留原始消息
    throw new ResolveError(
      `获取视频信息失败: ${msg}`,
      'INFO_FAILED',
    );
  }
  if (!info) {
    throw new ResolveError('获取视频信息失败', 'INFO_FAILED');
  }
  setCachedVideoInfo(bvid, info);
  return info;
}

/**
 * 获取当前播放分集（P）的时长。
 *
 * B站多 P 视频的 data.duration 是所有 P 的总时长，
 * 但实际播放的是某个分集（cid 对应的 m4s 文件），时长只是该分集的时长。
 * 如果用 info.duration 作为播放时长，会导致：
 * - DASH 模式下 MPD mediaPresentationDuration 远超实际文件时长
 * - dash.js 认为 video.duration = 1133s，但 m4s 文件只有 176s
 * - seek 到超出实际文件范围的位置时无法下载对应 segment
 *
 * 因此必须使用与当前播放 cid 对应的分集时长。
 *
 * @param info 视频信息（包含 pages 数组）
 * @param cid 当前播放分集的 cid（可能是 info.cid 或 page 参数指定的 cid）
 */
function getCurrentPageDuration(info: BilibiliVideoInfo, cid?: number): number {
  if (info.pages && info.pages.length > 0) {
    const targetCid = cid ?? info.cid;
    const currentPage = info.pages.find((p) => p.cid === targetCid);
    if (currentPage) {
      return currentPage.duration;
    }
    // 找不到对应 cid 时回退到第一 P 的时长
    return info.pages[0].duration;
  }
  // 单 P 视频直接使用 info.duration
  return info.duration;
}

/** Explicit MP4 compatibility only: never called from a DASH transport failure. */
async function requestMp4Compatibility(
  bvid: string,
  cid: number,
  cookie: string | undefined,
  qn: number | undefined,
  isVip: boolean,
  skipCdnCheck: boolean = false,
): Promise<{ videoUrl: string; currentQn?: number; acceptQuality?: { id: number; label: string; resolution?: string }[] } | null> {
  const mp4PlayUrl = await getPlayUrl(bvid, cid, cookie, {
    qn,
    fnval: 1,
    isVip,
    // platform=html5：返回无防盗链 MP4 直链，浏览器可直接播放（SYNCTV 默认方案）
    platform: 'html5',
  });
  if (mp4PlayUrl?.format === 'mp4' && mp4PlayUrl.durl?.[0]?.url) {
    const rawUrl = mp4PlayUrl.durl[0].url;
    const httpsUrl = upgradeBilibiliUrlToHttps(rawUrl);
    // skipCdnCheck=true 时直接使用 baseUrl，避免 HEAD 探测延迟（下载场景）
    if (skipCdnCheck) {
      return {
        videoUrl: httpsUrl,
        currentQn: mp4PlayUrl.currentQn,
        acceptQuality: mp4PlayUrl.acceptQuality,
      };
    }
    const mp4Url = await findReachableMediaUrl({
      baseUrl: rawUrl,
    });
    if (mp4Url) {
      return { videoUrl: mp4Url, currentQn: mp4PlayUrl.currentQn, acceptQuality: mp4PlayUrl.acceptQuality };
    }
    // HEAD 检测全部失败时回退到原始 URL（升级 HTTPS）。
    // 原因：B站 platform=html5 返回的 MP4 直链设计上是无防盗链的，浏览器可直接播放。
    // 某些 B站 CDN 对 HEAD 方法返回 403（但对 GET 请求正常），
    // 此时不应拒绝解析，而应让浏览器直接尝试播放原始 URL。
    // 若 URL 真的不可达，浏览器播放时会显示错误，但这比直接拒绝解析更合理。
    console.warn(
      '[bilibili-mp4] HEAD 检测全部失败，回退到原始 URL:',
      redactMediaUrl(httpsUrl),
    );
    return {
      videoUrl: httpsUrl,
      currentQn: mp4PlayUrl.currentQn,
      acceptQuality: mp4PlayUrl.acceptQuality,
    };
  }
  return null;
}

/**
 * 编排完整解析流程。失败时抛出 ResolveError，调用方负责捕获并转成 NDJSON 错误消息。
 */
export async function resolveBilibiliVideo(
  opts: ResolveOptions,
): Promise<ResolveResult> {
  const { url: rawUrl, cookie, qn, codec, onProgress, preferMp4, page, cid, skipCdnCheck, playbackClientProfile } = opts;

  // 短链展开：b23.tv 等分享短链 302 到完整视频地址（可能带 ?p=N 分集参数）
  const url = await expandBilibiliShortLink(rawUrl);

  const bvid = extractBvid(url);
  if (!bvid) {
    throw new ResolveError('无法解析 B站 BV 号', 'INVALID_INPUT');
  }

  // 短链 / 分享链接常带 ?p=N 分集参数：page 未显式指定时作为默认分集
  let urlPage: number | undefined;
  try {
    const p = Number(new URL(url).searchParams.get('p'));
    if (Number.isFinite(p) && p > 0) urlPage = p;
  } catch {
    /* 非法 URL 忽略分集参数 */
  }
  const effectivePage = page ?? urlPage;

  const emit = (step: string, message: string) => {
    onProgress?.({ status: 'parsing', step, message });
  };

  // 并行：VIP 校验（从缓存或 nav 接口）与视频信息获取（view 接口）
  emit('vip', '正在检查大会员状态...');
  const [isVip, info] = await Promise.all([
    getVipStatus(cookie),
    (async () => {
      emit('info', '正在解析视频信息...');
      return fetchVideoInfo(bvid, cookie);
    })(),
  ]);

  // 确定当前播放的分集 cid：
  // - page 参数指定时使用 info.pages[page-1].cid
  // - cid 参数指定时（page 未指定）从 info.pages 中查找匹配的 page
  // - 均未指定时使用 info.cid（视频默认 cid，通常是第一 P）
  // 多 P 视频每个分集有独立的 cid 和 m4s 文件，必须用对应 cid 请求 playurl
  let effectiveCid = info.cid;
  let currentPage = 1;
  if (effectivePage && effectivePage > 0 && info.pages && info.pages.length > 0) {
    const pageIndex = Math.min(effectivePage - 1, info.pages.length - 1);
    const targetPage = info.pages[pageIndex];
    if (targetPage && targetPage.cid) {
      effectiveCid = targetPage.cid;
      currentPage = targetPage.page;
    }
  } else if (cid && info.pages && info.pages.length > 0) {
    // page 未指定但 cid 已提供：从 pages 中查找匹配的分集
    const matchedPage = info.pages.find((p) => p.cid === cid);
    if (matchedPage) {
      effectiveCid = matchedPage.cid;
      currentPage = matchedPage.page;
    }
  } else if (info.pages && info.pages.length > 0) {
    // 未指定 page 和 cid 时，根据 info.cid 找到对应的 page 序号
    const matchedPage = info.pages.find((p) => p.cid === info.cid);
    if (matchedPage) {
      currentPage = matchedPage.page;
    }
  }

  // 构建返回给前端的分集列表（简化字段，只保留前端需要的）
  const pagesInfo: ResolvePageInfo[] | undefined =
    info.pages && info.pages.length > 0
      ? info.pages.map((p) => ({
          page: p.page,
          cid: p.cid,
          part: p.part,
          duration: p.duration,
        }))
      : undefined;

  // 根据会员状态和登录态确定默认清晰度
  // 未登录 B站 时默认 480P（B站对未登录用户限制为 480P 及以下）
  const defaultQn = 127;
  const requestedQn = qn ?? defaultQn;

  // preferMp4 优先路径：直接请求 MP4 单流（fnval=1 + platform=html5），浏览器原生播放无需 MSE
  // MP4 模式最高支持 720P(qn=64)，失败时不再回退 DASH，避免用户明确选择 MP4 后仍被切换到 DASH
  if (preferMp4) {
    emit('cdn', '正在获取 MP4 直链（直连模式）...');
    const mp4 = await requestMp4Compatibility(
      info.bvid,
      effectiveCid,
      cookie,
      Math.min(requestedQn, MP4_MAX_QN),
      isVip,
      skipCdnCheck,
    );
    if (mp4) {
      // MP4 模式收窄清晰度列表：B站 MP4 直链最高支持 720P(qn=64)，
      // 不应展示 1080P+/4K/HDR 等 DASH 专属选项，避免前端误导用户
      const mp4AcceptQuality = narrowAcceptQualityForMp4(mp4.acceptQuality ?? []);
      return {
        title: info.title,
        duration: getCurrentPageDuration(info, effectiveCid),
        cid: effectiveCid,
        videoUrl: mp4.videoUrl,
        format: 'mp4',
        loggedIn: !!cookie,
        vipStatus: isVip ? 1 : 0,
        currentQn: Math.min(mp4.currentQn ?? MP4_MAX_QN, MP4_MAX_QN),
        requestedQn,
        qualityLabel: qualityLabel(mp4.currentQn ?? MP4_MAX_QN),
        fallbackReason:
          requestedQn > MP4_MAX_QN
            ? '兼容模式仅支持最高 720P，已按 MP4 上限请求'
            : undefined,
        acceptQuality: mp4AcceptQuality,
        pages: pagesInfo,
        currentPage,
        resolvedUrl: url,
      };
    }
    throw new ResolveError(
      '该视频不支持 MP4 直链播放，请切换到 DASH 高清模式',
      'MP4_NOT_AVAILABLE',
    );
  }

  // 播放地址（使用 effectiveCid 对应的分集 cid 请求 playurl）
  emit('playurl', '正在获取播放地址...');
  const playUrl = await getPlayUrl(info.bvid, effectiveCid, cookie, {
    qn: requestedQn,
    codec,
    isVip,
    playbackProfile: playbackClientProfile,
  });
  if (!playUrl) throw new ResolveError('源站未返回可播放媒体，请检查账号权限', 'NO_PERMISSION');
  if (qn !== undefined && playUrl.currentQn !== qn) {
    throw new ResolveError(`请求 ${qualityLabel(qn)}，源站实际只返回 ${qualityLabel(playUrl.currentQn)}；请检查账号、授权或主动选择其他清晰度`, 'QUALITY_UNAVAILABLE');
  }
  const acceptQuality = playUrl.acceptQuality ?? [];

  emit('finish', '解析完成，正在加载播放器...');

  // DASH 路径：选择可达视频/音频 URL
  if (playUrl.format === 'dash' && playUrl.bestVideo) {
    emit('cdn', '正在选择可用 CDN...');

    // skipCdnCheck=true 时直接使用 baseUrl，避免 HEAD 探测延迟（下载场景）
    // 下载失败时由调用方重试 backupUrl
    let videoUrl: string | null;
    let audioUrl: string | null = null;
    if (skipCdnCheck) {
      videoUrl = upgradeBilibiliUrlToHttps(playUrl.bestVideo.baseUrl);
      audioUrl = playUrl.bestAudio
        ? upgradeBilibiliUrlToHttps(playUrl.bestAudio.baseUrl)
        : null;
    } else {
      [videoUrl, audioUrl] = await Promise.all([
        findReachableMediaUrl({
          baseUrl: playUrl.bestVideo.baseUrl,
          backupUrl: playUrl.bestVideo.backupUrl,
        }),
        playUrl.bestAudio
          ? findReachableMediaUrl({
              baseUrl: playUrl.bestAudio.baseUrl,
              backupUrl: playUrl.bestAudio.backupUrl,
            })
          : Promise.resolve(null),
      ]);
    }

    // Server reachability is not browser reachability. Keep this exact representation.
    videoUrl ??= upgradeBilibiliUrlToHttps(playUrl.bestVideo.baseUrl);
    if (playUrl.bestAudio) audioUrl ??= upgradeBilibiliUrlToHttps(playUrl.bestAudio.baseUrl);

    return {
      title: info.title,
      duration: getCurrentPageDuration(info, effectiveCid),
      cid: effectiveCid,
      videoUrl,
      audioUrl: audioUrl ?? undefined,
      videoCodec: playUrl.bestVideo.codecs,
      audioCodec: playUrl.bestAudio?.codecs,
      format: 'dash',
      loggedIn: !!cookie,
      vipStatus: isVip ? 1 : 0,
      currentQn: playUrl.currentQn,
      requestedQn,
      qualityLabel: qualityLabel(playUrl.currentQn),
      videoBandwidth: playUrl.bestVideo.bandwidth,
      acceptQuality,
      pages: pagesInfo,
      currentPage,
      resolvedUrl: url,
    };
  }

  if (playUrl.format === 'mp4') throw new ResolveError('源站没有返回 DASH；请主动选择 MP4 兼容模式', 'DASH_NOT_AVAILABLE');

  throw new ResolveError('未找到可用播放地址', 'NO_PLAYURL');
}

/**
 * 将底层异常归一化为 ResolveError，便于上层统一处理。
 */
export function normalizeResolveError(err: unknown): ResolveError {
  if (err instanceof ResolveError) return err;
  if (err instanceof NoPermissionError) {
    return new ResolveError(err.message, 'NO_PERMISSION');
  }
  const message = err instanceof Error ? err.message : '解析失败';
  return new ResolveError(message, 'RESOLVE_FAILED');
}
