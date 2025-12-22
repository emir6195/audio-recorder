/**
 * WebSocketServer
 * 
 * Handles WebSocket connections for audio streaming.
 * 
 * Connection URL:
 *   ws://localhost:3001?channel=web&sessionId=xxx
 * 
 * Channels:
 *   - web    → PCM16 24kHz
 *   - twilio → μ-Law 8kHz
 *   - cbot   → μ-Law 8kHz
 * 
 * Protocol (Compatible with existing client):
 * 
 * Client → Server:
 *   { "mode": "user", "delta": "base64..." }   // User audio
 *   { "mode": "bot", "delta": "base64..." }    // Bot audio
 *   { "trim": true }                           // Interrupt (bot sözü kesildi)
 *   { "end": true }                            // Session bitir
 *   { "status": true }                         // Durum sorgula
 * 
 * Server → Client:
 *   { "type": "started", "sessionId": string, "format": string, "channel": string }
 *   { "type": "trimmed", "bytesDiscarded": number, "msDiscarded": number }
 *   { "type": "ended", "sessionId": string, "recording": {...}, "stats": {...} }
 *   { "type": "status", ... }
 *   { "type": "error", "message": string }
 */

const WebSocket = require('ws')
const { v4: uuidv4 } = require('uuid')
const url = require('url')
const CallSession = require('./CallSession')
const { FORMATS, SERVER_CONFIG } = require('./config')

// Channel to format mapping
const CHANNEL_FORMATS = {
  web: FORMATS.PCM16_24K,
  twilio: FORMATS.ULAW_8K,
  cbot: FORMATS.ULAW_8K
}

class WebSocketServer {
  /**
   * @param {number} port - Server port
   * @param {string} recordingsDir - Directory for recordings
   */
  constructor(port = SERVER_CONFIG.port, recordingsDir = SERVER_CONFIG.recordingsDir) {
    this.port = port
    this.recordingsDir = recordingsDir
    this.wss = null
    this.sessions = new Map() // ws → { session: CallSession, channel: string }
  }

  /**
   * Start the WebSocket server
   */
  start() {
    this.wss = new WebSocket.Server({ port: this.port })

    console.log(`🎙️  Audio Recorder WebSocket Server`)
    console.log(`📡 Listening on ws://localhost:${this.port}`)
    console.log(`📁 Recordings: ${this.recordingsDir}`)
    console.log(``)
    console.log(`Channels:`)
    console.log(`  - web:    PCM16 24kHz (${FORMATS.PCM16_24K.frameBytes} bytes/frame)`)
    console.log(`  - twilio: μ-Law 8kHz (${FORMATS.ULAW_8K.frameBytes} bytes/frame)`)
    console.log(`  - cbot:   μ-Law 8kHz (${FORMATS.ULAW_8K.frameBytes} bytes/frame)`)
    console.log(``)
    console.log(`Connect: ws://localhost:${this.port}?channel=web&sessionId=xxx`)
    console.log(``)

    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req))

    return this
  }

  /**
   * Handle new WebSocket connection
   * Auto-starts session based on URL params
   * @param {WebSocket} ws
   * @param {http.IncomingMessage} req
   */
  handleConnection(ws, req) {
    // Parse URL params
    const parsedUrl = url.parse(req.url, true)
    const { channel, sessionId } = parsedUrl.query

    console.log(`[${new Date().toISOString()}] New connection - channel: ${channel}, sessionId: ${sessionId}`)

    // Validate channel
    const format = CHANNEL_FORMATS[channel]
    if (!format) {
      console.error(`Invalid channel: ${channel}`)
      this.sendError(ws, `Invalid channel: ${channel}. Use: web, twilio, cbot`)
      ws.close()
      return
    }

    // Auto-start session
    const finalSessionId = sessionId || uuidv4()
    const session = new CallSession(finalSessionId, format, this.recordingsDir)

    // Setup callbacks
    session.onEnd = (summary) => {
      console.log(`[${finalSessionId}] Session ended:`, summary.recording.path)
    }

    // Store session with metadata
    this.sessions.set(ws, {
      session,
      channel,
      sessionId: finalSessionId
    })

    console.log(`[${finalSessionId}] Started (${channel} → ${format.name})`)

    // Send started confirmation
    this.send(ws, {
      type: 'started',
      sessionId: finalSessionId,
      channel,
      format: format.name
    })

    // Setup message handlers
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        this.handleMessage(ws, msg)
      } catch (err) {
        this.sendError(ws, `Invalid JSON: ${err.message}`)
      }
    })

    ws.on('close', () => {
      this.handleDisconnect(ws)
    })

    ws.on('error', (err) => {
      console.error(`WebSocket error:`, err)
      this.handleDisconnect(ws)
    })
  }

  /**
   * Handle incoming message
   * Compatible with: { mode: 'user'/'bot', delta: base64 } and { trim: true }
   * @param {WebSocket} ws
   * @param {Object} msg
   */
  handleMessage(ws, msg) {
    const sessionData = this.sessions.get(ws)
    if (!sessionData) {
      this.sendError(ws, 'No active session')
      return
    }

    const { session, sessionId } = sessionData
    const shortId = sessionId.substring(0, 8)

    // Handle mode-based audio (user/bot)
    if (msg.mode) {
      const audioData = msg.delta || msg.data || msg.audio || msg.pcm
      if (!audioData) {
        this.sendError(ws, `Missing audio data in ${msg.mode} message`)
        return
      }

      const dataSize = Buffer.from(audioData, 'base64').length
      // console.log(`[${shortId}] 📨 WS ${msg.mode.toUpperCase()} audio: ${dataSize}b`)

      if (msg.mode === 'user') {
        session.handleUserAudio(audioData)
      } else if (msg.mode === 'bot') {
        session.handleBotAudio(audioData)
      } else {
        this.sendError(ws, `Unknown mode: ${msg.mode}`)
      }
      return
    }

    // Handle trim (interrupt)
    if (msg.trim === true) {
      const info = session.handleInterrupt()

      console.log(`[${sessionId}] Trim: discarded ${info.bytesDiscarded} bytes (${info.msDiscarded.toFixed(0)}ms)`)

      this.send(ws, {
        type: 'trimmed',
        timestamp: info.timestamp,
        frameNumber: info.frameNumber,
        bytesDiscarded: info.bytesDiscarded,
        msDiscarded: info.msDiscarded
      })
      return
    }

    // Handle end
    if (msg.end === true) {
      this.handleEnd(ws)
      return
    }

    // Handle status
    if (msg.status === true) {
      this.handleStatus(ws)
      return
    }

    // Legacy support: type-based messages
    if (msg.type) {
      this.handleLegacyMessage(ws, msg)
      return
    }
  }

  /**
   * Handle legacy type-based messages
   * For backwards compatibility
   */
  handleLegacyMessage(ws, msg) {
    const sessionData = this.sessions.get(ws)
    if (!sessionData) return

    const { session, sessionId } = sessionData

    switch (msg.type) {
      case 'user_audio':
        const userData = msg.pcm || msg.data || msg.delta
        if (userData) session.handleUserAudio(userData)
        break

      case 'bot_audio':
        const botData = msg.pcm || msg.data || msg.delta
        if (botData) session.handleBotAudio(botData)
        break

      case 'interrupt':
        const info = session.handleInterrupt()
        this.send(ws, {
          type: 'interrupted',
          bytesDiscarded: info.bytesDiscarded,
          msDiscarded: info.msDiscarded
        })
        break

      case 'end':
        this.handleEnd(ws)
        break

      case 'status':
        this.handleStatus(ws)
        break
    }
  }

  /**
   * Handle end message
   */
  handleEnd(ws) {
    const sessionData = this.sessions.get(ws)
    if (!sessionData) {
      this.sendError(ws, 'No active session')
      return
    }

    const { session, sessionId, channel } = sessionData
    const summary = session.end()
    this.sessions.delete(ws)

    this.send(ws, {
      type: 'ended',
      ...summary,
      channel
    })
  }

  /**
   * Handle status request
   */
  handleStatus(ws) {
    const sessionData = this.sessions.get(ws)
    if (!sessionData) {
      this.send(ws, { type: 'status', active: false })
      return
    }

    const { session, channel } = sessionData

    this.send(ws, {
      type: 'status',
      channel,
      ...session.getStatus()
    })
  }

  /**
   * Handle disconnect
   */
  handleDisconnect(ws) {
    const sessionData = this.sessions.get(ws)
    if (sessionData) {
      const { session, sessionId } = sessionData
      console.log(`[${sessionId}] Connection closed, ending session...`)
      session.end()
      this.sessions.delete(ws)
    }
  }

  /**
   * Send message to client
   */
  send(ws, msg) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }

  /**
   * Send error to client
   */
  sendError(ws, message) {
    this.send(ws, { type: 'error', message })
    console.error(`Error: ${message}`)
  }

  /**
   * Stop the server
   */
  stop() {
    // End all sessions
    for (const [ws, sessionData] of this.sessions) {
      sessionData.session.end()
    }
    this.sessions.clear()

    // Close server
    if (this.wss) {
      this.wss.close()
      this.wss = null
    }

    console.log('Server stopped')
  }

  /**
   * Get all active sessions
   */
  getActiveSessions() {
    const sessions = []
    for (const [ws, sessionData] of this.sessions) {
      sessions.push({
        channel: sessionData.channel,
        ...sessionData.session.getStatus()
      })
    }
    return sessions
  }
}

module.exports = WebSocketServer
