import { BilibiliResolver } from './bilibili';
import { BrowserResolver } from './browser';
import { DirectUrlResolver } from './direct-url';
import { GenericWebResolver } from './generic-web';
import type { MediaDescriptor, ResolverContext } from '../types';
import type { ProviderResolution } from '../providers/types';
import {
  mediaProviderRegistry,
  privateProviderContextFromResolverContext,
  providerContextFromResolverContext,
} from '../providers/registry';

export async function resolveMediaInput(input: string, context: ResolverContext): Promise<MediaDescriptor> {
  return mediaProviderRegistry.resolve(
    input,
    providerContextFromResolverContext(context),
    privateProviderContextFromResolverContext(context),
  );
}

/** Provider-facing form used by media-core routes that need private candidates. */
export async function resolveMediaProvider(input: string, context: ResolverContext): Promise<ProviderResolution> {
  return mediaProviderRegistry.resolveProvider(
    input,
    providerContextFromResolverContext(context),
    privateProviderContextFromResolverContext(context),
  );
}

export { BilibiliResolver, BrowserResolver, DirectUrlResolver, GenericWebResolver };
