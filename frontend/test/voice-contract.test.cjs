const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const contract = fs.readFileSync(
  path.join(root, 'src/modules/voice-chat/voice-contract.ts'),
  'utf8',
);
const hook = fs.readFileSync(
  path.join(root, 'src/modules/voice-chat/hooks/useVoiceChat.ts'),
  'utf8',
);
const processor = fs.readFileSync(
  path.join(root, 'public/voice-processor.js'),
  'utf8',
);

test('voice contract fixes the 48kHz/960-sample wire facts', () => {
  assert.match(contract, /VOICE_SAMPLE_RATE = 48_000/);
  assert.match(contract, /VOICE_FRAME_SAMPLES = 960/);
  assert.match(contract, /VOICE_FRAME_DURATION_US = 20_000/);
  assert.match(hook, /numberOfFrames: VOICE_FRAME_SAMPLES/);
  assert.match(hook, /timestamp: frameTimestamp/);
  assert.match(hook, /frameTimestamp \+= VOICE_FRAME_DURATION_US/);
});

test('44.1kHz input has an explicit continuous resampling path', () => {
  assert.match(hook, /new AudioContext\(\{ sampleRate: VOICE_SAMPLE_RATE \}\)/);
  assert.match(processor, /this\._resampleStep = this\._inputSampleRate \/ this\._outputSampleRate/);
  assert.match(processor, /this\._resampleCursor \+= this\._resampleStep/);
  assert.doesNotMatch(processor, /channelData\.slice\(0, 960\)/);
});

test('decoder and playback resources are bounded and generation-owned', () => {
  assert.match(hook, /pendingSources: Set<AudioBufferSourceNode>/);
  assert.match(hook, /VOICE_MAX_PENDING_PACKETS/);
  assert.match(hook, /VOICE_MAX_PENDING_BYTES/);
  assert.match(hook, /state\.generation !== generation/);
  assert.match(hook, /source\.onended = \(\) =>/);
  assert.match(hook, /state\.decoderConfigKey === key/);
  assert.match(hook, /state\.decoder = createPeerDecoder/);
  assert.match(hook, /audioEncoderRef\.current\?\.close\(\)/);
  assert.match(hook, /audioContextRef\.current\?\.close\(\)/);
  assert.match(hook, /playbackContextRef\.current\?\.close\(\)/);
});

test('reconnect and moderation are server-mediated', () => {
  assert.match(hook, /socket\.on\('connect', onConnect\)/);
  assert.match(hook, /cleanupAll\(\)/);
  assert.match(hook, /'voice-mute' \| 'voice-unmute' \| 'voice-kick'/);
  assert.match(hook, /'voice-muted-changed'/);
  assert.match(hook, /'voice-kicked'/);
});
