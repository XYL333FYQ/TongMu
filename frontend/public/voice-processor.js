/**
 * Voice Processor — AudioWorklet 处理器
 *
 * 在音频线程中采集 PCM 样本，累积到指定帧数后通过 port.postMessage
 * 发送到主线程，由主线程通过 Socket.IO 发往服务器中转。
 *
 * 参数：
 * - frameSize：每次发送的样本数（默认 960，即 20ms @ 48kHz，匹配 Opus 编码帧）
 * - outputSampleRate：输出 contract 固定为 48000。浏览器若无法把
 *   MediaStream 重采样到 AudioContext.sampleRate，则这里继续做连续线性插值。
 *
 * 数据格式：Float32Array（单声道），通过 Transferable ArrayBuffer 传输
 */
class VoiceProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const config = (options && options.processorOptions) || {}
    this._frameSize = config.frameSize || 960
    this._outputSampleRate = config.outputSampleRate || 48000
    this._inputSampleRate = sampleRate
    this._resampleStep = this._inputSampleRate / this._outputSampleRate
    this._resampleBuffer = new Float32Array(0)
    this._resampleCursor = 0
    this._buffer = new Float32Array(this._frameSize)
    this._offset = 0
    this._enabled = true

    // 监听主线程指令（启用/禁用采集）
    this.port.onmessage = (e) => {
      if (e.data && typeof e.data.enabled === 'boolean') {
        this._enabled = e.data.enabled
        if (!this._enabled) {
          // 不把静音前的半帧带到重新开启后的语音中。
          this._offset = 0
          this._resampleBuffer = new Float32Array(0)
          this._resampleCursor = 0
        }
      }
    }
  }

  process(inputs) {
    // 麦克风禁用时不采集，避免发送静音数据浪费带宽
    if (!this._enabled) {
      return true
    }

    const input = inputs[0]
    if (!input || !input[0]) {
      return true
    }

    const channelData = input[0] // Float32Array, usually 128 samples
    let outputData = channelData

    // AudioContext({ sampleRate: 48000 }) 通常会替设备输入插入重采样器，
    // 但规范允许实现选择实际速率；因此在 worklet 内保留连续 source
    // cursor，避免简单丢样本/复制样本造成 pitch 或时长漂移。
    if (this._inputSampleRate !== this._outputSampleRate) {
      const merged = new Float32Array(
        this._resampleBuffer.length + channelData.length,
      )
      merged.set(this._resampleBuffer)
      merged.set(channelData, this._resampleBuffer.length)
      const output = []
      while (this._resampleCursor + 1 < merged.length) {
        const left = Math.floor(this._resampleCursor)
        const fraction = this._resampleCursor - left
        output.push(
          merged[left] * (1 - fraction) + merged[left + 1] * fraction,
        )
        this._resampleCursor += this._resampleStep
      }
      const consumed = Math.max(0, Math.floor(this._resampleCursor) - 1)
      this._resampleBuffer = merged.slice(consumed)
      this._resampleCursor -= consumed
      outputData = Float32Array.from(output)
    }

    for (let i = 0; i < outputData.length; i++) {
      this._buffer[this._offset++] = outputData[i]

      if (this._offset >= this._frameSize) {
        // 缓冲区满，发送数据副本（postMessage 会 transfer ArrayBuffer）
        const copy = new Float32Array(this._frameSize)
        copy.set(this._buffer)
        this.port.postMessage(copy.buffer, [copy.buffer])
        this._offset = 0
      }
    }

    return true
  }
}

registerProcessor('voice-processor', VoiceProcessor)
