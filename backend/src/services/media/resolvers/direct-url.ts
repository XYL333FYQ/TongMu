import { isHtmlDescriptor, probeMediaUrl } from '../probe';
import type { ResolverContext, SourceResolver } from '../types';
import { ResolverNotApplicableError } from '../types';

export class DirectUrlResolver implements SourceResolver {
  readonly name = 'direct-url';

  canHandle(input: string): boolean {
    try { const url = new URL(input); return url.protocol === 'http:' || url.protocol === 'https:'; }
    catch { return false; }
  }

  async resolve(input: string, _context: ResolverContext) {
    const descriptor = await probeMediaUrl(input, { sourceType: 'url', resolver: this.name });
    if (isHtmlDescriptor(descriptor)) throw new ResolverNotApplicableError('输入是 HTML 页面，不是媒体直链');
    if (descriptor.container === 'unknown') {
      throw new ResolverNotApplicableError('直链 probe 未识别出媒体格式');
    }
    return descriptor;
  }
}
