import type {
  MediaServerMediaSource,
  MediaServerPlaybackInfo,
  MediaServerStream,
} from './media-server-types';

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function mapMediaServerStream(value: unknown): MediaServerStream {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const type = stringValue(source.Type) ?? '';
  return {
    index: numberValue(source.Index) ?? 0,
    type: type.toLowerCase(),
    codec: stringValue(source.Codec),
    language: stringValue(source.Language),
    title: stringValue(source.Title),
    displayTitle: stringValue(source.DisplayTitle),
    displayLanguage: stringValue(source.DisplayLanguage),
    isExternal: booleanValue(source.IsExternal),
    deliveryMethod: stringValue(source.DeliveryMethod),
    deliveryUrl: stringValue(source.DeliveryUrl),
    isDefault: booleanValue(source.IsDefault),
    isForced: booleanValue(source.IsForced),
    channels: numberValue(source.Channels),
    bitrate: numberValue(source.BitRate ?? source.Bitrate),
  };
}

export function mapMediaServerSource(value: unknown): MediaServerMediaSource {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    id: stringValue(source.Id) ?? '',
    name: stringValue(source.Name),
    path: stringValue(source.Path),
    protocol: stringValue(source.Protocol),
    container: stringValue(source.Container),
    size: numberValue(source.Size),
    bitrate: numberValue(source.Bitrate),
    width: numberValue(source.Width),
    height: numberValue(source.Height),
    runTimeTicks: numberValue(source.RunTimeTicks),
    supportsDirectPlay: booleanValue(source.SupportsDirectPlay),
    supportsDirectStream: booleanValue(source.SupportsDirectStream),
    supportsTranscoding: booleanValue(source.SupportsTranscoding),
    directPlayUrl: stringValue(source.DirectPlayUrl),
    directStreamUrl: stringValue(source.DirectStreamUrl),
    transcodingUrl: stringValue(source.TranscodingUrl),
    directStreamPreservesQuality: booleanValue(source.DirectStreamPreservesQuality),
    transcodingContainer: stringValue(source.TranscodingContainer),
    transcodingVideoCodec: stringValue(source.TranscodingVideoCodec),
    transcodingAudioCodec: stringValue(source.TranscodingAudioCodec),
    transcodingWidth: numberValue(source.TranscodingWidth),
    transcodingHeight: numberValue(source.TranscodingHeight),
    transcodingBitrate: numberValue(source.TranscodingBitrate),
    mediaStreams: Array.isArray(source.MediaStreams) ? source.MediaStreams.map(mapMediaServerStream) : [],
  };
}

export function mapMediaServerPlaybackInfo(value: unknown): MediaServerPlaybackInfo {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    playSessionId: stringValue(source.PlaySessionId),
    mediaSources: Array.isArray(source.MediaSources)
      ? source.MediaSources.map(mapMediaServerSource).filter((item) => item.id)
      : [],
  };
}

