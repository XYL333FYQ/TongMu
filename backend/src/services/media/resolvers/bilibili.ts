import { resolveBilibiliVideo } from '../../bilibili/resolver';
import type { MediaDescriptor, ResolverContext, SourceResolver } from '../types';
import { getBilibiliMediaHeaders } from '../../bilibili/cdn';

export class BilibiliResolver implements SourceResolver {
  readonly name = 'bilibili';

  canHandle(input: string): boolean {
    return /(?:bilibili\.com|b23\.tv|^BV[0-9A-Za-z]{10}$)/i.test(input.trim());
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
      bitrate: result.videoBandwidth, requestedQuality: result.requestedQn,
      actualQuality: result.currentQn, qualityLabel: result.qualityLabel,
      loggedIn: result.loggedIn, vip: result.vipStatus === 1,
      fallbackReason: result.fallbackReason, drm: { protected: false },
      headers: getBilibiliMediaHeaders(),
      sourceMetadata: {
        bilibili: {
          cid: result.cid,
          requestedQn: result.requestedQn,
          actualQn: result.currentQn,
          preferMp4: context.preferMp4 === true,
          availableQualities: result.acceptQuality ?? [],
          qualityLabel: result.qualityLabel,
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
