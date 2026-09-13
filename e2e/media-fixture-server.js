const http = require('node:http');
const { spawn } = require('node:child_process');
const { createCipheriv } = require('node:crypto');

const PORT = 3456;
const key = Buffer.from('zviewer-e2e-key!');
const iv = Buffer.alloc(16);
const requests = [];
let assets;

function isIsoBmff(buffer) {
  return buffer.length >= 8 && buffer.toString('ascii', 4, 8) === 'ftyp';
}

function isWebm(buffer) {
  return buffer.length >= 4 && buffer.readUInt32BE(0) === 0x1a45dfa3;
}

function hasBoxType(buffer, type) {
  return buffer.indexOf(Buffer.from(type, 'ascii')) >= 0;
}

function isCompatibleMp4(buffer, kind) {
  if (!isIsoBmff(buffer)) return false;
  const hasAvc = hasBoxType(buffer, 'avcC') || hasBoxType(buffer, 'avc1');
  const hasAac = hasBoxType(buffer, 'mp4a');
  return kind === 'audio' ? hasAac : kind === 'video' ? hasAvc : hasAvc && hasAac;
}

function transcodeToFragmentedMp4(buffer, kind, inputFormat) {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', inputFormat,
      '-i', 'pipe:0',
    ];
    if (kind === 'audio') {
      args.push('-vn', '-c:a', 'aac', '-b:a', '96k');
    } else {
      args.push(
        '-an',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-pix_fmt', 'yuv420p',
        '-profile:v', 'baseline',
        '-level', '3.0',
      );
      if (kind === 'muxed') args.splice(args.indexOf('-an'), 1, '-c:a', 'aac', '-b:a', '96k');
    }
    args.push(
      '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4',
      'pipe:1',
    );

    let child;
    try {
      child = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      reject(new Error(`FFmpeg could not start for ${kind} fixture: ${error}`));
      return;
    }
    const output = [];
    const errors = [];
    child.stdout.on('data', (chunk) => output.push(chunk));
    child.stderr.on('data', (chunk) => errors.push(chunk));
    child.on('error', (error) => reject(new Error(`FFmpeg is required for WebM ${kind} fixture: ${error.message}`)));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`FFmpeg failed for ${kind} fixture (exit ${code}): ${Buffer.concat(errors).toString('utf8').trim()}`));
        return;
      }
      const result = Buffer.concat(output);
      if (!isIsoBmff(result)) {
        reject(new Error(`FFmpeg produced a non-MP4 ${kind} fixture`));
        return;
      }
      resolve(result);
    });
    child.stdin.end(buffer);
  });
}

async function normalizeToFragmentedMp4(buffer, kind) {
  if (isCompatibleMp4(buffer, kind)) return buffer;
  if (isIsoBmff(buffer)) return transcodeToFragmentedMp4(buffer, kind, 'mp4');
  if (isWebm(buffer)) return transcodeToFragmentedMp4(buffer, kind, 'webm');
  throw new Error(`Unsupported ${kind} fixture container; expected MP4 or WebM`);
}

function splitFragmentedMp4(buffer) {
  const boxes = [];
  for (let offset = 0; offset + 8 <= buffer.length;) {
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    let header = 8;
    if (size === 1 && offset + 16 <= buffer.length) {
      size = Number(buffer.readBigUInt64BE(offset + 8));
      header = 16;
    } else if (size === 0) {
      size = buffer.length - offset;
    }
    if (size < header || offset + size > buffer.length) break;
    boxes.push({ offset, size, type });
    offset += size;
  }
  const firstMoof = boxes.findIndex((box) => box.type === 'moof');
  if (firstMoof < 0) throw new Error('Chromium did not produce fragmented MP4');
  const init = buffer.subarray(0, boxes[firstMoof].offset);
  const fragments = [];
  for (let index = firstMoof; index < boxes.length;) {
    if (boxes[index].type !== 'moof') { index += 1; continue; }
    const start = boxes[index].offset;
    let next = index + 1;
    while (next < boxes.length && boxes[next].type !== 'moof') next += 1;
    const end = next < boxes.length ? boxes[next].offset : buffer.length;
    fragments.push(buffer.subarray(start, end));
    index = next;
  }
  return { init, fragment: Buffer.concat(fragments) };
}

function encrypted(buffer) {
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([cipher.update(buffer), cipher.final()]);
}

function readAvcCodec(init) {
  const offset = init.indexOf(Buffer.from('avcC'));
  if (offset < 0 || offset + 8 > init.length) return 'avc1.42c00c';
  return `avc1.${[init[offset + 5], init[offset + 6], init[offset + 7]]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')}`;
}

function sendBuffer(req, res, body, contentType) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', contentType);
  res.setHeader('Accept-Ranges', 'bytes');
  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!match) { res.writeHead(416, { 'Content-Range': `bytes */${body.length}` }); res.end(); return; }
    const start = Number(match[1]);
    const end = match[2] ? Math.min(Number(match[2]), body.length - 1) : body.length - 1;
    if (start > end || start >= body.length) { res.writeHead(416, { 'Content-Range': `bytes */${body.length}` }); res.end(); return; }
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${body.length}`,
      'Content-Length': String(end - start + 1),
    });
    if (req.method === 'HEAD') res.end(); else res.end(body.subarray(start, end + 1));
    return;
  }
  res.setHeader('Content-Length', String(body.length));
  res.writeHead(200);
  if (req.method === 'HEAD') res.end(); else res.end(body);
}

function sendText(req, res, body, contentType) {
  sendBuffer(req, res, Buffer.from(body), contentType);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 30 * 1024 * 1024) { reject(new Error('fixture upload too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type,range');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.url === '/configure' && req.method === 'POST') {
    try {
      const body = await readJson(req);
      const muxed = await normalizeToFragmentedMp4(Buffer.from(body.muxed, 'base64'), 'muxed');
      const video = splitFragmentedMp4(await normalizeToFragmentedMp4(Buffer.from(body.video, 'base64'), 'video'));
      const audio = splitFragmentedMp4(await normalizeToFragmentedMp4(Buffer.from(body.audio, 'base64'), 'audio'));
      const muxedParts = splitFragmentedMp4(muxed);
      assets = {
        muxed,
        video,
        audio,
        videoCodec: readAvcCodec(video.init),
        muxedVideoCodec: readAvcCodec(muxedParts.init),
        muxedParts,
        encryptedHls: encrypted(muxedParts.fragment),
      };
      requests.length = 0;
      res.writeHead(204); res.end();
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end(String(error));
    }
    return;
  }
  if (req.url === '/stats') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(requests));
    return;
  }
  if (req.url === '/diagnostics') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(assets ? {
      configured: true,
      hlsAdvertisedVideoCodec: assets.muxedVideoCodec,
      hlsAdvertisedAudioCodec: 'mp4a.40.2',
      actualMuxedVideoCodec: readAvcCodec(assets.muxedParts.init),
      actualDashVideoCodec: assets.videoCodec,
      muxedBytes: assets.muxed.length,
      muxedInitBytes: assets.muxedParts.init.length,
      muxedFragmentBytes: assets.muxedParts.fragment.length,
      videoInitBytes: assets.video.init.length,
      videoFragmentBytes: assets.video.fragment.length,
      audioInitBytes: assets.audio.init.length,
      audioFragmentBytes: assets.audio.fragment.length,
    } : { configured: false }));
    return;
  }
  if (!assets) { res.writeHead(503); res.end('fixture not configured'); return; }
  const path = new URL(req.url, `http://127.0.0.1:${PORT}`).pathname;
  requests.push({ path, method: req.method, range: req.headers.range || '' });

  if (path === '/normal.mp4' || path === '/extensionless') return sendBuffer(req, res, assets.muxed, 'video/mp4');
  if (path === '/hls/master.m3u8') return sendText(req, res,
    `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-STREAM-INF:BANDWIDTH=500000,CODECS="${assets.muxedVideoCodec},mp4a.40.2"\nvariant\n`,
    'application/vnd.apple.mpegurl');
  if (path === '/hls/variant') return sendText(req, res,
    '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-KEY:METHOD=AES-128,URI="key",IV=0x00000000000000000000000000000000\n#EXTINF:3.0,\nsegment\n#EXT-X-ENDLIST\n',
    'application/vnd.apple.mpegurl');
  if (path === '/hls/init.mp4') return sendBuffer(req, res, assets.muxedParts.init, 'video/mp4');
  if (path === '/hls/key') return sendBuffer(req, res, key, 'application/octet-stream');
  if (path === '/hls/segment') return sendBuffer(req, res, assets.encryptedHls, 'video/mp4');
  if (path === '/dash/manifest.mpd') return sendText(req, res, `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT3S" minBufferTime="PT0.5S" profiles="urn:mpeg:dash:profile:isoff-live:2011">
  <BaseURL>media/</BaseURL><Period duration="PT3S">
    <AdaptationSet contentType="video" mimeType="video/mp4" segmentAlignment="true"><BaseURL>video/</BaseURL>
      <SegmentTemplate timescale="1000" duration="3000" startNumber="1" initialization="init.mp4" media="chunk-$Number$.m4s"/>
      <Representation id="v1" bandwidth="500000" width="160" height="90" codecs="${assets.videoCodec}"/>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" segmentAlignment="true"><BaseURL>audio/</BaseURL>
      <SegmentTemplate timescale="1000" duration="3000" startNumber="1" initialization="init.mp4" media="chunk-$Number$.m4s"/>
      <Representation id="a1" bandwidth="64000" audioSamplingRate="48000" codecs="mp4a.40.2"/>
    </AdaptationSet>
  </Period>
</MPD>`, 'application/dash+xml');
  if (path === '/dash/media/video/init.mp4') return sendBuffer(req, res, assets.video.init, 'video/mp4');
  if (path === '/dash/media/video/chunk-1.m4s') return sendBuffer(req, res, assets.video.fragment, 'video/iso.segment');
  if (path === '/dash/media/audio/init.mp4') return sendBuffer(req, res, assets.audio.init, 'audio/mp4');
  if (path === '/dash/media/audio/chunk-1.m4s') return sendBuffer(req, res, assets.audio.fragment, 'video/iso.segment');
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  if (process.send) process.send({ type: 'ready', port: PORT });
  else console.log(`[e2e-fixture] listening on ${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
