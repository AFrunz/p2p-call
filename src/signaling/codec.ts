import type { Bytes } from '../bytes.js'
import type { Envelope, Role } from './types.js'

/** Магия в начале бинарного конверта — отсекает мусор, вставленный по ошибке. */
export const MAGIC = 0x5032 // "P2"

/** Версия формата кода. Несовпадение — повод честно сказать «обнови вкладку». */
export const FORMAT_VERSION = 1

/** Размер сырого публичного ключа ECDH P-256. */
export const PUBLIC_KEY_BYTES = 65

/** magic(2) + version(1) + role(1) + pubkey(65) + длина SDP(4). */
const HEADER_BYTES = 2 + 1 + 1 + PUBLIC_KEY_BYTES + 4

const ROLE_CODES: Record<Role, number> = { initiator: 0, responder: 1 }
const ROLE_BY_CODE: Record<number, Role> = { 0: 'initiator', 1: 'responder' }

const BASE64URL_RE = /^[A-Za-z0-9_-]*$/

/**
 * Алфавит кода подключения — base32 (RFC 4648).
 *
 * Не base64url: там есть `_` и `-`, а мессенджеры и поля с разметкой съедают
 * `__текст__` как форматирование. Код рассылают любым каналом, поэтому в нём
 * не должно быть ни одного символа, который где-то что-то значит. Плата —
 * примерно четверть длины.
 */
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const BASE32_RE = /^[A-Z2-7]*$/

export class CodeFormatError extends Error {
  constructor(
    message: string,
    readonly kind: 'malformed' | 'version' | 'truncated',
  ) {
    super(message)
    this.name = 'CodeFormatError'
  }
}

async function pump(
  stream: CompressionStream | DecompressionStream,
  data: Bytes,
): Promise<Bytes> {
  const writer = stream.writable.getWriter()
  // На битом коде отваливаются обе стороны потока. Ошибку читающей мы поймаем
  // и превратим в CodeFormatError, а пишущую надо явно погасить, иначе Node
  // роняет процесс необработанным reject.
  void writer
    .write(data)
    .then(() => writer.close())
    .catch(() => undefined)

  return new Uint8Array(await new Response(stream.readable).arrayBuffer())
}

async function deflate(data: Bytes): Promise<Bytes> {
  return pump(new CompressionStream('deflate-raw'), data)
}

async function inflate(data: Bytes): Promise<Bytes> {
  return pump(new DecompressionStream('deflate-raw'), data)
}

/** Упаковывает конверт в компактный код: бинарь -> deflate -> base64url. */
export async function encodeEnvelope(envelope: Envelope): Promise<string> {
  if (envelope.publicKey.length !== PUBLIC_KEY_BYTES) {
    throw new CodeFormatError(
      `публичный ключ должен занимать ${PUBLIC_KEY_BYTES} байт, получено ${envelope.publicKey.length}`,
      'malformed',
    )
  }

  const sdp = new TextEncoder().encode(envelope.sdp)
  const raw = new Uint8Array(HEADER_BYTES + sdp.length)
  const view = new DataView(raw.buffer)

  view.setUint16(0, MAGIC)
  view.setUint8(2, envelope.version)
  view.setUint8(3, ROLE_CODES[envelope.role])
  raw.set(envelope.publicKey, 4)
  view.setUint32(4 + PUBLIC_KEY_BYTES, sdp.length)
  raw.set(sdp, HEADER_BYTES)

  return toBase32(await deflate(raw))
}

/** Разбирает код подключения. Кидает CodeFormatError на любом мусоре. */
export async function decodeEnvelope(code: string): Promise<Envelope> {
  const normalized = normalizeCode(code)
  if (normalized.length === 0) {
    throw new CodeFormatError('код пустой', 'malformed')
  }

  let raw: Uint8Array
  try {
    raw = await inflate(fromBase32(normalized))
  } catch {
    throw new CodeFormatError('код повреждён или это вообще не код подключения', 'malformed')
  }

  if (raw.length < HEADER_BYTES) {
    throw new CodeFormatError('код обрезан: не хватает заголовка', 'truncated')
  }

  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  if (view.getUint16(0) !== MAGIC) {
    throw new CodeFormatError('это не код подключения', 'malformed')
  }

  const version = view.getUint8(2)
  if (version !== FORMAT_VERSION) {
    throw new CodeFormatError(
      `код собран версией ${version}, а мы понимаем только ${FORMAT_VERSION}`,
      'version',
    )
  }

  const role = ROLE_BY_CODE[view.getUint8(3)]
  if (role === undefined) {
    throw new CodeFormatError('неизвестная роль участника', 'malformed')
  }

  const publicKey = raw.slice(4, 4 + PUBLIC_KEY_BYTES)
  const sdpLength = view.getUint32(4 + PUBLIC_KEY_BYTES)
  if (raw.length !== HEADER_BYTES + sdpLength) {
    throw new CodeFormatError('код обрезан: SDP не совпал с заявленной длиной', 'truncated')
  }

  const sdp = new TextDecoder().decode(raw.subarray(HEADER_BYTES))
  return { version, role, publicKey, sdp }
}

/** Терпимо чистит вставленный пользователем код: пробелы, переносы, URL-обёртка. */
export function normalizeCode(raw: string): string {
  const hash = raw.lastIndexOf('#')
  const tail = hash >= 0 ? raw.slice(hash + 1) : raw
  return tail.replace(/\s+/g, '')
}

export function toBase32(bytes: Uint8Array): string {
  let value = 0
  let bits = 0
  let out = ''

  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

export function fromBase32(text: string): Bytes {
  // Регистр не важен: код могли пропустить через что-нибудь, что его меняет.
  const clean = text.toUpperCase()
  if (!BASE32_RE.test(clean)) {
    throw new CodeFormatError('в коде есть символы не из алфавита', 'malformed')
  }

  const out: number[] = []
  let value = 0
  let bits = 0

  for (const symbol of clean) {
    value = (value << 5) | BASE32.indexOf(symbol)
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return new Uint8Array(out)
}

export function toBase64Url(bytes: Uint8Array): string {
  // Порциями, чтобы не упереться в лимит аргументов при большом SDP.
  let binary = ''
  const CHUNK = 0x8000
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK))
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(text: string): Bytes {
  if (!BASE64URL_RE.test(text)) {
    throw new CodeFormatError('в коде есть символы не из базового алфавита', 'malformed')
  }

  const padded = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=')

  let binary: string
  try {
    binary = atob(padded)
  } catch {
    throw new CodeFormatError('код не разбирается как base64url', 'malformed')
  }

  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
