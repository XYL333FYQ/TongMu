/** Shared, client-side Voice contract. PlaybackPlan/media source lifecycle is
 * deliberately not involved here: Voice has its own generation domain. */
export const VOICE_SAMPLE_RATE = 48_000
export const VOICE_CHANNELS = 1
export const VOICE_FRAME_SAMPLES = 960
export const VOICE_FRAME_DURATION_US = 20_000
export const VOICE_MAX_PACKET_BYTES = 64 * 1024
export const VOICE_MAX_PENDING_PACKETS = 4
export const VOICE_MAX_PENDING_BYTES = 256 * 1024
export const VOICE_MAX_PENDING_AGE_MS = 1_000

export function arrayBufferEquals(
  left: ArrayBuffer | undefined,
  right: ArrayBuffer | undefined
): boolean {
  if (!left || !right || left.byteLength !== right.byteLength) return false
  const a = new Uint8Array(left)
  const b = new Uint8Array(right)
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

export function boundedArrayBuffer(value: unknown): ArrayBuffer | null {
  if (value instanceof ArrayBuffer) return value
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(
      value.byteOffset,
      value.byteOffset + value.byteLength
    ) as ArrayBuffer
  }
  return null
}

export function isBoundedVoicePacket(value: unknown): value is ArrayBuffer {
  const data = boundedArrayBuffer(value)
  return (
    !!data && data.byteLength > 0 && data.byteLength <= VOICE_MAX_PACKET_BYTES
  )
}

/**
 * Linear interpolation resampler used by tests and non-AudioWorklet callers.
 * The AudioWorklet has the same continuous interpolation semantics and keeps
 * its source cursor between render quanta; no samples are dropped/repeated.
 */
export function resampleMonoLinear(
  input: Float32Array,
  inputRate: number,
  outputRate = VOICE_SAMPLE_RATE
): Float32Array {
  if (
    !Number.isFinite(inputRate) ||
    inputRate <= 0 ||
    inputRate === outputRate
  ) {
    return new Float32Array(input)
  }
  if (input.length < 2) return new Float32Array(input)
  const outputLength = Math.max(
    0,
    Math.floor(((input.length - 1) * outputRate) / inputRate)
  )
  const output = new Float32Array(outputLength)
  const step = inputRate / outputRate
  for (let index = 0; index < output.length; index += 1) {
    const position = index * step
    const left = Math.floor(position)
    const fraction = position - left
    output[index] = input[left] * (1 - fraction) + input[left + 1] * fraction
  }
  return output
}
