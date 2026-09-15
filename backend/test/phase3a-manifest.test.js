const assert = require('node:assert/strict');
const test = require('node:test');

const {
  classifyHlsPlaylist,
  rewriteHlsManifest,
  rewriteDashManifest,
} = require('../dist/services/media/manifest/mapper');
const { buildBilibiliUnifiedManifest } = require('../dist/services/media/manifest/bilibili');

function mapper(prefix, seen) {
  return (resource) => {
    seen.push(resource);
    return `${prefix}/${resource.protocol}/${resource.kind}/${seen.length}`;
  };
}

function hlsOptions(mapResource, overrides = {}) {
  return {
    protocol: 'hls',
    sourceUrl: 'https://cdn.example/root/master.m3u8?session=private',
    parentResourceId: 'root-handle',
    recursiveDepth: 0,
    mapResource,
    ...overrides,
  };
}

function dashOptions(mapResource, overrides = {}) {
  return {
    protocol: 'dash',
    sourceUrl: 'https://cdn.example/root/manifest.mpd?session=private',
    parentResourceId: 'root-handle',
    recursiveDepth: 0,
    mapResource,
    ...overrides,
  };
}

test('HLS classifies master/live/event/vod lifecycle', () => {
  assert.equal(classifyHlsPlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\na.m3u8'), 'Master');
  assert.equal(classifyHlsPlaylist('#EXTM3U\n#EXTINF:4,\na.ts'), 'LiveMedia');
  assert.equal(classifyHlsPlaylist('#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXTINF:4,\na.ts'), 'EventMedia');
  assert.equal(classifyHlsPlaylist('#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:4,\na.ts'), 'VodMedia');
  assert.equal(classifyHlsPlaylist('#EXTM3U\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST'), 'VodMedia');
});

test('HLS maps every URI-bearing role and preserves resolved query/encoding', () => {
  const seen = [];
  const result = rewriteHlsManifest([
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio/index.m3u8?lang=en&x=1"',
    '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI="iframes/main.m3u8"',
    '#EXT-X-RENDITION-REPORT:URI="../backup.m3u8",LAST-MSN=10',
    '#EXT-X-SESSION-DATA:DATA-ID="x",URI="meta/a%2Fb.json"',
    '#EXT-X-SESSION-KEY:METHOD=AES-128,URI="keys/session?token=secret"',
    '#EXT-X-KEY:METHOD=AES-128,URI="keys/current"',
    '#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"',
    '#EXT-X-PART:DURATION=1,URI="parts/1.1"',
    '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="parts/next"',
    '#EXT-X-PRELOAD-HINT:TYPE=MAP,URI="init/next"',
    '#EXT-X-STREAM-INF:BANDWIDTH=1000',
    'video/1080.m3u8',
    '#EXTINF:4,',
    'segments/a%2Fb.ts?x=1&x=2',
  ].join('\n'), hlsOptions(mapper('/opaque', seen)));

  assert.equal(result.resourceCount, 12);
  assert.deepEqual(seen.map((item) => item.kind), [
    'Manifest', 'Manifest', 'Manifest', 'Auxiliary', 'Key', 'Key', 'Init',
    'Part', 'Part', 'Init', 'Manifest', 'Segment',
  ]);
  assert.ok(seen.some((item) => item.upstreamUrl === 'https://cdn.example/root/audio/index.m3u8?lang=en&x=1'));
  assert.ok(seen.some((item) => item.upstreamUrl === 'https://cdn.example/root/segments/a%2Fb.ts?x=1&x=2'));
  assert.doesNotMatch(result.body, /https:\/\/cdn\.example/);
  assert.match(result.body, /#EXT-X-KEY:.*URI="\/opaque\/hls\/Key\//);
});

test('HLS resource count fails before returning a partial rewrite', () => {
  const boundedBodies = [[1, 1], [2, 2]];
  for (const [resourceCount, limit] of boundedBodies) {
    const boundedBody = ['#EXTM3U', ...Array.from({ length: resourceCount }, (_, index) => `segment-${index}.ts`)].join('\n');
    const seen = [];
    const result = rewriteHlsManifest(boundedBody, hlsOptions(mapper('/opaque', seen), { maxResources: limit }));
    assert.equal(result.resourceCount, resourceCount);
  }
  const body = ['#EXTM3U', ...Array.from({ length: 3 }, (_, index) => `segment-${index}.ts`)].join('\n');
  assert.throws(
    () => rewriteHlsManifest(body, hlsOptions(() => '/opaque', { maxResources: 2 })),
    (error) => error.code === 'RESOURCE_LIMIT',
  );
});

test('HLS recursion depth is bounded for child manifests', () => {
  assert.throws(
    () => rewriteHlsManifest('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nchild.m3u8', hlsOptions(() => '/opaque', {
      recursiveDepth: 1,
      maxRecursiveDepth: 1,
    })),
    (error) => error.code === 'RECURSION_LIMIT',
  );
});

test('DASH maps BaseURL, inherited templates, List/Base ranges, Location, xlink, and timing', () => {
  const seen = [];
  const result = rewriteDashManifest([
    '<?xml version="1.0"?>',
    '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:xlink="http://www.w3.org/1999/xlink">',
    '<Location>refresh/next.mpd?token=secret</Location>',
    '<BaseURL>https://cdn.example/video/</BaseURL>',
    '<Period><BaseURL>period/</BaseURL><AdaptationSet>',
    '<SegmentTemplate media="$RepresentationID$/seg-$Number%05d$.m4s?token=secret" initialization="$RepresentationID$/init.m4s" bitstreamSwitching="switch-$RepresentationID$.xml"/>',
    '<Representation id="v1"><SegmentBase indexRange="100-200"><Initialization sourceURL="init.mp4" range="0-99"/></SegmentBase></Representation>',
    '<Representation id="v2"><SegmentList><Initialization sourceURL="init-v2.mp4"/><SegmentURL media="seg.m4s" index="seg.idx" mediaRange="1-2"/></SegmentList></Representation>',
    '<Representation id="v3" xlink:href="remote/period.xml"/>',
    '</AdaptationSet></Period>',
    '<UTCTiming schemeIdUri="urn:mpeg:dash:utc:http-xsdate:2014" value="https://time.example/now"/>',
    '<UTCTiming schemeIdUri="urn:mpeg:dash:utc:direct:2014" value="2026-09-14T00:00:00Z"/>',
    '</MPD>',
  ].join(''), dashOptions(mapper('/opaque', seen)));

  assert.ok(seen.some((item) => item.kind === 'Manifest' && item.upstreamUrl.includes('/refresh/next.mpd')));
  assert.ok(seen.some((item) => item.kind === 'Media' && item.template && item.upstreamUrl.includes('$Number%05d$')));
  assert.ok(seen.some((item) => item.kind === 'Initialization' && item.upstreamUrl.includes('init-v2.mp4')));
  assert.ok(seen.some((item) => item.kind === 'Index' && item.upstreamUrl.includes('seg.idx')));
  assert.ok(seen.some((item) => item.kind === 'RecursiveManifest' && item.upstreamUrl.includes('remote/period.xml')));
  assert.ok(seen.some((item) => item.kind === 'BaseURL'));
  assert.ok(seen.some((item) => item.kind === 'Timing' && item.upstreamUrl === 'https://time.example/now'));
  assert.ok(!seen.some((item) => item.kind === 'Timing' && item.upstreamUrl.includes('2026-09-14')));
  assert.ok(seen.some((item) => item.template && item.upstreamUrl.includes('$Number%05d$')));
  assert.doesNotMatch(result.body, /token=secret/);
});

test('Bilibili unified MPD exposes only the selected video/audio representation', () => {
  const manifest = buildBilibiliUnifiedManifest({
    videoUrl: 'https://cdn.example/selected-1080-h264.m4s?token=private',
    audioUrl: 'https://cdn.example/selected-aac.m4s?token=private',
    videoCodec: 'avc1.640028',
    audioCodec: 'mp4a.40.2',
    videoBandwidth: 4_000_000,
    duration: 12.5,
    quality: 80,
  });
  assert.match(manifest, /video-80/);
  assert.match(manifest, /avc1\.640028/);
  assert.match(manifest, /mp4a\.40\.2/);
  assert.doesNotMatch(manifest, /720|hev1|hvc1/);
  assert.match(manifest, /selected-1080-h264\.m4s\?token=private/);

  const seen = [];
  const mapped = rewriteDashManifest(manifest, dashOptions(mapper('/opaque', seen)));
  assert.doesNotMatch(mapped.body, /cdn\.example|token=private/);
  assert.deepEqual(seen.map((item) => item.kind), ['Media', 'Media']);
});

test('DASH rejects DTD/entity and unsupported URI attributes', () => {
  assert.throws(
    () => rewriteDashManifest('<!DOCTYPE MPD [<!ENTITY x SYSTEM "file:///etc/passwd">]><MPD/>', dashOptions(() => '/opaque')),
    (error) => error.code === 'UNSAFE_XML',
  );
  assert.throws(
    () => rewriteDashManifest('<MPD><Period><Foo manifestUrl="https://evil.example/a"/></Period></MPD>', dashOptions(() => '/opaque')),
    (error) => error.code === 'UNSUPPORTED_DASH_URI',
  );
});
