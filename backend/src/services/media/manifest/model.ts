/**
 * Server-private identity for a resource emitted while mapping a manifest.
 * The browser receives only the opaque handle returned by the mapper callback.
 */
export type HlsResourceKind =
  | 'Manifest'
  | 'Segment'
  | 'Part'
  | 'Key'
  | 'Init'
  | 'Auxiliary';

export type HlsPlaylistKind = 'Master' | 'LiveMedia' | 'EventMedia' | 'VodMedia';

export type DashResourceKind =
  | 'Manifest'
  | 'Media'
  | 'Initialization'
  | 'Index'
  | 'BitstreamSwitching'
  | 'Timing'
  | 'Auxiliary'
  | 'BaseURL'
  | 'RecursiveManifest';

export type ManifestProtocol = 'hls' | 'dash';

export type ManifestHandleKind =
  | 'hls-manifest'
  | 'hls-segment'
  | 'hls-part'
  | 'hls-key'
  | 'hls-init'
  | 'hls-auxiliary'
  | 'dash-manifest'
  | 'dash-media'
  | 'dash-initialization'
  | 'dash-index'
  | 'dash-bitstream-switching'
  | 'dash-timing'
  | 'dash-auxiliary'
  | 'dash-base'
  | 'dash-recursive-manifest';

export interface ManifestResource {
  protocol: ManifestProtocol;
  kind: HlsResourceKind | DashResourceKind;
  upstreamUrl: string;
  parentResourceId: string;
  rootSourceIdentity: string;
  sourceGeneration?: number;
  actorId?: string;
  roomId?: string;
  scope: string;
  expiresAt: number;
  requestHeaders?: Record<string, string>;
  credentialOrigins?: string[];
  headerExposurePolicy: 'same-origin-sensitive' | 'strip-cross-origin-sensitive';
  allowRange: boolean;
  recursiveDepth: number;
  representationIdentity?: string;
  cachePolicyHint: 'no-store' | 'future-slice-cache';
}

export interface ManifestResourceMapping {
  protocol: ManifestProtocol;
  kind: HlsResourceKind | DashResourceKind;
  upstreamUrl: string;
  parentResourceId: string;
  recursiveDepth: number;
  allowRange: boolean;
  representationIdentity?: string;
  /** True for SegmentTemplate attributes containing DASH substitution tokens. */
  template?: boolean;
}

export interface ManifestMapperOptions {
  protocol: ManifestProtocol;
  sourceUrl: string;
  parentResourceId: string;
  recursiveDepth: number;
  maxRecursiveDepth?: number;
  maxResources?: number;
  mapResource: (mapping: ManifestResourceMapping) => string;
}

export interface MappedManifest<TPlaylist = HlsPlaylistKind | undefined> {
  body: string;
  playlistKind?: TPlaylist;
  resourceCount: number;
}

export class ManifestMappingError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ManifestMappingError';
    this.code = code;
  }
}

export function manifestHandleKind(
  protocol: ManifestProtocol,
  kind: HlsResourceKind | DashResourceKind,
): ManifestHandleKind {
  const normalized = kind === 'BaseURL'
    ? 'base'
    : kind === 'RecursiveManifest'
      ? 'recursive-manifest'
      : kind.replace(/[A-Z]/g, (value) => `-${value.toLowerCase()}`).replace(/^-/, '');
  return `${protocol}-${normalized}` as ManifestHandleKind;
}
