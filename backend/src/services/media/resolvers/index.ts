import { BilibiliResolver } from './bilibili';
import { BrowserResolver } from './browser';
import { DirectUrlResolver } from './direct-url';
import { GenericWebResolver } from './generic-web';
import type { MediaDescriptor, ResolverContext, SourceResolver } from '../types';
import { ResolverNotApplicableError } from '../types';

const resolvers: SourceResolver[] = [
  new BilibiliResolver(),
  new DirectUrlResolver(),
  new GenericWebResolver(),
  new BrowserResolver(),
];

export async function resolveMediaInput(input: string, context: ResolverContext): Promise<MediaDescriptor> {
  const failures: string[] = [];
  for (const resolver of resolvers) {
    if (!resolver.canHandle(input)) continue;
    try { return await resolver.resolve(input, context); }
    catch (error) {
      failures.push(`${resolver.name}: ${error instanceof Error ? error.message : String(error)}`);
      if (!(error instanceof ResolverNotApplicableError)) {
        // A definitive specialized resolver failure must not silently become another interpretation.
        if (resolver.name === 'bilibili') throw error;
      }
    }
  }
  throw new Error(`无法解析该输入。${failures.join('；')}`);
}

export { BilibiliResolver, BrowserResolver, DirectUrlResolver, GenericWebResolver };
