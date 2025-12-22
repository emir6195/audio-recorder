/**
 * Real-Time Interrupt-Aware Call Recorder
 * 
 * Production-grade audio recording system for telephony applications.
 * 
 * Features:
 * - 24kHz PCM16 mono support (high quality)
 * - 8kHz μ-Law mono support (telephony standard)
 * - Frame-based mixing (20ms frames)
 * - Interrupt handling (stops bot audio immediately)
 * - WAV recording with accurate timeline
 * 
 * WebSocket Protocol:
 * 
 * To start a session:
 *   → { "type": "start", "format": "pcm16_24k" | "ulaw_8k" }
 *   ← { "type": "started", "sessionId": "...", "format": "..." }
 * 
 * To send user audio:
 *   → { "type": "user_audio", "pcm": "<base64>" }
 * 
 * To send bot audio:
 *   → { "type": "bot_audio", "pcm": "<base64>" }
 * 
 * To interrupt bot (user spoke over bot):
 *   → { "type": "interrupt" }
 *   ← { "type": "interrupted", "bytesDiscarded": N, "msDiscarded": N }
 * 
 * To end session:
 *   → { "type": "end" }
 *   ← { "type": "ended", "recording": {...}, "stats": {...} }
 * 
 * To get status:
 *   → { "type": "status" }
 *   ← { "type": "status", ... }
 */

const WebSocketServer = require('./src/WebSocketServer')
const { SERVER_CONFIG } = require('./src/config')

// Ensure recordings directory exists
const fs = require('fs')
if (!fs.existsSync(SERVER_CONFIG.recordingsDir)) {
  fs.mkdirSync(SERVER_CONFIG.recordingsDir, { recursive: true })
}

// Start server
const server = new WebSocketServer()
server.start()

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...')
  server.stop()
  process.exit(0)
})

process.on('SIGTERM', () => {
  console.log('\nShutting down...')
  server.stop()
  process.exit(0)
})

module.exports = server

