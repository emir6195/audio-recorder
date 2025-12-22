/**
 * AudioMixer
 * 
 * PCM16 audio mixing utilities.
 * Handles safe mixing with clipping prevention.
 */

const UlawCodec = require('./UlawCodec')

/**
 * Create a silence buffer of given size
 * @param {number} size - Buffer size in bytes
 * @param {string} encoding - 'pcm16' or 'ulaw'
 * @returns {Buffer}
 */
function silence(size, encoding = 'pcm16') {
  const buf = Buffer.alloc(size)
  
  // For μ-Law, silence is 0xFF (or 0x7F), NOT 0x00!
  // 0x00 in μ-Law is actually a loud sound!
  if (encoding === 'ulaw') {
    buf.fill(0xFF)
  }
  // For PCM16, 0x00 is already silence
  
  return buf
}

/**
 * Pad buffer to target size with silence
 * @param {Buffer} buf - Input buffer
 * @param {number} targetSize - Target size
 * @param {string} encoding - 'pcm16' or 'ulaw'
 * @returns {Buffer}
 */
function pad(buf, targetSize, encoding = 'pcm16') {
  if (buf.length >= targetSize) return buf
  
  const padding = silence(targetSize - buf.length, encoding)
  return Buffer.concat([buf, padding])
}

/**
 * Mix two PCM16 buffers with clipping prevention
 * @param {Buffer} a - First PCM16 buffer
 * @param {Buffer} b - Second PCM16 buffer
 * @returns {Buffer} - Mixed PCM16 buffer
 */
function mixPcm16(a, b) {
  const len = Math.max(a.length, b.length)
  const out = Buffer.alloc(len)
  
  // Ensure both buffers are same length
  const bufA = a.length < len ? pad(a, len, 'pcm16') : a
  const bufB = b.length < len ? pad(b, len, 'pcm16') : b
  
  for (let i = 0; i < len; i += 2) {
    const sampleA = bufA.readInt16LE(i)
    const sampleB = bufB.readInt16LE(i)
    
    // Sum and clip
    let sum = sampleA + sampleB
    sum = Math.max(-32768, Math.min(32767, sum))
    
    out.writeInt16LE(sum, i)
  }
  
  return out
}

/**
 * Mix two μ-Law buffers
 * @param {Buffer} a - First μ-Law buffer
 * @param {Buffer} b - Second μ-Law buffer
 * @returns {Buffer} - Mixed μ-Law buffer
 */
function mixUlaw(a, b) {
  return UlawCodec.mixUlaw(a, b)
}

/**
 * Get mixer function for encoding type
 * @param {string} encoding - 'pcm16' or 'ulaw'
 * @returns {Function}
 */
function getMixer(encoding) {
  return encoding === 'ulaw' ? mixUlaw : mixPcm16
}

module.exports = {
  silence,
  pad,
  mixPcm16,
  mixUlaw,
  getMixer
}
