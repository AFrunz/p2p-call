import type { Role } from '../signaling/types.js'

/**
 * Протокол между браузером и сигнальным сервером.
 *
 * Сервер работает как тупой ретранслятор: поле `payload` для него непрозрачно,
 * внутри лежит запечатанный секретом комнаты блоб (см. signaling/sealed.ts).
 * Этот файл общий для клиента и сервера — проверка ввода должна быть ровно одна.
 */

/** base64url от 16 байт — ровно 22 символа. */
export const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/

/** Потолок на размер блоба: SDP с кандидатами не бывает таким большим. */
export const MAX_PAYLOAD_CHARS = 32 * 1024

export type SignalingErrorCode = 'room-full' | 'bad-request' | 'rate-limited' | 'server-error'

export type ClientMessage =
  | { t: 'join'; room: string }
  | { t: 'signal'; payload: string }
  | { t: 'leave' }

export interface IceServerConfig {
  urls: string[]
  username?: string
  credential?: string
}

export type ServerMessage =
  | { t: 'joined'; role: Role; iceServers: IceServerConfig[] }
  | { t: 'peer-joined' }
  | { t: 'peer-left' }
  | { t: 'signal'; payload: string }
  | { t: 'error'; code: SignalingErrorCode; message: string }

export function encodeClientMessage(message: ClientMessage): string {
  return JSON.stringify(message)
}

export function encodeServerMessage(message: ServerMessage): string {
  return JSON.stringify(message)
}

/** Разбирает сообщение клиента. Возвращает null на любом мусоре, не бросает. */
export function decodeClientMessage(raw: string): ClientMessage | null {
  const source = parseObject(raw)
  if (source === null) return null

  switch (source['t']) {
    case 'join': {
      const room = source['room']
      if (typeof room !== 'string' || !ROOM_ID_PATTERN.test(room)) return null
      return { t: 'join', room }
    }
    case 'signal': {
      const payload = source['payload']
      if (!isPayload(payload)) return null
      return { t: 'signal', payload }
    }
    case 'leave':
      return { t: 'leave' }
    default:
      return null
  }
}

/** Разбирает сообщение сервера. Сервер тоже недоверенный: он мог быть подменён. */
export function decodeServerMessage(raw: string): ServerMessage | null {
  const source = parseObject(raw)
  if (source === null) return null

  switch (source['t']) {
    case 'joined': {
      const role = source['role']
      const iceServers = source['iceServers']
      if (role !== 'initiator' && role !== 'responder') return null
      if (!Array.isArray(iceServers)) return null

      const parsed: IceServerConfig[] = []
      for (const entry of iceServers) {
        const server = parseIceServer(entry)
        if (server === null) return null
        parsed.push(server)
      }
      return { t: 'joined', role: role as Role, iceServers: parsed }
    }
    case 'peer-joined':
      return { t: 'peer-joined' }
    case 'peer-left':
      return { t: 'peer-left' }
    case 'signal': {
      const payload = source['payload']
      if (!isPayload(payload)) return null
      return { t: 'signal', payload }
    }
    case 'error': {
      const code = source['code']
      const message = source['message']
      if (!isErrorCode(code) || typeof message !== 'string') return null
      return { t: 'error', code, message: message.slice(0, 500) }
    }
    default:
      return null
  }
}

function parseObject(raw: string): Record<string, unknown> | null {
  if (raw.length > MAX_PAYLOAD_CHARS * 2) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  return parsed as Record<string, unknown>
}

function isPayload(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PAYLOAD_CHARS
}

function isErrorCode(value: unknown): value is SignalingErrorCode {
  return (
    value === 'room-full' ||
    value === 'bad-request' ||
    value === 'rate-limited' ||
    value === 'server-error'
  )
}

function parseIceServer(value: unknown): IceServerConfig | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null

  const source = value as Record<string, unknown>
  const urls = source['urls']
  if (!Array.isArray(urls) || urls.length === 0) return null

  const parsedUrls: string[] = []
  for (const url of urls) {
    if (typeof url !== 'string' || !/^(stun|turns?):/i.test(url)) return null
    parsedUrls.push(url)
  }

  const username = source['username']
  const credential = source['credential']
  if (username !== undefined && typeof username !== 'string') return null
  if (credential !== undefined && typeof credential !== 'string') return null

  return {
    urls: parsedUrls,
    ...(typeof username === 'string' ? { username } : {}),
    ...(typeof credential === 'string' ? { credential } : {}),
  }
}
