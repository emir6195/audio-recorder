/**
 * Test Client for Audio Recorder
 * 
 * Compatible with existing client protocol:
 *   { mode: 'user', delta: base64 }
 *   { mode: 'bot', delta: base64 }
 *   { trim: true }
 * 
 * Usage:
 *   node test-client.js [channel]
 * 
 * Channel: web (default), twilio, cbot
 */

const WebSocket = require('ws')

const CHANNEL = process.argv[2] || 'web'
const SESSION_ID = `test-${Date.now()}`
const WS_URL = `ws://localhost:8282?channel=${CHANNEL}&sessionId=${SESSION_ID}`

// Channel configs (mirroring server)
const CHANNEL_CONFIGS = {
  web: { sampleRate: 24000, bytesPerSample: 2, encoding: 'pcm16' },
  twilio: { sampleRate: 8000, bytesPerSample: 1, encoding: 'ulaw' },
  cbot: { sampleRate: 8000, bytesPerSample: 1, encoding: 'ulaw' }
}

const config = CHANNEL_CONFIGS[CHANNEL]
if (!config) {
  console.error(`Unknown channel: ${CHANNEL}. Use: web, twilio, cbot`)
  process.exit(1)
}

const FRAME_MS = 20
const frameBytes = (config.sampleRate / 1000) * FRAME_MS * config.bytesPerSample

console.log(`🧪 Test Client for Audio Recorder`)
console.log(`📡 Connecting to ${WS_URL}`)
console.log(`📺 Channel: ${CHANNEL}`)
console.log(`🎵 Format: ${config.encoding} ${config.sampleRate}Hz (${frameBytes} bytes/frame)`)
console.log(``)

/**
 * Generate test audio (sine wave)
 */
function generateSineWave(durationMs, frequency = 440) {
  const numSamples = (config.sampleRate / 1000) * durationMs

  if (config.encoding === 'ulaw') {
    const buffer = Buffer.alloc(numSamples)
    for (let i = 0; i < numSamples; i++) {
      const t = i / config.sampleRate
      const sample = Math.sin(2 * Math.PI * frequency * t)
      const pcm = Math.floor(sample * 32767 * 0.5)
      buffer[i] = linearToUlaw(pcm)
    }
    return buffer
  } else {
    const buffer = Buffer.alloc(numSamples * 2)
    for (let i = 0; i < numSamples; i++) {
      const t = i / config.sampleRate
      const sample = Math.sin(2 * Math.PI * frequency * t)
      const value = Math.floor(sample * 32767 * 0.5)
      buffer.writeInt16LE(value, i * 2)
    }
    return buffer
  }
}

/**
 * PCM16 to μ-Law conversion
 */
function linearToUlaw(sample) {
  const BIAS = 0x84
  const CLIP = 32635

  let sign = (sample >> 8) & 0x80
  if (sign !== 0) sample = -sample
  if (sample > CLIP) sample = CLIP
  sample += BIAS

  const exponent = Math.floor(Math.log2(sample)) - 7
  const exp = Math.max(0, Math.min(7, exponent))
  const mantissa = (sample >> (exp + 3)) & 0x0F

  return ~(sign | (exp << 4) | mantissa) & 0xFF
}

/**
 * Generate silence
 */
function generateSilence(durationMs) {
  const numSamples = (config.sampleRate / 1000) * durationMs
  const buffer = Buffer.alloc(numSamples * config.bytesPerSample)

  if (config.encoding === 'ulaw') {
    buffer.fill(0xFF) // μ-Law silence
  }

  return buffer
}

// Connect
const ws = new WebSocket(WS_URL)

ws.on('open', () => {
  console.log('✅ Connected!')
  console.log('')
})

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString())
  console.log(`← ${msg.type}:`, JSON.stringify(msg, null, 2))

  if (msg.type === 'started') {
    runTest()
  }

  if (msg.type === 'ended') {
    console.log('')
    console.log('🎉 Test complete!')
    console.log(`📁 Recording: ${msg.recording.path}`)
    console.log(`⏱️  Duration: ${msg.recording.durationSec.toFixed(2)}s`)
    ws.close()
    process.exit(0)
  }
})

ws.on('error', (err) => {
  console.error('❌ WebSocket error:', err.message)
  process.exit(1)
})

ws.on('close', () => {
  console.log('Connection closed')
})

/**
 * Run the test scenario
 * Uses the compatible protocol: { mode, delta } and { trim: true }
 */
async function runTest() {
  console.log('')
  console.log('🎬 Starting test scenario (using compatible protocol)...')
  console.log('')

  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

  // Helper functions using COMPATIBLE PROTOCOL
  const sendUserAudio = (buffer) => {
    ws.send(JSON.stringify({
      mode: 'user',
      delta: buffer.toString('base64')
    }))
  }

  const sendBotAudio = (buffer) => {
    ws.send(JSON.stringify({
      mode: 'bot',
      delta: buffer.toString('base64')
    }))
  }

  const sendTrim = () => {
    ws.send(JSON.stringify({ trim: true }))
  }

  const sendEnd = () => {
    ws.send(JSON.stringify({ end: true }))
  }

  // ========================================
  // TEST SCENARIO
  // ========================================

  // 1. User speaks for 500ms
  console.log('📢 [0-500ms] User speaking...')
  for (let i = 0; i < 25; i++) {
    sendUserAudio(generateSineWave(20, 300))
    await sleep(20)
  }

  // 2. Bot starts responding - send 2s of audio quickly
  console.log('🤖 [500ms] Bot starts speaking (sending 2s of audio in bursts)...')
  for (let i = 0; i < 10; i++) {
    sendBotAudio(generateSineWave(200, 500))
    await sleep(50)
  }

  // 3. User silence while bot plays
  console.log('🔇 [500-1500ms] User silent, bot playing...')
  for (let i = 0; i < 50; i++) {
    sendUserAudio(generateSilence(20))
    await sleep(20)
  }

  // 4. USER INTERRUPTS! (using trim: true)
  console.log('✋ [1500ms] USER INTERRUPTS! (sending trim: true)')
  sendTrim()
  await sleep(100)

  // 5. User speaks again
  console.log('📢 [1500-2000ms] User speaking after interrupt...')
  for (let i = 0; i < 25; i++) {
    sendUserAudio(generateSineWave(20, 350))
    await sleep(20)
  }

  // 6. Bot responds again
  console.log('🤖 [2000ms] Bot responds again (500ms of audio)...')
  for (let i = 0; i < 5; i++) {
    sendBotAudio(generateSineWave(100, 550))
    await sleep(30)
  }

  // 7. Let it play out
  console.log('🔇 [2000-2500ms] Finishing...')
  for (let i = 0; i < 25; i++) {
    sendUserAudio(generateSilence(20))
    await sleep(20)
  }

  // 8. End session
  console.log('')
  console.log('🛑 Ending session... (sending end: true and closing)')
  sendEnd()
  await sleep(500)
  ws.close()
}
