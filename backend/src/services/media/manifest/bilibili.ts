function escapeXml(value: string): string {
  return value.replace(/[<>&'\"]/g, (character) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    "'": '&apos;',
    '\"': '&quot;',
  }[character] ?? character));
}

function durationIso8601(seconds: number | undefined): string | undefined {
  if (!Number.isFinite(seconds) || (seconds as number) <= 0) return undefined;
  return `PT${Math.max(0.001, seconds as number).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}S`;
}

export interface BilibiliUnifiedManifestInput {
  videoUrl: string;
  audioUrl?: string;
  videoCodec?: string;
  audioCodec?: string;
  videoBandwidth?: number;
  audioBandwidth?: number;
  duration?: number;
  quality?: number;
}

/**
 * Build a sealed, selected-representation-only MPD for Bilibili's dual m4s
 * DASH response. The URLs are never sent directly; the manifest mapper turns
 * them into typed resources after the resulting body is read from the handle.
 */
export function buildBilibiliUnifiedManifest(input: BilibiliUnifiedManifestInput): string {
  const duration = durationIso8601(input.duration);
  const durationAttribute = duration ? ` mediaPresentationDuration="${duration}"` : '';
  const videoId = `video-${input.quality ?? 'selected'}`;
  const audioId = 'audio-selected';
  const videoBandwidth = Number.isFinite(input.videoBandwidth) && (input.videoBandwidth as number) > 0
    ? ` bandwidth="${Math.floor(input.videoBandwidth as number)}"` : '';
  const audioBandwidth = Number.isFinite(input.audioBandwidth) && (input.audioBandwidth as number) > 0
    ? ` bandwidth="${Math.floor(input.audioBandwidth as number)}"` : '';
  const videoCodec = input.videoCodec ? ` codecs="${escapeXml(input.videoCodec)}"` : '';
  const audioCodec = input.audioCodec ? ` codecs="${escapeXml(input.audioCodec)}"` : '';
  const audio = input.audioUrl ? `
    <AdaptationSet id="audio" contentType="audio" mimeType="audio/mp4" segmentAlignment="true">
      <Representation id="${audioId}"${audioCodec}${audioBandwidth}>
        <BaseURL>${escapeXml(input.audioUrl)}</BaseURL>
        <SegmentBase />
      </Representation>
    </AdaptationSet>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static"${durationAttribute} minBufferTime="PT1S">
  <Period id="p0"${duration ? ` duration="${duration}"` : ''}>
    <AdaptationSet id="video" contentType="video" mimeType="video/mp4" segmentAlignment="true">
      <Representation id="${videoId}"${videoCodec}${videoBandwidth}>
        <BaseURL>${escapeXml(input.videoUrl)}</BaseURL>
        <SegmentBase />
      </Representation>
    </AdaptationSet>${audio}
  </Period>
</MPD>`;
}
