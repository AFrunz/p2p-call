import type { Bytes } from '../bytes.js'
import { fromBase64Url, toBase64Url } from './codec.js'

const NONCE_BYTES = 12
const TAG_BYTES = 16
const encoder = new TextEncoder()
const decoder = new TextDecoder()

export class SealError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SealError'
  }
}

/**
 * Ключ, которым шифруется весь обмен через сигнальный сервер.
 *
 * Выводится из секрета комнаты, а тот живёт только во фрагменте ссылки. Поэтому
 * сервер видит лишь непрозрачные блобы: подменить SDP или DTLS-fingerprint,
 * чтобы влезть в середину, он не может.
 */
export async function deriveSignalingKey(roomSecret: Bytes): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', roomSecret, 'HKDF', false, ['deriveBits'])
  const material = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: encoder.encode('p2p-call/v1/signaling'),
    },
    base,
    256,
  )

  return crypto.subtle.importKey('raw', material, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
}

/** Запечатывает сообщение сигналинга: base64url(nonce ‖ шифртекст ‖ тег). */
export async function seal(key: CryptoKey, plaintext: string): Promise<string> {
  // Сообщений за звонок единицы, поэтому случайный 96-битный nonce безопасен:
  // это не поток кадров, где нужен счётчик.
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, encoder.encode(plaintext)),
  )

  const sealed = new Uint8Array(nonce.length + ciphertext.length)
  sealed.set(nonce, 0)
  sealed.set(ciphertext, nonce.length)
  return toBase64Url(sealed)
}

/** Распечатывает сообщение. Кидает SealError, если ключ чужой или блоб подделан. */
export async function open(key: CryptoKey, sealed: string): Promise<string> {
  let raw: Bytes
  try {
    raw = fromBase64Url(sealed.trim())
  } catch {
    throw new SealError('сообщение сигналинга не разбирается как base64url')
  }

  if (raw.length < NONCE_BYTES + TAG_BYTES) {
    throw new SealError('сообщение сигналинга короче минимально возможного')
  }

  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: raw.subarray(0, NONCE_BYTES) },
      key,
      raw.subarray(NONCE_BYTES),
    )
    return decoder.decode(plaintext)
  } catch {
    // Отличать «чужой ключ» от «подделали блоб» не нужно и не стоит:
    // в обоих случаях сообщению нельзя доверять.
    throw new SealError('сообщение сигналинга не прошло проверку подлинности')
  }
}
