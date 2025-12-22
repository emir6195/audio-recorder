/**
 * WavWriter
 * 
 * Writes WAV file with proper header.
 * Supports PCM16 and μ-Law formats.
 * 
 * Header is written at the end when finalized
 * to include correct data size.
 */

const fs = require('fs')
const path = require('path')

class WavWriter {
  /**
   * @param {string} filePath - Output file path
   * @param {Object} format - Audio format config
   */
  constructor(filePath, format) {
    this.filePath = filePath
    this.format = format
    this.dataSize = 0
    this.finalized = false

    // Ensure directory exists
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    // Open file and write placeholder header
    this.fd = fs.openSync(filePath, 'w')
    this.writeHeader()
  }

  /**
   * Write WAV header
   * Called at start (with 0 size) and at end (with actual size)
   */
  writeHeader() {
    const { sampleRate, channels, bitDepth, encoding } = this.format
    const bytesPerSample = bitDepth / 8
    const blockAlign = channels * bytesPerSample
    const byteRate = sampleRate * blockAlign

    // Audio format: 1 = PCM, 7 = μ-Law
    const audioFormat = encoding === 'ulaw' ? 7 : 1

    const header = Buffer.alloc(44)
    let offset = 0

    // RIFF chunk descriptor
    header.write('RIFF', offset); offset += 4
    header.writeUInt32LE(36 + this.dataSize, offset); offset += 4  // File size - 8
    header.write('WAVE', offset); offset += 4

    // fmt sub-chunk
    header.write('fmt ', offset); offset += 4
    header.writeUInt32LE(16, offset); offset += 4              // Subchunk1Size (16 for PCM)
    header.writeUInt16LE(audioFormat, offset); offset += 2    // AudioFormat
    header.writeUInt16LE(channels, offset); offset += 2       // NumChannels
    header.writeUInt32LE(sampleRate, offset); offset += 4     // SampleRate
    header.writeUInt32LE(byteRate, offset); offset += 4       // ByteRate
    header.writeUInt16LE(blockAlign, offset); offset += 2     // BlockAlign
    header.writeUInt16LE(bitDepth, offset); offset += 2       // BitsPerSample

    // data sub-chunk
    header.write('data', offset); offset += 4
    header.writeUInt32LE(this.dataSize, offset); offset += 4  // Subchunk2Size

    // Write at beginning of file
    fs.writeSync(this.fd, header, 0, 44, 0)
  }

  /**
   * Write audio data
   * @param {Buffer} data - Audio data to write
   */
  write(data) {
    if (this.finalized) {
      throw new Error('WavWriter already finalized')
    }

    if (!Buffer.isBuffer(data)) {
      data = Buffer.from(data)
    }

    try {
      fs.writeSync(this.fd, data, 0, data.length, 44 + this.dataSize)
      this.dataSize += data.length
    } catch (err) {
      console.error(`[WavWriter] Error writing audio data: ${err.message}`)
      // Re-throw to let caller handle critical failures
      throw err
    }
  }

  /**
   * Finalize the WAV file
   * Updates header with actual data size
   * @returns {Object} - File info
   */
  finalize() {
    if (this.finalized) return

    // Rewrite header with actual size
    this.writeHeader()

    fs.closeSync(this.fd)
    this.finalized = true

    const durationMs = (this.dataSize / this.format.bytesPerSample / this.format.sampleRate) * 1000

    return {
      path: this.filePath,
      size: 44 + this.dataSize,
      dataSize: this.dataSize,
      durationMs,
      durationSec: durationMs / 1000,
      format: this.format.name
    }
  }

  /**
   * Get current recording duration in milliseconds
   * @returns {number}
   */
  getDurationMs() {
    return (this.dataSize / this.format.bytesPerSample / this.format.sampleRate) * 1000
  }
}

module.exports = WavWriter

