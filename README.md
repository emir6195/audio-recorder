# Real-Time Interrupt-Aware Call Recorder

Production-grade audio recording system for telephony applications with interrupt support.

## Features

- **Dual Format Support**
  - 24kHz mono PCM16 (high quality) - `web` channel
  - 8kHz mono μ-Law (telephony standard, G.711) - `twilio`, `cbot` channels

- **Real-Time Processing**
  - Frame-based scheduler (20ms frames)
  - Accurate timeline regardless of network jitter
  - Buffer management for async bot audio

- **Interrupt Handling**
  - Instant bot audio cutoff on `trim: true`
  - Discards buffered bot audio that wasn't played
  - Records only what was actually heard

- **WAV Recording**
  - Proper header with correct format info
  - Mixed user + bot audio
  - Accurate duration tracking

## Installation

```bash
npm install
```

## Usage

### Start Server

```bash
npm start
# or with PM2
pm2 start index.js --name audio-recorder
```

Server runs on `ws://localhost:8282`

### Connection

Connect with channel and sessionId in URL:

```javascript
const ws = new WebSocket('ws://localhost:8282?channel=web&sessionId=my-session-123')
```

### Channels

| Channel | Format | Sample Rate | Use Case |
|---------|--------|-------------|----------|
| `web` | PCM16 | 24kHz | Web browser |
| `twilio` | μ-Law | 8kHz | Twilio telephony |
| `cbot` | μ-Law | 8kHz | Cbot platform |

## WebSocket Protocol

### Connection Response

```json
← { "type": "started", "sessionId": "...", "channel": "web", "format": "pcm16_24k" }
```

### Send User Audio

```javascript
ws.send(JSON.stringify({ mode: 'user', delta: base64Audio }))
```

### Send Bot Audio

```javascript
ws.send(JSON.stringify({ mode: 'bot', delta: base64Audio }))
```

Bot audio is buffered and played back at the correct rate. Can send faster than real-time.

### Interrupt (User Speaks Over Bot)

```javascript
ws.send(JSON.stringify({ trim: true }))
```

Response:
```json
← { "type": "trimmed", "bytesDiscarded": 12800, "msDiscarded": 533 }
```

Immediately stops bot playback and clears buffer. Response shows how much audio was discarded.

### End Session

```javascript
ws.send(JSON.stringify({ end: true }))
```

Response:
```json
← { 
    "type": "ended",
    "sessionId": "...",
    "channel": "web",
    "recording": {
      "path": "./recordings/abc123_2024-01-15T10-30-45-000Z.wav",
      "size": 192044,
      "durationSec": 4.0
    },
    "stats": { ... }
  }
```

### Get Status

```javascript
ws.send(JSON.stringify({ status: true }))
```

Response:
```json
← { 
    "type": "status",
    "active": true,
    "channel": "web",
    "uptime": 5000,
    "frameCount": 250,
    "userBufferSize": 320,
    "botState": "PLAYING",
    "botBufferSize": 12800
  }
```

## Client Integration Example

```javascript
class AudioRecorderClient {
  constructor(channel, sessionId) {
    this.url = `ws://localhost:8282?channel=${channel}&sessionId=${sessionId}`
    this.ws = new WebSocket(this.url)
    
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data)
      console.log('Received:', msg.type)
    }
  }

  sendUserAudio(base64Audio) {
    this.ws.send(JSON.stringify({ mode: 'user', delta: base64Audio }))
  }

  sendBotAudio(base64Audio) {
    this.ws.send(JSON.stringify({ mode: 'bot', delta: base64Audio }))
  }

  interrupt() {
    this.ws.send(JSON.stringify({ trim: true }))
  }

  end() {
    this.ws.send(JSON.stringify({ end: true }))
  }
}

// Usage
const recorder = new AudioRecorderClient('web', 'session-123')
recorder.sendUserAudio(userAudioBase64)
recorder.sendBotAudio(botAudioBase64)
recorder.interrupt()  // When user speaks over bot
recorder.end()
```

## Architecture

```
┌────────────────────────────────────────┐
│ WebSocket Connection                   │
│ ws://host:8282?channel=web&sessionId=x │
└─────────────────┬──────────────────────┘
                  ↓
┌─────────────────────────────────────────┐
│ Channel → Format Mapping                │
│ web → PCM16 24k | twilio/cbot → μ-Law 8k│
└─────────────────┬───────────────────────┘
                  ↓
┌───────────────────────────────────────┐
│ Audio Buffers                         │
│ ├─ UserBuffer (continuous)            │
│ └─ BotBuffer (chunk-based, can burst) │
└─────────────────┬─────────────────────┘
                  ↓
┌───────────────────────────────────────┐
│ Bot Playback FSM                      │
│ IDLE ←→ PLAYING ←→ STOPPED (trim)     │
└─────────────────┬─────────────────────┘
                  ↓
┌───────────────────────────────────────┐
│ Frame Mixer (20ms interval)           │
│ user_frame + bot_frame → mixed_frame  │
└─────────────────┬─────────────────────┘
                  ↓
┌───────────────────────────────────────┐
│ WAV Recorder                          │
│ recordings/sessionId_timestamp.wav    │
└───────────────────────────────────────┘
```

## Audio Format Details

### PCM16 24kHz (web channel)

| Property | Value |
|----------|-------|
| Sample Rate | 24000 Hz |
| Channels | 1 (mono) |
| Bit Depth | 16-bit |
| Frame Duration | 20ms |
| Frame Size | 960 bytes |
| Encoding | Little-endian signed int16 |

### μ-Law 8kHz (twilio, cbot channels)

| Property | Value |
|----------|-------|
| Sample Rate | 8000 Hz |
| Channels | 1 (mono) |
| Bit Depth | 8-bit |
| Frame Duration | 20ms |
| Frame Size | 160 bytes |
| Encoding | G.711 μ-Law |

## Project Structure

```
.
├── index.js                 # Entry point
├── src/
│   ├── config.js           # Format configurations
│   ├── AudioBufferQueue.js # Byte stream buffer
│   ├── AudioMixer.js       # PCM16/μ-Law mixing
│   ├── BotPlayback.js      # Playback FSM
│   ├── CallSession.js      # Session management
│   ├── UlawCodec.js        # G.711 μ-Law codec
│   ├── WavWriter.js        # WAV file writer
│   └── WebSocketServer.js  # WebSocket handler
├── recordings/             # Output directory
├── test-client.js          # Test client
└── package.json
```

## Test Client

```bash
# Test web channel (PCM16 24kHz)
node test-client.js web

# Test twilio channel (μ-Law 8kHz)
node test-client.js twilio

# Test cbot channel (μ-Law 8kHz)
node test-client.js cbot
```

## Key Concepts

### Global Call Clock

The frame scheduler runs at a fixed 20ms interval, ensuring the recording timeline is accurate regardless of when audio chunks arrive.

### Bot Audio Buffering

Bot audio can arrive faster than real-time (e.g., LLM streaming 5 seconds of audio in 1 second). The system buffers this and plays back at the correct rate.

### Interrupt Handling (trim)

When the user speaks over the bot, you send `{ trim: true }`. This:
1. Immediately stops bot playback
2. Clears all buffered bot audio
3. Records silence for bot track going forward
4. Reports how much audio was discarded

The recording captures only what was actually heard - no "ghost" bot audio after an interrupt.

## License

ISC
