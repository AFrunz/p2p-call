import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import { ConfigError, loadConfig } from './config.js'
import type { Config } from './config.js'
import { RoomRegistry } from './rooms.js'
import type { Peer } from './rooms.js'
import { buildIceServers } from './turn.js'
import {
  MAX_PAYLOAD_CHARS,
  decodeClientMessage,
  encodeServerMessage,
} from '../../src/protocol/signaling.js'
import type { ServerMessage } from '../../src/protocol/signaling.js'

let config: Config
try {
  config = loadConfig()
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`Ошибка конфигурации: ${error.message}`)
    process.exit(1)
  }
  throw error
}

const rooms = new RoomRegistry(config.maxRooms, config.roomTtlMs)

const http = createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ status: 'ok', rooms: rooms.size }))
    return
  }
  response.writeHead(404).end()
})

const wss = new WebSocketServer({
  server: http,
  path: '/ws',
  // Запас поверх лимита протокола: всё, что больше, рвём на уровне транспорта.
  maxPayload: MAX_PAYLOAD_CHARS * 2 + 1024,
})

interface Session {
  peer: Peer
  joined: boolean
  /** Токены для ограничения частоты сообщений. */
  tokens: number
  lastRefill: number
}

const sessions = new WeakMap<WebSocket, Session>()

wss.on('connection', (socket) => {
  const peer: Peer = {
    send: (raw) => {
      if (socket.readyState === socket.OPEN) socket.send(raw)
    },
    close: () => socket.close(),
  }

  const session: Session = { peer, joined: false, tokens: config.messageRateLimit, lastRefill: Date.now() }
  sessions.set(socket, session)

  socket.on('message', (data, isBinary) => {
    // Протокол текстовый: бинарные кадры сюда попадать не должны.
    if (isBinary) return void fail(socket, session, 'bad-request', 'Ожидался текстовый кадр.')
    if (!allow(session)) {
      return void fail(socket, session, 'rate-limited', 'Слишком много сообщений, соединение закрыто.')
    }

    const message = decodeClientMessage(data.toString())
    if (message === null) {
      return void fail(socket, session, 'bad-request', 'Сообщение не соответствует протоколу.')
    }

    switch (message.t) {
      case 'join': {
        if (session.joined) {
          return void fail(socket, session, 'bad-request', 'Повторный join в одном соединении.')
        }

        const result = rooms.join(message.room, peer)
        if (!result.ok) {
          const text =
            result.reason === 'room-full'
              ? 'В этой комнате уже двое участников.'
              : 'Сервер загружен: слишком много активных комнат.'
          return void fail(socket, session, result.reason === 'room-full' ? 'room-full' : 'server-error', text)
        }

        session.joined = true
        send(peer, { t: 'joined', role: result.role, iceServers: buildIceServers(config) })
        if (result.peer !== null) {
          send(result.peer, { t: 'peer-joined' })
          send(peer, { t: 'peer-joined' })
        }
        return
      }

      case 'signal': {
        if (!session.joined) {
          return void fail(socket, session, 'bad-request', 'Сначала нужно войти в комнату.')
        }
        // Содержимое не разбираем и не логируем: оно зашифровано секретом
        // комнаты, которого у сервера нет и быть не должно.
        const partner = rooms.partnerOf(peer)
        if (partner !== null) send(partner, { t: 'signal', payload: message.payload })
        return
      }

      case 'leave': {
        const partner = rooms.leave(peer)
        session.joined = false
        if (partner !== null) send(partner, { t: 'peer-left' })
        return
      }
    }
  })

  socket.on('close', () => {
    const partner = rooms.leave(peer)
    if (partner !== null) send(partner, { t: 'peer-left' })
  })

  socket.on('error', () => socket.close())
})

/** Токен-бакет: равномерно пополняем разрешения раз в секунду. */
function allow(session: Session, now: number = Date.now()): boolean {
  const elapsed = now - session.lastRefill
  if (elapsed >= 1000) {
    session.tokens = config.messageRateLimit
    session.lastRefill = now
  }
  if (session.tokens <= 0) return false

  session.tokens--
  return true
}

function send(peer: Peer, message: ServerMessage): void {
  peer.send(encodeServerMessage(message))
}

function fail(
  socket: WebSocket,
  session: Session,
  code: 'bad-request' | 'room-full' | 'rate-limited' | 'server-error',
  message: string,
): void {
  send(session.peer, { t: 'error', code, message })
  socket.close()
}

const sweeper = setInterval(() => rooms.collect(), 60_000)
sweeper.unref()

http.listen(config.port, () => {
  const turn = config.turnHost === null ? 'без TURN' : `TURN на ${config.turnHost}:${config.turnPort}`
  console.log(`Сигнальный сервер слушает порт ${config.port} (${turn}).`)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    wss.close()
    http.close(() => process.exit(0))
  })
}
