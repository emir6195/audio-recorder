/**
 * μ-Law (G.711) Codec
 * 
 * Standard telephony audio encoding/decoding.
 * Converts between PCM16 and 8-bit μ-Law.
 */

const BIAS = 0x84
const CLIP = 32635

// μ-Law encoding table
const encodeTable = [
  0, 0, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3,
  4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,
  5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
  5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7
]

// μ-Law decoding table (μ-Law byte → PCM16 value)
const decodeTable = new Int16Array([
  -32124, -31100, -30076, -29052, -28028, -27004, -25980, -24956,
  -23932, -22908, -21884, -20860, -19836, -18812, -17788, -16764,
  -15996, -15484, -14972, -14460, -13948, -13436, -12924, -12412,
  -11900, -11388, -10876, -10364, -9852, -9340, -8828, -8316,
  -7932, -7676, -7420, -7164, -6908, -6652, -6396, -6140,
  -5884, -5628, -5372, -5116, -4860, -4604, -4348, -4092,
  -3900, -3772, -3644, -3516, -3388, -3260, -3132, -3004,
  -2876, -2748, -2620, -2492, -2364, -2236, -2108, -1980,
  -1884, -1820, -1756, -1692, -1628, -1564, -1500, -1436,
  -1372, -1308, -1244, -1180, -1116, -1052, -988, -924,
  -876, -844, -812, -780, -748, -716, -684, -652,
  -620, -588, -556, -524, -492, -460, -428, -396,
  -372, -356, -340, -324, -308, -292, -276, -260,
  -244, -228, -212, -196, -180, -164, -148, -132,
  -120, -112, -104, -96, -88, -80, -72, -64,
  -56, -48, -40, -32, -24, -16, -8, 0,
  32124, 31100, 30076, 29052, 28028, 27004, 25980, 24956,
  23932, 22908, 21884, 20860, 19836, 18812, 17788, 16764,
  15996, 15484, 14972, 14460, 13948, 13436, 12924, 12412,
  11900, 11388, 10876, 10364, 9852, 9340, 8828, 8316,
  7932, 7676, 7420, 7164, 6908, 6652, 6396, 6140,
  5884, 5628, 5372, 5116, 4860, 4604, 4348, 4092,
  3900, 3772, 3644, 3516, 3388, 3260, 3132, 3004,
  2876, 2748, 2620, 2492, 2364, 2236, 2108, 1980,
  1884, 1820, 1756, 1692, 1628, 1564, 1500, 1436,
  1372, 1308, 1244, 1180, 1116, 1052, 988, 924,
  876, 844, 812, 780, 748, 716, 684, 652,
  620, 588, 556, 524, 492, 460, 428, 396,
  372, 356, 340, 324, 308, 292, 276, 260,
  244, 228, 212, 196, 180, 164, 148, 132,
  120, 112, 104, 96, 88, 80, 72, 64,
  56, 48, 40, 32, 24, 16, 8, 0
])

/**
 * Encode a single PCM16 sample to μ-Law
 * @param {number} sample - PCM16 sample (-32768 to 32767)
 * @returns {number} - μ-Law byte (0-255)
 */
function encodeSample(sample) {
  let sign = (sample >> 8) & 0x80
  if (sign !== 0) sample = -sample
  if (sample > CLIP) sample = CLIP
  sample += BIAS
  
  const exponent = encodeTable[(sample >> 7) & 0xFF]
  const mantissa = (sample >> (exponent + 3)) & 0x0F
  
  return ~(sign | (exponent << 4) | mantissa) & 0xFF
}

/**
 * Decode a single μ-Law byte to PCM16
 * @param {number} ulaw - μ-Law byte (0-255)
 * @returns {number} - PCM16 sample
 */
function decodeSample(ulaw) {
  return decodeTable[ulaw]
}

/**
 * Encode PCM16 buffer to μ-Law buffer
 * @param {Buffer} pcm16 - PCM16 audio data
 * @returns {Buffer} - μ-Law encoded data
 */
function encode(pcm16) {
  const numSamples = pcm16.length / 2
  const ulaw = Buffer.alloc(numSamples)
  
  for (let i = 0; i < numSamples; i++) {
    const sample = pcm16.readInt16LE(i * 2)
    ulaw[i] = encodeSample(sample)
  }
  
  return ulaw
}

/**
 * Decode μ-Law buffer to PCM16 buffer
 * @param {Buffer} ulaw - μ-Law encoded data
 * @returns {Buffer} - PCM16 audio data
 */
function decode(ulaw) {
  const pcm16 = Buffer.alloc(ulaw.length * 2)
  
  for (let i = 0; i < ulaw.length; i++) {
    const sample = decodeSample(ulaw[i])
    pcm16.writeInt16LE(sample, i * 2)
  }
  
  return pcm16
}

/**
 * Mix two μ-Law buffers (decode → mix → encode)
 * @param {Buffer} a - First μ-Law buffer
 * @param {Buffer} b - Second μ-Law buffer
 * @returns {Buffer} - Mixed μ-Law buffer
 */
function mixUlaw(a, b) {
  const pcmA = decode(a)
  const pcmB = decode(b)
  const mixed = Buffer.alloc(pcmA.length)
  
  for (let i = 0; i < pcmA.length; i += 2) {
    let sum = pcmA.readInt16LE(i) + pcmB.readInt16LE(i)
    sum = Math.max(-32768, Math.min(32767, sum))
    mixed.writeInt16LE(sum, i)
  }
  
  return encode(mixed)
}

module.exports = {
  encode,
  decode,
  encodeSample,
  decodeSample,
  mixUlaw
}

