/**
 * CallSession
 * 
 * Manages a single call recording session.
 * Handles user/bot audio streams, mixing, and recording.
 * 
 * Features:
 * - Frame-based scheduler (20ms intervals)
 * - Real-time mixing of user + bot audio
 * - Interrupt handling (stops bot playback immediately)
 * - WAV recording with proper timeline
 */

const AudioBufferQueue = require('./AudioBufferQueue')
const BotPlayback = require('./BotPlayback')
const WavWriter = require('./WavWriter')
const { silence, pad, getMixer } = require('./AudioMixer')
const UlawCodec = require('./UlawCodec')
const { v4: uuidv4 } = require('uuid')
const path = require('path')
const { BUFFER_LIMITS, DEBUG } = require('./config')

// DEBUG is imported from config.js (controlled via DEBUG env var)

class CallSession {
  /**
   * @param {string} sessionId - Unique session identifier
   * @param {Object} format - Audio format configuration
   * @param {string} recordingsDir - Directory for recordings
   */
  constructor(sessionId, format, recordingsDir) {
    this.sessionId = sessionId || uuidv4()
    this.format = format
    this.encoding = format.encoding
    this.recordingsDir = recordingsDir

    // Short ID for logs
    this.shortId = this.sessionId.substring(0, 8)

    // Timing
    this.startTime = Date.now()
    this.frameMs = format.frameMs
    this.frameBytes = format.frameBytes

    // Buffers
    this.userBuffer = new AudioBufferQueue()
    this.botPlayback = new BotPlayback(format, this.shortId)

    // Mixer
    this.mix = getMixer(format.encoding)

    // Recording - filename is just sessionId.wav
    const filename = `${this.sessionId}.wav`
    this.wavWriter = new WavWriter(
      path.join(recordingsDir, filename),
      format
    )

    // State
    this.active = true
    this.frameCount = 0
    this.schedulerHandle = null
    this.overlapStartFrame = 0
    this.overlapCount = 0

    // Stats
    this.stats = {
      userChunks: 0,
      botChunks: 0,
      interrupts: 0,
      framesWritten: 0,
      userBytesTotal: 0,
      botBytesTotal: 0
    }

    // Event callbacks
    this.onFrame = null
    this.onEnd = null

    this.log(`📦 Session created | Format: ${format.name} | Encoding: ${this.encoding} | FrameBytes: ${this.frameBytes}`)

    // Start frame scheduler
    this.startScheduler()
  }

  /**
   * Debug log with session ID and timestamp
   */
  log(msg) {
    if (!DEBUG) return
    const elapsed = Date.now() - this.startTime
    console.log(`[${this.shortId}] [${elapsed.toString().padStart(6)}ms] ${msg}`)
  }

  /**
   * Start the frame scheduler
   * Writes mixed frames at fixed intervals
   */
  startScheduler() {
    this.log(`⏱️  Scheduler started (${this.frameMs}ms interval)`)
    this.schedulerHandle = setInterval(() => {
      if (!this.active) return
      this.processFrame()
    }, this.frameMs)
  }

  /**
   * Check if buffer has non-silent audio
   * Format-aware: handles both PCM16 and μ-Law correctly
   */
  hasAudio(buffer) {
    if (!buffer || buffer.length === 0) return false

    if (this.encoding === 'ulaw') {
      // μ-Law: 0xFF and 0x7F are silence, anything else is audio
      for (let i = 0; i < Math.min(buffer.length, 100); i++) {
        const val = buffer[i]
        // μ-Law silence values are 0xFF (negative zero) and 0x7F (positive zero)
        if (val !== 0xFF && val !== 0x7F) {
          return true
        }
      }
      return false
    } else {
      // PCM16: check for samples with magnitude > 100
      for (let i = 0; i < Math.min(buffer.length, 100); i += 2) {
        const sample = buffer.readInt16LE(i)
        if (Math.abs(sample) > 100) {
          return true
        }
      }
      return false
    }
  }

  /**
   * Process one frame (20ms)
   * Called by scheduler at fixed intervals
   */
  processFrame() {
    const size = this.frameBytes

    // Get user frame (or silence)
    const userBufferBefore = this.userBuffer.size()
    let userFrame = this.userBuffer.pull(size)
    const userHasData = userFrame !== null
    if (!userFrame) {
      userFrame = silence(size, this.encoding)
    }
    const userHasAudio = this.hasAudio(userFrame)


    // Enforce user buffer limit (format-aware duration)
    // Calculate bytes for max allowed duration (e.g. 500ms)
    // bytes = (ms / frameMs) * frameBytes = (ms / 1000) * sampleRate * bytesPerSample
    const itemsPerSec = this.format.sampleRate * this.format.bytesPerSample
    const userMaxBytes = (BUFFER_LIMITS.maxUserBufferMs / 1000) * itemsPerSec

    const dropped = this.userBuffer.trimToSize(userMaxBytes)
    if (dropped > 0 && this.frameCount % 50 === 0) {
      this.log(`⚠️  User buffer cap: dropped ${dropped}b (${BUFFER_LIMITS.maxUserBufferMs}ms limit)`)
    }

    // Get bot frame (handled by BotPlayback FSM)
    const botBufferBefore = this.botPlayback.getBufferSize()
    const botStateBefore = this.botPlayback.getState()
    const botFrame = this.botPlayback.frame()
    const botHasAudio = this.hasAudio(botFrame)
    const botStateAfter = this.botPlayback.getState()

    // Mix frames
    const mixed = this.mix(userFrame, botFrame)

    // Write to recording
    this.wavWriter.write(mixed)

    this.frameCount++
    this.stats.framesWritten++

    // Log every 50 frames (1 second) or on state changes
    // OVERLAP LOGGING: Only log on rising edge (start of overlap) or periodically
    const isOverlap = userHasAudio && botHasAudio

    if (isOverlap) {
      if (this.overlapCount === 0) {
        // Rising edge - log immediately
        this.overlapStartFrame = this.frameCount
        this.log(`⚠️  OVERLAP STARTED! Frame ${this.frameCount}`)
      }
      this.overlapCount++
    } else {
      if (this.overlapCount > 0) {
        this.log(`✅ OVERLAP ENDED. Duration: ${this.overlapCount} frames`)
        this.overlapCount = 0
      }
    }

    const shouldLog = this.frameCount % 50 === 0 ||
      botStateBefore !== botStateAfter ||
      (isOverlap && this.overlapCount % 50 === 0) // Log overlap every 1s, not every frame

    if (shouldLog) {
      const userStatus = userHasData ? (userHasAudio ? '🎤AUDIO' : '🔇silent') : '⬜empty'
      const botStatus = botHasAudio ? '🤖AUDIO' : '⬜silent'
      const overlapMsg = isOverlap ? `⚠️ OVERLAP! (+${this.overlapCount})` : ''

      this.log(`🎬 Frame ${this.frameCount.toString().padStart(4)} | ` +
        `User[${userBufferBefore.toString().padStart(5)}b→${userStatus}] | ` +
        `Bot[${botStateBefore}→${botStateAfter}, ${botBufferBefore.toString().padStart(5)}b→${botStatus}] ${overlapMsg}`)
    }

    // Callback
    if (this.onFrame) {
      this.onFrame({
        frameNumber: this.frameCount,
        timestamp: Date.now() - this.startTime,
        userBufferSize: this.userBuffer.size(),
        botBufferSize: this.botPlayback.getBufferSize(),
        botState: this.botPlayback.getState()
      })
    }
  }

  /**
   * Handle incoming user audio
   * @param {string} base64Data - Base64 encoded audio
   */
  handleUserAudio(base64Data) {
    if (!this.active) return

    const buffer = Buffer.from(base64Data, 'base64')
    const hasAudio = this.hasAudio(buffer)
    const bufferBefore = this.userBuffer.size()

    this.userBuffer.push(buffer)
    this.stats.userChunks++
    this.stats.userBytesTotal += buffer.length

    // Log user audio arrival (throttled)
    if (this.stats.userChunks % 100 === 0) {
      const durationMs = (buffer.length / this.frameBytes) * this.frameMs
      this.log(`📥 USER audio: ${buffer.length}b (${durationMs.toFixed(0)}ms) | ` +
        `HasAudio: ${hasAudio} | Buffer: ${bufferBefore}→${this.userBuffer.size()}b`)
    }
  }

  /**
   * Handle incoming bot audio
   * @param {string} base64Data - Base64 encoded audio
   */
  handleBotAudio(base64Data) {
    if (!this.active) return

    const buffer = Buffer.from(base64Data, 'base64')
    const hasAudio = this.hasAudio(buffer)
    const bufferBefore = this.botPlayback.getBufferSize()
    const stateBefore = this.botPlayback.getState()

    this.botPlayback.feed(buffer)
    this.stats.botChunks++
    this.stats.botBytesTotal += buffer.length

    // Log bot audio arrival
    const durationMs = (buffer.length / this.frameBytes) * this.frameMs
    this.log(`📥 BOT  audio: ${buffer.length}b (${durationMs.toFixed(0)}ms) | ` +
      `HasAudio: ${hasAudio} | State: ${stateBefore}→${this.botPlayback.getState()} | ` +
      `Buffer: ${bufferBefore}→${this.botPlayback.getBufferSize()}b`)
  }

  /**
   * Handle interrupt event
   * Immediately stops bot playback and clears buffer
   * @returns {Object} - Interrupt info
   */
  handleInterrupt() {
    if (!this.active) return null

    const bufferBefore = this.botPlayback.getBufferSize()
    const stateBefore = this.botPlayback.getState()

    const bytesDiscarded = this.botPlayback.stop()
    this.stats.interrupts++

    const info = {
      timestamp: Date.now() - this.startTime,
      frameNumber: this.frameCount,
      bytesDiscarded,
      msDiscarded: (bytesDiscarded / this.frameBytes) * this.frameMs
    }

    this.log(`✋ INTERRUPT! State: ${stateBefore}→${this.botPlayback.getState()} | ` +
      `Discarded: ${bytesDiscarded}b (${info.msDiscarded.toFixed(0)}ms)`)

    return info
  }

  /**
   * End the session
   * Stops scheduler and finalizes recording
   * @returns {Object} - Session summary
   */
  end() {
    if (!this.active) return null

    this.log(`🛑 Ending session...`)
    this.log(`📊 Stats: UserChunks=${this.stats.userChunks}, BotChunks=${this.stats.botChunks}, ` +
      `Frames=${this.stats.framesWritten}, Interrupts=${this.stats.interrupts}`)
    this.log(`📊 Bytes: User=${this.stats.userBytesTotal}b, Bot=${this.stats.botBytesTotal}b`)

    this.active = false

    // Stop scheduler
    if (this.schedulerHandle) {
      clearInterval(this.schedulerHandle)
      this.schedulerHandle = null
    }

    // Drain remaining buffers (one more frame each)
    this.processFrame()

    // Finalize WAV
    const wavInfo = this.wavWriter.finalize()

    this.log(`💾 Recording saved: ${wavInfo.path} (${wavInfo.durationSec.toFixed(2)}s)`)

    const summary = {
      sessionId: this.sessionId,
      duration: Date.now() - this.startTime,
      recording: wavInfo,
      stats: {
        ...this.stats,
        botPlayback: this.botPlayback.getStats()
      }
    }

    // Callback
    if (this.onEnd) {
      this.onEnd(summary)
    }

    return summary
  }

  /**
   * Get current session status
   * @returns {Object}
   */
  getStatus() {
    return {
      sessionId: this.sessionId,
      active: this.active,
      uptime: Date.now() - this.startTime,
      frameCount: this.frameCount,
      userBufferSize: this.userBuffer.size(),
      botState: this.botPlayback.getState(),
      botBufferSize: this.botPlayback.getBufferSize(),
      recordingDuration: this.wavWriter.getDurationMs(),
      stats: this.stats
    }
  }
}

module.exports = CallSession
