/**
 * BotPlayback Controller
 * 
 * State Machine for bot audio playback with interrupt support.
 * 
 * States:
 *   IDLE     - No active playback
 *   PLAYING  - Currently playing bot audio
 *   STOPPED  - Interrupted, waiting for new audio
 * 
 * Transitions:
 *   IDLE     + bot_audio  → PLAYING
 *   PLAYING  + interrupt  → STOPPED (clears buffer)
 *   PLAYING  + buffer_end → IDLE
 *   STOPPED  + bot_audio  → PLAYING
 */

const AudioBufferQueue = require('./AudioBufferQueue')
const { silence, pad } = require('./AudioMixer')
const { BUFFER_LIMITS, DEBUG } = require('./config')

// DEBUG imported from config.js

const States = {
  IDLE: 'IDLE',
  PLAYING: 'PLAYING',
  STOPPED: 'STOPPED'
}

class BotPlayback {
  constructor(formatConfig, sessionShortId = '--------') {
    this.buffer = new AudioBufferQueue()
    this.state = States.IDLE
    this.format = formatConfig
    this.frameBytes = formatConfig.frameBytes
    this.encoding = formatConfig.encoding
    this.sessionShortId = sessionShortId
    this.startTime = Date.now()

    // Stats for debugging
    this.stats = {
      chunksReceived: 0,
      framesPlayed: 0,
      interrupts: 0,
      bytesDiscarded: 0,
      silenceFrames: 0
    }
  }

  /**
   * Debug log
   */
  log(msg) {
    if (!DEBUG) return
    const elapsed = Date.now() - this.startTime
    console.log(`[${this.sessionShortId}] [${elapsed.toString().padStart(6)}ms] [BOT] ${msg}`)
  }

  /**
   * Start playback (transition to PLAYING)
   */
  start() {
    if (this.state !== States.PLAYING) {
      const oldState = this.state
      this.state = States.PLAYING
      this.log(`🔄 State: ${oldState} → ${this.state}`)
    }
  }

  /**
   * Stop playback and clear buffer (interrupt)
   * @returns {number} - Bytes discarded
   */
  stop() {
    const discarded = this.buffer.size()
    const oldState = this.state
    this.state = States.STOPPED
    this.buffer.clear()
    this.stats.interrupts++
    this.stats.bytesDiscarded += discarded

    this.log(`🛑 STOP! State: ${oldState} → ${this.state} | Discarded: ${discarded}b`)

    return discarded
  }

  /**
   * Feed new audio chunk from bot
   * @param {Buffer} chunk - Audio data
   */
  feed(chunk) {
    if (!Buffer.isBuffer(chunk)) {
      chunk = Buffer.from(chunk)
    }

    this.stats.chunksReceived++
    const oldState = this.state
    const bufferBefore = this.buffer.size()

    // If stopped or idle, start playing
    if (this.state !== States.PLAYING) {
      this.start()
    }

    this.buffer.push(chunk)

    // Enforce bot buffer limit to prevent OOM
    const itemsPerSec = this.format.sampleRate * this.format.bytesPerSample
    const bufferLimit = (BUFFER_LIMITS.maxBotBufferMs / 1000) * itemsPerSec

    const discarded = this.buffer.trimToSize(bufferLimit)
    if (discarded > 0) {
      this.log(`⚠️  Bot buffer capped: discarded ${discarded}b excess (limit: ${bufferLimit}b / ${BUFFER_LIMITS.maxBotBufferMs}ms)`)
    }

    // Log feed occasionally
    if (this.stats.chunksReceived % 50 === 0) {
      this.log(`📥 Feed: ${chunk.length}b | State: ${oldState}→${this.state} | Buffer: ${bufferBefore}→${this.buffer.size()}b`)
    }
  }

  /**
   * Get next frame for playback
   * Returns silence if not playing or buffer empty
   * @returns {Buffer} - Frame data (always frameBytes size)
   */
  frame() {
    const size = this.frameBytes

    // Not playing → silence (format-aware!)
    if (this.state !== States.PLAYING) {
      this.stats.silenceFrames++
      return silence(size, this.encoding)
    }

    // Try to pull full frame
    const frame = this.buffer.pull(size)

    if (frame) {
      this.stats.framesPlayed++
      return frame
    }

    // Partial data or empty → end of playback
    const remaining = this.buffer.pullAvailable(size)
    const oldState = this.state
    this.state = States.IDLE

    if (remaining.length > 0) {
      this.stats.framesPlayed++
      this.log(`🏁 Buffer exhausted (partial ${remaining.length}b) | State: ${oldState} → ${this.state}`)
      return pad(remaining, size, this.encoding)
    }

    this.log(`🏁 Buffer empty | State: ${oldState} → ${this.state}`)
    this.stats.silenceFrames++
    return silence(size, this.encoding)
  }

  /**
   * Check if currently playing
   * @returns {boolean}
   */
  isPlaying() {
    return this.state === States.PLAYING && this.buffer.size() > 0
  }

  /**
   * Get current state
   * @returns {string}
   */
  getState() {
    return this.state
  }

  /**
   * Get buffer size in bytes
   * @returns {number}
   */
  getBufferSize() {
    return this.buffer.size()
  }

  /**
   * Get playback stats
   * @returns {Object}
   */
  getStats() {
    return {
      ...this.stats,
      state: this.state,
      bufferSize: this.buffer.size(),
      bufferMs: (this.buffer.size() / this.frameBytes) * this.format.frameMs
    }
  }

  /**
   * Reset to initial state
   */
  reset() {
    this.buffer.clear()
    this.state = States.IDLE
    this.stats = {
      chunksReceived: 0,
      framesPlayed: 0,
      interrupts: 0,
      bytesDiscarded: 0,
      silenceFrames: 0
    }
  }
}

module.exports = BotPlayback
module.exports.States = States
