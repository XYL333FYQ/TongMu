import { Router, type Request, type Response } from 'express';

const FIXTURE_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const SAMPLE_RATE = 44_100;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
const FIXTURE_SECONDS = 4;

function fixtureFrequency(id: string): number {
  let hash = 0;
  for (const char of id) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) | 0;
  return 220 + Math.abs(hash % 440);
}

/** Generate a tiny deterministic WAV only for local/browser integration tests. */
function createFixtureWav(id: string): Buffer {
  const sampleCount = SAMPLE_RATE * FIXTURE_SECONDS;
  const dataSize = sampleCount * CHANNELS * (BITS_PER_SAMPLE / 8);
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(CHANNELS, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8), 28);
  buffer.writeUInt16LE(CHANNELS * (BITS_PER_SAMPLE / 8), 32);
  buffer.writeUInt16LE(BITS_PER_SAMPLE, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  const frequency = fixtureFrequency(id);
  for (let index = 0; index < sampleCount; index += 1) {
    const envelope = Math.min(1, index / 500) * Math.min(1, (sampleCount - index) / 500);
    const sample = Math.sin((2 * Math.PI * frequency * index) / SAMPLE_RATE) * 0.12 * envelope;
    buffer.writeInt16LE(Math.round(sample * 0x7fff), 44 + index * 2);
  }
  return buffer;
}

function sendRange(buffer: Buffer, request: Request, response: Response): void {
  const range = request.headers.range;
  response.setHeader('Content-Type', 'audio/wav');
  response.setHeader('Accept-Ranges', 'bytes');
  response.setHeader('Cache-Control', 'public, max-age=3600');
  if (!range) {
    response.setHeader('Content-Length', buffer.length);
    response.status(200).send(buffer);
    return;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    response.status(416).setHeader('Content-Range', `bytes */${buffer.length}`).end();
    return;
  }
  const start = match[1] ? Number(match[1]) : Math.max(0, buffer.length - Number(match[2] || 0));
  const end = match[2] ? Number(match[2]) : buffer.length - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || end >= buffer.length) {
    response.status(416).setHeader('Content-Range', `bytes */${buffer.length}`).end();
    return;
  }
  response.status(206);
  response.setHeader('Content-Range', `bytes ${start}-${end}/${buffer.length}`);
  response.setHeader('Content-Length', end - start + 1);
  response.send(buffer.subarray(start, end + 1));
}

export function createMusicFixtureRouter(): Router {
  const router = Router();
  router.get('/fixture/:id', (request, response) => {
    const id = request.params.id;
    if (!FIXTURE_ID_RE.test(id)) {
      response.status(404).json({ success: false, message: 'fixture 不存在' });
      return;
    }
    sendRange(createFixtureWav(id), request, response);
  });
  return router;
}
