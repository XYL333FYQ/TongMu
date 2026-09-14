import type { MediaDescriptor } from './types';
import {
  capabilityFactsForDescriptor,
  profileSupportsCapability,
  type PlaybackClientProfileV1,
} from './playback-profile';
import { canPublishDirectUrl, type PlaybackCandidate, type TransportMode } from './protocol';

export type ViabilityReason =
  | 'drm-protected'
  | 'unsupported-transport'
  | 'unsupported-codec-tuple'
  | 'exact-codec-mismatch'
  | 'custom-header-unavailable'
  | 'mixed-content'
  | 'private-direct-url'
  | 'provider-proxy-unavailable'
  | 'quality-mismatch';

export interface PlaybackViabilityContext {
  /** The browser page protocol, when the request origin is known. */
  pageProtocol?: 'http' | 'https';
}

export interface RemovedPlaybackCandidate {
  mode: TransportMode;
  reason: ViabilityReason;
}

export interface PlaybackViabilityResult {
  viable: PlaybackCandidate[];
  removed: RemovedPlaybackCandidate[];
  profileFingerprint?: string;
}

function candidateQualityMatches(descriptor: MediaDescriptor, candidate: PlaybackCandidate): boolean {
  // A provider transcode is a separately labelled representation. Its output
  // quality is intentionally not compared with the source quality here; the
  // provider only emits it when the request carries explicit opt-in policy.
  if (candidate.qualityChanged) return true;
  if (descriptor.actualQuality === undefined || candidate.actualQuality === undefined) return true;
  return descriptor.actualQuality === candidate.actualQuality;
}

function capabilityFactsForCandidate(descriptor: MediaDescriptor, candidate: PlaybackCandidate) {
  return capabilityFactsForDescriptor(
    {
      transport: candidate.transport,
      container: candidate.container,
      videoCodec: candidate.videoCodec ? String(candidate.videoCodec) : descriptor.videoCodec,
      audioCodec: candidate.audioCodec ? String(candidate.audioCodec) : descriptor.audioCodec,
    },
    candidate.requiredPipelines,
    candidate.exactCodecStrings,
  );
}

function directUrlIsMixedContent(url: string, profile: PlaybackClientProfileV1, context: PlaybackViabilityContext): boolean {
  try {
    const protocol = new URL(url).protocol;
    if (protocol !== 'http:') return false;
    if (!profile.supportsInsecureHttpMedia) return true;
    return context.pageProtocol === 'https' && profile.mixedContentRestricted;
  } catch {
    return true;
  }
}

function capabilityReason(descriptor: MediaDescriptor, candidate: PlaybackCandidate): ViabilityReason {
  const facts = capabilityFactsForCandidate(descriptor, candidate);
  if (facts.videoCodec === 'unknown' || facts.audioCodec === 'unknown') return 'exact-codec-mismatch';
  return 'unsupported-codec-tuple';
}

/**
 * Remove only routes that are impossible or unsafe for this request-scoped
 * client. This function deliberately preserves candidate order and never
 * returns a selected engine or PlaybackPlan.
 */
export function filterPlaybackCandidates(
  descriptor: MediaDescriptor,
  candidates: PlaybackCandidate[],
  profile: PlaybackClientProfileV1,
  context: PlaybackViabilityContext = {},
): PlaybackViabilityResult {
  const viable: PlaybackCandidate[] = [];
  const removed: RemovedPlaybackCandidate[] = [];
  for (const candidate of candidates) {
    let reason: ViabilityReason | undefined;
    if (descriptor.drm?.protected) reason = 'drm-protected';
    else if (!candidateQualityMatches(descriptor, candidate)) reason = 'quality-mismatch';
    else if (descriptor.isLive && (candidate.transport === 'hls' || candidate.transport === 'flv') && !profile.liveTransports.includes(candidate.transport)) reason = 'unsupported-transport';
    else {
      const facts = capabilityFactsForCandidate(descriptor, candidate);
      if (!profileSupportsCapability(profile, facts)) reason = capabilityReason(descriptor, candidate);
    }

    if (!reason && candidate.mode === 'DIRECT') {
      if (candidate.requiresCustomHeaders || Object.keys(descriptor.headers ?? {}).some((key) => !/^accept(?:-language)?$/i.test(key))) {
        reason = profile.mediaCapabilities.some((capability) => capability.supportsCustomHeaders)
          ? 'private-direct-url'
          : 'custom-header-unavailable';
      } else if (!canPublishDirectUrl(candidate.url) || (candidate.audioUrl && !canPublishDirectUrl(candidate.audioUrl))) {
        reason = 'private-direct-url';
      } else if (directUrlIsMixedContent(candidate.url, profile, context)) {
        reason = 'mixed-content';
      }
    } else if (!reason && candidate.mode !== 'DIRECT' && !profile.supportsProviderProxy) {
      reason = 'provider-proxy-unavailable';
    }

    if (reason) removed.push({ mode: candidate.mode, reason });
    else viable.push(candidate);
  }
  return { viable, removed };
}
