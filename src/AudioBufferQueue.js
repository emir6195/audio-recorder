/**
 * AudioBufferQueue
 * 
 * Manages incoming audio chunks as a continuous byte stream.
 * Allows pulling exact frame sizes for consistent timing.
 */

class AudioBufferQueue {
  constructor() {
    this.queue = []
    this.totalBytes = 0
  }

  /**
   * Push new audio data to the queue
   * @param {Buffer} buf - Audio data buffer
   */
  push(buf) {
    if (!Buffer.isBuffer(buf)) {
      buf = Buffer.from(buf)
    }
    this.queue.push(buf)
    this.totalBytes += buf.length
  }

  /**
   * Pull exact number of bytes from queue
   * @param {number} size - Number of bytes to pull
   * @returns {Buffer|null} - Pulled bytes or null if insufficient data
   */
  pull(size) {
    if (this.totalBytes < size) {
      return null
    }

    const out = Buffer.alloc(size)
    let offset = 0

    while (offset < size && this.queue.length > 0) {
      const head = this.queue[0]
      const need = size - offset

      if (head.length <= need) {
        head.copy(out, offset)
        offset += head.length
        this.totalBytes -= head.length
        this.queue.shift()
      } else {
        head.copy(out, offset, 0, need)
        this.queue[0] = head.slice(need)
        this.totalBytes -= need
        offset += need
      }
    }

    return out
  }

  /**
   * Pull available bytes up to max size (partial allowed)
   * @param {number} maxSize - Maximum bytes to pull
   * @returns {Buffer} - Available bytes (may be less than maxSize)
   */
  pullAvailable(maxSize) {
    const available = Math.min(maxSize, this.totalBytes)
    if (available === 0) {
      return Buffer.alloc(0)
    }
    return this.pull(available) || Buffer.alloc(0)
  }

  /**
   * Clear all buffered data
   */
  clear() {
    this.queue = []
    this.totalBytes = 0
  }

  /**
   * Get current buffer size in bytes
   * @returns {number}
   */
  size() {
    return this.totalBytes
  }

  /**
   * Check if buffer has enough data
   * @param {number} size - Required bytes
   * @returns {boolean}
   */
  hasEnough(size) {
    return this.totalBytes >= size
  }

  /**
   * Trim queue to maximum size (dropping oldest data)
   * @param {number} maxSize - Maximum allowed bytes
   * @returns {number} - Bytes dropped
   */
  trimToSize(maxSize) {
    if (this.totalBytes <= maxSize) {
      return 0
    }

    const initialBytes = this.totalBytes
    const targetRemove = this.totalBytes - maxSize
    let removed = 0

    while (removed < targetRemove && this.queue.length > 0) {
      const head = this.queue[0]
      const neededToRemove = targetRemove - removed

      if (head.length <= neededToRemove) {
        // Remove entire chunk
        removed += head.length
        this.totalBytes -= head.length
        this.queue.shift()
      } else {
        // Slice partial chunk
        const keep = head.length - neededToRemove
        // We want to keep the END of the chunk, so we slice from the offset
        // Wait, we are dropping OLDEST data, so we drop from the START of the chunk
        // head is [dropped | kep]
        // so we keep head.slice(neededToRemove)
        this.queue[0] = head.slice(neededToRemove)
        this.totalBytes -= neededToRemove
        removed += neededToRemove
      }
    }

    return initialBytes - this.totalBytes
  }
}

module.exports = AudioBufferQueue

