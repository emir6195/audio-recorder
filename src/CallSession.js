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
const WavWriter = require('./WavWriter')
const fs = require('fs')
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
    this.botEvents = [] // { startTime, arrivalTime, data, duration, interruptedAt }
    this.botNextStartTime = 0 // Next available slot for sequential bot playback

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
   * Get current time in milliseconds relative to the recording timeline
   * (Based on number of frames processed/scheduled)
   */
  _getRecordingTime() {
    return this.frameCount * this.frameMs
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

    // Enforce user buffer limit
    const itemsPerSec = this.format.sampleRate * this.format.bytesPerSample
    const userMaxBytes = (BUFFER_LIMITS.maxUserBufferMs / 1000) * itemsPerSec

    const dropped = this.userBuffer.trimToSize(userMaxBytes)
    if (dropped > 0 && this.frameCount % 50 === 0) {
      this.log(`⚠️  User buffer cap: dropped ${dropped}b (${BUFFER_LIMITS.maxUserBufferMs}ms limit)`)
    }

    // Write ONLY user audio to recording
    this.wavWriter.write(userFrame)

    this.frameCount++
    this.stats.framesWritten++

    const shouldLog = this.frameCount % 50 === 0

    if (shouldLog) {
      const userStatus = userHasData ? (userHasAudio ? '🎤AUDIO' : '🔇silent') : '⬜empty'
      this.log(`🎬 Frame ${this.frameCount.toString().padStart(4)} | ` +
        `User[${userBufferBefore.toString().padStart(5)}b→${userStatus}]`)
    }

    // Callback
    if (this.onFrame) {
      this.onFrame({
        frameNumber: this.frameCount,
        timestamp: Date.now() - this.startTime,
        userBufferSize: this.userBuffer.size(),
        botEventsCount: this.botEvents.length
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
    const arrivalTime = this._getRecordingTime()
    const durationMs = (buffer.length / this.frameBytes) * this.frameMs

    // Queue bot chunks sequentially if they arrive faster than real-time
    const startTime = Math.max(arrivalTime, this.botNextStartTime)

    this.botEvents.push({
      startTime,
      arrivalTime,
      data: buffer,
      duration: durationMs,
      interruptedAt: null
    })

    this.botNextStartTime = startTime + durationMs
    this.stats.botChunks++
    this.stats.botBytesTotal += buffer.length

    this.log(`📥 BOT audio: ${buffer.length}b (${durationMs.toFixed(0)}ms) | Queue: ${startTime.toFixed(0)}ms - ${this.botNextStartTime.toFixed(0)}ms (ArrivedRec: ${arrivalTime}ms)`)
  }

  /**
   * Handle interrupt event
   * Tracks interruption timestamp and trims/discards bot chunks
   * @returns {Object} - Interrupt info
   */
  handleInterrupt() {
    if (!this.active) return null

    const timestamp = this._getRecordingTime()
    this.stats.interrupts++

    let bytesDiscarded = 0
    let msDiscarded = 0

    // 1. Discard all chunks that haven't started "playing" yet
    const initialCount = this.botEvents.length
    this.botEvents = this.botEvents.filter(e => {
      if (e.startTime >= timestamp) {
        bytesDiscarded += e.data.length
        msDiscarded += e.duration
        return false
      }
      return true
    })
    const discardedPastCount = initialCount - this.botEvents.length

    // 2. Trim the chunk that is currently "playing"
    const currentChunk = this.botEvents[this.botEvents.length - 1]
    if (currentChunk) {
      const eventEnd = currentChunk.startTime + currentChunk.duration
      if (timestamp < eventEnd) {
        // Interruption happened DURING this bot chunk
        currentChunk.interruptedAt = timestamp

        const oldDuration = currentChunk.duration
        currentChunk.duration = Math.max(0, timestamp - currentChunk.startTime)
        const diffMs = oldDuration - currentChunk.duration
        msDiscarded += diffMs

        const framesToKeep = Math.floor(currentChunk.duration / this.frameMs)
        const bytesToKeep = framesToKeep * this.frameBytes

        bytesDiscarded += (currentChunk.data.length - bytesToKeep)
        currentChunk.data = currentChunk.data.slice(0, bytesToKeep)

        this.log(`✋ INTERRUPT! Trimming active chunk: ${oldDuration.toFixed(0)}ms → ${currentChunk.duration.toFixed(0)}ms`)
      }
    }

    // Reset next start time
    this.botNextStartTime = timestamp

    if (discardedPastCount > 0) {
      this.log(`✋ INTERRUPT! Discarded ${discardedPastCount} future chunks (-${msDiscarded.toFixed(0)}ms total)`)
    }

    const info = {
      timestamp,
      frameNumber: this.frameCount,
      bytesDiscarded,
      msDiscarded
    }

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

    // 1. Drain remaining user buffer
    const remainingUserBytes = this.userBuffer.size()
    if (remainingUserBytes > 0) {
      this.log(`📥 Draining user buffer: ${remainingUserBytes}b remaining`)
      const remainingUserAudio = this.userBuffer.pull(remainingUserBytes)
      this.wavWriter.write(remainingUserAudio)
    }

    // 2. Pad to match the longest timeline (user vs bot)
    // We calculate exactly how many bytes are needed to contain all audio
    let maxBotEndBytes = 0
    for (const e of this.botEvents) {
      const offsetSamples = Math.floor((e.startTime / 1000) * this.format.sampleRate)
      const offsetBytes = offsetSamples * this.format.bytesPerSample
      maxBotEndBytes = Math.max(maxBotEndBytes, offsetBytes + e.data.length)
    }

    const sessionDurationMs = Date.now() - this.startTime
    const sessionBytes = Math.floor((sessionDurationMs / 1000) * this.format.sampleRate) * this.format.bytesPerSample

    const targetBytes = Math.max(sessionBytes, maxBotEndBytes, this.wavWriter.dataSize)

    if (this.wavWriter.dataSize < targetBytes) {
      const paddingBytes = targetBytes - this.wavWriter.dataSize
      this.log(`🤫 Padding recording with ${paddingBytes} bytes to match longest stream (~${(paddingBytes / this.format.sampleRate / this.format.bytesPerSample * 1000).toFixed(0)}ms)`)
      this.wavWriter.write(silence(paddingBytes, this.encoding))
    }

    // Finalize user WAV
    const userWavInfo = this.wavWriter.finalize()
    this.log(`💾 User-only recording finalized: ${userWavInfo.path} (${userWavInfo.durationSec.toFixed(2)}s)`)

    // Merge bot audio into user recording
    const finalWavInfo = this.mergeFinalResult(userWavInfo)

    // Save metadata
    const metadataPath = path.join(this.recordingsDir, `${this.sessionId}_metadata.json`)
    const metadata = {
      sessionId: this.sessionId,
      startTime: this.startTime,
      endTime: Date.now(),
      duration: Date.now() - this.startTime,
      format: this.format,
      stats: this.stats,
      botEvents: this.botEvents.map(e => ({
        startTime: e.startTime,
        arrivalTime: e.arrivalTime,
        duration: e.duration,
        interruptedAt: e.interruptedAt,
        dataLength: e.data.length
      }))
    }
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2))
    this.log(`💾 Metadata saved: ${metadataPath}`)

    const summary = {
      sessionId: this.sessionId,
      duration: metadata.duration,
      recording: finalWavInfo,
      metadata: metadataPath,
      stats: this.stats
    }

    // Callback
    if (this.onEnd) {
      this.onEnd(summary)
    }

    return summary
  }

  /**
   * Merge bot chunks into the final user-only recording
   * @param {Object} userWavInfo - Info about the user-only WAV
   * @returns {Object} - Final WAV info
   */
  mergeFinalResult(userWavInfo) {
    this.log(`🔀 Merging bot chunks into final recording...`)

    try {
      // Read user audio data (skip 44-byte header)
      const userFileBuffer = fs.readFileSync(userWavInfo.path)
      const audioData = userFileBuffer.slice(44)

      // Mix each bot chunk at correct offset
      for (const event of this.botEvents) {
        // Calculate offset in bytes
        // offsetSamples = (timestampMs / 1000) * sampleRate
        // offsetBytes = offsetSamples * bytesPerSample
        const offsetSamples = Math.floor((event.startTime / 1000) * this.format.sampleRate)
        const offsetBytes = offsetSamples * this.format.bytesPerSample

        if (offsetBytes + event.data.length > audioData.length) {
          // If bot chunk extends beyond user audio (rare but possible), skip or pad
          this.log(`⚠️ Bot chunk @ ${event.startTime}ms extends beyond user audio. Clipping.`)
          const available = audioData.length - offsetBytes
          if (available <= 0) continue

          const chunkToMix = event.data.slice(0, available)
          const mixedSegment = this.mix(audioData.slice(offsetBytes, audioData.length), chunkToMix)
          mixedSegment.copy(audioData, offsetBytes)
        } else {
          const mixedSegment = this.mix(audioData.slice(offsetBytes, offsetBytes + event.data.length), event.data)
          mixedSegment.copy(audioData, offsetBytes)
        }
      }

      // Final WAV info remains same as userWavInfo in terms of metrics
      // but the file content is now mixed.
      // We overwrite the file with the mixed version.
      // Actually, let's just write back the header + mixed data.
      userFileBuffer.copy(userFileBuffer, 44, 44, 44 + audioData.length) // Already modified audioData in place as buffer slice
      fs.writeFileSync(userWavInfo.path, userFileBuffer)

      this.log(`✅ Merging complete. Final recording: ${userWavInfo.path}`)
      return userWavInfo

    } catch (err) {
      this.log(`❌ Error during merge: ${err.message}`)
      console.error(err)
      return userWavInfo // Fallback to user-only if mix fails
    }
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
      botEventsCount: this.botEvents.length,
      recordingDuration: this.wavWriter.getDurationMs(),
      stats: this.stats
    }
  }
}

module.exports = CallSession
