/**
 * B站 CDN 健康检查与轨道选择模块。
 *
 * 与原实现相比：
 * - 使用 Promise.race + 短超时，先返回的可达 URL 即可使用，避免顺序等待所有候选。
 * - 对单条 URL 的 HEAD 检测失败仍能快速失败，整体最长耗时 ≈ 超时上限。
 * - 与解析模块解耦，可独立测试与替换。
 */

export const BILIBILI_MEDIA_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Canonical anti-hotlink policy for Bilibili CDN media requests. */
export function getBilibiliMediaHeaders(): Record<string, string> {
  return {
    Referer: 'https://www.bilibili.com/',
    Origin: 'https://www.bilibili.com',
    'User-Agent': BILIBILI_MEDIA_USER_AGENT,
  };
}

/** 单条 URL 健康检查超时（毫秒）。 */
const HEALTH_CHECK_TIMEOUT_MS = 3500;

/** 已知支持 HTTPS 的 B站 CDN 域名。 */
const HTTPS_CAPABLE_BILIBILI_DOMAINS = [
  'bilivideo.com',
  'hdslb.com',
  'biliimg.com',
  'bilibili.com',
  'upos-hz-mirrorakam.akamaized.net',
  // B站 视频轨道 CDN 域名（edge 节点），与前端 url-proxy.ts 白名单保持一致
  'mountaintoys.cn',
  'pili-video.com',
  'boss-pgc.com',
  'bstatic.com',
];

/**
 * 将 B站 CDN URL 的协议统一升级为 HTTPS。
 *
 * 在 HTTPS 页面中，浏览器会阻止 HTTP 媒体资源（Mixed Content）。
 * B站 主 CDN 域名均支持 HTTPS，因此解析阶段直接升级协议，可让 MP4 直链
 * 在 HTTPS 部署下也能被浏览器直接播放，避免全部流量压到服务器代理。
 */
export function upgradeBilibiliUrlToHttps(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:') return url;
    const host = parsed.hostname.toLowerCase();
    const isBilibiliCdn = HTTPS_CAPABLE_BILIBILI_DOMAINS.some(
      (domain) => host === domain || host.endsWith(`.${domain}`),
    );
    if (!isBilibiliCdn) return url;
    parsed.protocol = 'https:';
    // 升级后默认使用 443 端口，显式移除 http 默认的 80 端口（如有）
    if (parsed.port === '80') parsed.port = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

export interface MediaTrackCandidate {
  /** 主 URL。 */
  baseUrl: string;
  /** 备用 URL 列表。 */
  backupUrl?: string[];
}

/**
 * 使用 HEAD 探测单个 URL；HEAD 被拒绝或结果模糊时，用极小 Range GET
 * 验证真实读取路径。部分 CDN 的 HEAD=403、GET=206，不能把 HEAD 当最终结论。
 */
export async function checkUrlReachable(
  url: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = HEALTH_CHECK_TIMEOUT_MS,
): Promise<boolean> {
  try {
    const headController = new AbortController();
    const headTimer = setTimeout(() => headController.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: 'HEAD',
        signal: headController.signal,
        headers: getBilibiliMediaHeaders(),
      });
      if (response.ok) return true;
    } catch {
      // HEAD is advisory; use a fresh signal for the real Range request.
    } finally {
      clearTimeout(headTimer);
    }

    const rangeController = new AbortController();
    const rangeTimer = setTimeout(() => rangeController.abort(), timeoutMs);
    try {
      const rangeResponse = await fetchImpl(url, {
        method: 'GET',
        signal: rangeController.signal,
        headers: {
          ...getBilibiliMediaHeaders(),
          Range: 'bytes=0-1',
        },
      });
      const reachable = rangeResponse.ok || rangeResponse.status === 206;
      try { await rangeResponse.body?.cancel(); } catch { /* ignore */ }
      return reachable;
    } finally {
      clearTimeout(rangeTimer);
    }
  } catch {
    return false;
  }
}

/**
 * 并行检测所有候选 URL，返回第一个可达的 URL。
 * 使用 Promise.race 模式，先返回即可使用，整体最长耗时接近单条超时上限，
 * 而非按候选数量线性叠加。
 *
 * 返回前会统一将 B站 CDN URL 升级为 HTTPS，避免 HTTPS 页面出现 Mixed Content。
 */
export async function findReachableMediaUrl(
  candidate: MediaTrackCandidate,
): Promise<string | null> {
  const candidates = [
    upgradeBilibiliUrlToHttps(candidate.baseUrl),
    ...(candidate.backupUrl || []).map(upgradeBilibiliUrlToHttps),
  ].filter(Boolean);
  if (candidates.length === 0) return null;

  // 串行 await Promise.all 在每个 URL 都不可达时仍需等待全部超时；
  // 此处用 race 模式：任一 URL 可达即立即返回。
  return new Promise<string | null>((resolve) => {
    let resolved = false;
    let pending = candidates.length;

    const finish = (url: string | null) => {
      if (resolved) return;
      resolved = true;
      resolve(url);
    };

    for (const url of candidates) {
      checkUrlReachable(url)
        .then((ok) => {
          if (ok) {
            console.log('[bilibili-cdn] 选择可达 URL:', url);
            finish(url);
            return;
          }
          pending -= 1;
          if (pending === 0) finish(null);
        })
        .catch(() => {
          pending -= 1;
          if (pending === 0) finish(null);
        });
    }

    // 兜底：超过 (超时 + 500ms) 仍未结束，强制返回 null
    setTimeout(() => finish(null), HEALTH_CHECK_TIMEOUT_MS + 500);
  });
}

/**
 * 为 DASH 轨道选择可达 URL：先尝试 bestVideo 主 URL，不可达时尝试备用。
 * 与 findReachableMediaUrl 不同，这里返回对象同时携带轨道元信息（codec 等）。
 */
export async function selectReachableTrackUrl(
  track: MediaTrackCandidate,
): Promise<string | null> {
  return findReachableMediaUrl(track);
}
