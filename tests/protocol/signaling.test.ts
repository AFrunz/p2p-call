import { describe, expect, it } from 'vitest'
import {
  MAX_PAYLOAD_CHARS,
  decodeClientMessage,
  decodeServerMessage,
  encodeClientMessage,
  encodeServerMessage,
} from '../../src/protocol/signaling.js'
import type { ClientMessage, ServerMessage } from '../../src/protocol/signaling.js'

const ROOM = 'AAAAAAAAAAAAAAAAAAAAAA' // 22 символа base64url = 16 байт

const CLIENT_MESSAGES: ClientMessage[] = [
  { t: 'join', room: ROOM },
  { t: 'signal', payload: 'c2VhbGVk' },
  { t: 'leave' },
]

const SERVER_MESSAGES: ServerMessage[] = [
  { t: 'joined', role: 'initiator', iceServers: [{ urls: ['stun:stun.example.com:3478'] }] },
  {
    t: 'joined',
    role: 'responder',
    iceServers: [
      { urls: ['stun:stun.example.com:3478'] },
      { urls: ['turn:turn.example.com:3478'], username: '1700000000', credential: 'secret' },
    ],
  },
  { t: 'peer-joined' },
  { t: 'peer-left' },
  { t: 'signal', payload: 'c2VhbGVk' },
  { t: 'error', code: 'room-full', message: 'В комнате уже двое.' },
]

describe('сообщения клиента', () => {
  it('переживают round-trip', () => {
    for (const message of CLIENT_MESSAGES) {
      expect(decodeClientMessage(encodeClientMessage(message)), message.t).toEqual(message)
    }
  })

  it('отвергают идентификатор комнаты неверного формата', () => {
    for (const room of ['', 'короткий', `${ROOM}A`, ROOM.replace('A', '+'), '../../etc/passwd']) {
      expect(decodeClientMessage(JSON.stringify({ t: 'join', room })), room).toBeNull()
    }
  })

  it('отвергают нестроковый идентификатор комнаты', () => {
    expect(decodeClientMessage('{"t":"join","room":42}')).toBeNull()
    expect(decodeClientMessage('{"t":"join"}')).toBeNull()
  })

  it('отвергают блоб сверх лимита: сервер не должен ретранслировать что угодно', () => {
    const huge = JSON.stringify({ t: 'signal', payload: 'A'.repeat(MAX_PAYLOAD_CHARS + 1) })
    expect(decodeClientMessage(huge)).toBeNull()
  })

  it('принимают блоб ровно по лимиту', () => {
    const limit = JSON.stringify({ t: 'signal', payload: 'A'.repeat(MAX_PAYLOAD_CHARS) })
    expect(decodeClientMessage(limit)).not.toBeNull()
  })

  it('отвергают пустой блоб', () => {
    expect(decodeClientMessage('{"t":"signal","payload":""}')).toBeNull()
  })

  it('никогда не бросают исключение', () => {
    for (const raw of ['', 'не json', '[]', 'null', '{"t":"drop-tables"}', '{}']) {
      expect(() => decodeClientMessage(raw), raw).not.toThrow()
      expect(decodeClientMessage(raw), raw).toBeNull()
    }
  })
})

describe('сообщения сервера', () => {
  it('переживают round-trip', () => {
    for (const message of SERVER_MESSAGES) {
      expect(decodeServerMessage(encodeServerMessage(message)), message.t).toEqual(message)
    }
  })

  it('отвергают неизвестную роль', () => {
    expect(decodeServerMessage('{"t":"joined","role":"admin","iceServers":[]}')).toBeNull()
  })

  it('отвергают ICE-серверы с посторонней схемой', () => {
    // Подменённый сервер не должен уметь увести трафик на http-эндпоинт.
    for (const url of ['http://evil.example.com', 'javascript:alert(1)', 'ws://evil.example.com']) {
      const raw = JSON.stringify({
        t: 'joined',
        role: 'initiator',
        iceServers: [{ urls: [url] }],
      })
      expect(decodeServerMessage(raw), url).toBeNull()
    }
  })

  it('отвергают ICE-сервер без адресов', () => {
    expect(decodeServerMessage('{"t":"joined","role":"initiator","iceServers":[{"urls":[]}]}')).toBeNull()
    expect(decodeServerMessage('{"t":"joined","role":"initiator","iceServers":[{}]}')).toBeNull()
  })

  it('отвергают неизвестный код ошибки', () => {
    expect(decodeServerMessage('{"t":"error","code":"teapot","message":"нет"}')).toBeNull()
  })

  it('обрезают слишком длинный текст ошибки', () => {
    const raw = JSON.stringify({ t: 'error', code: 'server-error', message: 'я'.repeat(5000) })
    const decoded = decodeServerMessage(raw)

    expect(decoded).not.toBeNull()
    if (decoded?.t === 'error') expect(decoded.message.length).toBeLessThanOrEqual(500)
  })

  it('никогда не бросают исключение', () => {
    for (const raw of ['', 'не json', '[]', '{"t":"joined"}', '{"t":"signal"}']) {
      expect(() => decodeServerMessage(raw), raw).not.toThrow()
      expect(decodeServerMessage(raw), raw).toBeNull()
    }
  })
})
