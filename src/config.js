/**
 * Audio Format Configurations
 * 
 * Two supported formats:
 * 1. PCM16 24kHz Mono (high quality)
 * 2. uLaw 8kHz Mono (telephony standard)
 */

const FORMATS = {
  PCM16_24K: {
    name: 'pcm16_24k',
    sampleRate: 24000,
    channels: 1,
    bitDepth: 16,
    bytesPerSample: 2,
    frameMs: 20,
    get frameBytes() {
      return (this.sampleRate / 1000) * this.frameMs * this.bytesPerSample
    },
    encoding: 'pcm16'
  },
  ULAW_8K: {
    name: 'ulaw_8k',
    sampleRate: 8000,
    channels: 1,
    bitDepth: 8,
    bytesPerSample: 1,
    frameMs: 20,
    get frameBytes() {
      return (this.sampleRate / 1000) * this.frameMs * this.bytesPerSample
    },
    encoding: 'ulaw'
  }
}

const SERVER_CONFIG = {
  port: process.env.PORT || 8282,
  recordingsDir: './recordings'
}

// Buffer limits to prevent unbounded memory growth
const BUFFER_LIMITS = {
  // Max user buffer latency: 500ms default (tight real-time)
  maxUserBufferMs: parseInt(process.env.MAX_USER_BUFFER_MS) || 500,
  // Max bot buffer duration: 20 seconds default
  maxBotBufferMs: parseInt(process.env.MAX_BOT_BUFFER_MS) || 20000
}

// Debug mode (set DEBUG=false to disable verbose logging)
const DEBUG = process.env.DEBUG !== 'false'

module.exports = { FORMATS, SERVER_CONFIG, BUFFER_LIMITS, DEBUG }

