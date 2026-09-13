import { resolveBilibiliVideo } from '../../bilibili/resolver';
import type { MediaDescriptor, ResolverContext, SourceResolver } from '../types';
import { getBilibiliMediaHeaders } from '../../bilibili/cdn';

export class BilibiliResolver implements SourceResolver {
  readonly name = 'bilibili';

  canHandle(input: string): boolean {
    if (/^(?:BV[0-9A-Za-z]{10}|av\d+)$/i.test(input.trim())) return true;
    try {
      const host = new URL(input.trim()).hostname.toLowerCase();
      return ['bilibili.com', 'b23.tv', 'bili2233.cn'].some(domain => host === domain || host.endsWith(`.${domain}`));
    } catch { return false; }
  }

  async resolve(input: string, context: ResolverContext): Promise<MediaDescriptor> {
    const result = await resolveBilibiliVideo({
      url: input, userId: context.userId, cookie: context.cookie,
      qn: context.requestedQn, preferMp4: context.preferMp4,
      page: context.page, cid: context.cid,
    });
    return {
      title: result.title,
      sourceType: 'bilibili', resolver: this.name, input,
      originalUrl: result.resolvedUrl, finalUrl: result.videoUrl, audioUrl: result.audioUrl,
      transport: result.format === 'dash' ? 'dash' : 'direct',
      container: result.format === 'dash' ? 'dash' : 'mp4',
      contentType: result.format === 'dash' ? 'video/mp4' : 'video/mp4',
      videoCodec: result.videoCodec, audioCodec: result.audioCodec, duration: result.duration,
      bitrate: result.videoBandwidth, requestedQuality: context.requestedQn,
      actualQuality: result.currentQn,
      sourceMaximumQuality: result.acceptQuality?.length ? Math.max(...result.acceptQuality.map(q => q.id)) : undefined,
      availableMaximumQuality: context.requestedQn === undefined ? result.currentQn : undefined,
      actualCodec: result.videoCodec, actualBandwidth: result.videoBandwidth,
      qualityLabel: context.requestedQn === undefined ? `${result.qualityLabel}（当前可用最高）` : result.qualityLabel,
      loggedIn: result.loggedIn, vip: result.vipStatus === 1,
      fallbackReason: result.fallbackReason, drm: { protected: false },
      headers: result.format === 'dash' ? getBilibiliMediaHeaders() : undefined,
      sourceMetadata: {
        bilibili: {
          cid: result.cid,
          requestedQn: context.requestedQn,
          actualQn: result.currentQn,
          preferMp4: context.preferMp4 === true,
          availableQualities: result.acceptQuality ?? [],
          qualityLabel: context.requestedQn === undefined ? `${result.qualityLabel}（当前可用最高）` : result.qualityLabel,
          videoCodec: result.videoCodec,
          audioCodec: result.audioCodec,
          videoBandwidth: result.videoBandwidth,
          fallbackReason: result.fallbackReason,
          pages: result.pages,
          currentPage: result.currentPage,
        },
      },
      probe: { method: 'resolver', bytesRead: 0, warnings: result.fallbackReason ? [result.fallbackReason] : [] },
    };
  }
}
