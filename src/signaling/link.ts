import type { Bytes } from '../bytes.js'
import { fromBase64Url, toBase64Url } from './codec.js'

export const INVITE_VERSION = 1
export const ROOM_ID_BYTES = 16
export const ROOM_SECRET_BYTES = 32

/** Ключ фрагмента, под которым лежит приглашение. */
export const INVITE_FRAGMENT_KEY = 'j'

export interface Invite {
  /** Адрес сигнального сервера, `wss://…` (или `ws://localhost…` для разработки). */
  server: string
  /** Идентификатор комнаты — единственное, что узнаёт сервер. */
  roomId: string
  /**
   * Секрет комнаты. Живёт только во фрагменте ссылки, поэтому не попадает ни в
   * запросы к серверу, ни в логи, ни в Referer. Им шифруется весь сигналинг и
   * подмешивается в ключи медиа: сервер не может подсунуть свой fingerprint.
   */
  secret: Bytes
}

/** Создаёт приглашение со свежими случайными идентификатором и секретом. */
export function generateInvite(server: string): Invite {
  if (!isAllowedServer(server)) {
    throw new TypeError(`сигнальный сервер должен быть wss://…, получено ${server}`)
  }

  return {
    server: server.trim(),
    roomId: toBase64Url(crypto.getRandomValues(new Uint8Array(ROOM_ID_BYTES))),
    secret: crypto.getRandomValues(new Uint8Array(ROOM_SECRET_BYTES)),
  }
}

/** Собирает ссылку-приглашение: всё полезное уезжает во фрагмент, после `#`. */
export function buildInviteLink(baseUrl: string, invite: Invite): string {
  const server = new TextEncoder().encode(invite.server)
  const roomId = fromBase64Url(invite.roomId)

  if (roomId.length !== ROOM_ID_BYTES) {
    throw new TypeError(`идентификатор комнаты должен занимать ${ROOM_ID_BYTES} байт`)
  }
  if (invite.secret.length !== ROOM_SECRET_BYTES) {
    throw new TypeError(`секрет комнаты должен занимать ${ROOM_SECRET_BYTES} байт`)
  }
  if (server.length === 0 || server.length > 0xffff) {
    throw new TypeError('адрес сервера пустой или неправдоподобно длинный')
  }

  const payload = new Uint8Array(1 + ROOM_SECRET_BYTES + ROOM_ID_BYTES + 2 + server.length)
  payload[0] = INVITE_VERSION
  payload.set(invite.secret, 1)
  payload.set(roomId, 1 + ROOM_SECRET_BYTES)

  const offset = 1 + ROOM_SECRET_BYTES + ROOM_ID_BYTES
  new DataView(payload.buffer).setUint16(offset, server.length)
  payload.set(server, offset + 2)

  const base = baseUrl.split('#')[0] ?? baseUrl
  return `${base}#${INVITE_FRAGMENT_KEY}=${toBase64Url(payload)}`
}

/** Разбирает ссылку-приглашение. Возвращает null на любом отклонении от формата. */
export function parseInviteLink(url: string): Invite | null {
  const hash = url.lastIndexOf('#')
  const fragment = hash >= 0 ? url.slice(hash + 1) : url

  const prefix = `${INVITE_FRAGMENT_KEY}=`
  if (!fragment.startsWith(prefix)) return null

  let payload: Bytes
  try {
    payload = fromBase64Url(fragment.slice(prefix.length).trim())
  } catch {
    return null
  }

  const minimum = 1 + ROOM_SECRET_BYTES + ROOM_ID_BYTES + 2
  if (payload.length < minimum) return null
  if (payload[0] !== INVITE_VERSION) return null

  const offset = 1 + ROOM_SECRET_BYTES + ROOM_ID_BYTES
  const serverLength = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  ).getUint16(offset)

  if (payload.length !== minimum + serverLength) return null

  const server = new TextDecoder().decode(payload.subarray(offset + 2))
  if (!isAllowedServer(server)) return null

  return {
    server,
    roomId: toBase64Url(payload.subarray(1 + ROOM_SECRET_BYTES, offset)),
    secret: payload.slice(1, 1 + ROOM_SECRET_BYTES),
  }
}

/**
 * Страница отдаётся по HTTPS, поэтому обычный `ws://` браузер заблокирует как
 * mixed content. Исключение — localhost: без него невозможно поднять сервер
 * локально и проверить связку.
 */
export function isAllowedServer(server: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(server.trim())
  } catch {
    return false
  }

  if (parsed.protocol === 'wss:') return true
  return parsed.protocol === 'ws:' && isLoopback(parsed.hostname)
}

function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}
