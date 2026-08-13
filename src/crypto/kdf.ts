import type { Bytes } from '../bytes.js'
import type { Role } from '../signaling/types.js'

export type MediaKind = 'audio' | 'video'
export type Direction = 'send' | 'recv'

/** Число итераций PBKDF2 для парольной фразы. */
export const PBKDF2_ITERATIONS = 250_000

/** Как часто крутим ratchet во время звонка. */
export const RATCHET_INTERVAL_MS = 30_000

const CURVE = { name: 'ECDH', namedCurve: 'P-256' } as const
const EMPTY_SALT = new Uint8Array(0)
const encoder = new TextEncoder()

/**
 * Поколение ключей одного направления: `key` шифрует кадры, `chain` выводит
 * следующее. Разделены потому, что вывод из самого AES-ключа потребовал бы
 * шифрования с фиксированным nonce — риск повтора на живом потоке.
 */
export interface DirectionKeys {
  key: CryptoKey
  chain: CryptoKey
}

export interface MediaKeys {
  audio: { send: DirectionKeys; recv: DirectionKeys }
  video: { send: DirectionKeys; recv: DirectionKeys }
}

/** Генерирует эфемерную пару ECDH P-256 для одного звонка. */
export async function generateKeyPair(): Promise<CryptoKeyPair> {
  // Приватный ключ неизвлекаемый; публичный по спецификации извлекаем всегда.
  return crypto.subtle.generateKey(CURVE, false, ['deriveBits'])
}

export async function exportPublicKey(key: CryptoKey): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.exportKey('raw', key))
}

export async function importPublicKey(raw: Bytes): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, CURVE, true, [])
}

/** ECDH: наш приватный ключ + чужой публичный -> общий секрет. */
export async function deriveSharedSecret(
  privateKey: CryptoKey,
  remotePublicKey: CryptoKey,
): Promise<Bytes> {
  const bits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: remotePublicKey },
    privateKey,
    256,
  )
  return new Uint8Array(bits)
}

/**
 * Подмешивает необязательную парольную фразу к ECDH-секрету.
 *
 * Смысл: если канал обмена кодами скомпрометирован и злоумышленник подменил
 * ключи, без фразы он всё равно не расшифрует медиа. Без фразы возвращает
 * секрет как есть.
 */
export async function mixPassphrase(
  secret: Bytes,
  passphrase: string | null,
  salt: Bytes,
): Promise<Bytes> {
  if (passphrase === null || passphrase.length === 0) return secret

  const password = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, [
    'deriveBits',
  ])
  const stretched = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    password,
    256,
  )

  const base = await importHkdf(secret)
  const mixed = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(stretched),
      info: encoder.encode('p2p-call/v1/passphrase'),
    },
    base,
    256,
  )
  return new Uint8Array(mixed)
}

/**
 * Подмешивает секрет комнаты из ссылки-приглашения.
 *
 * Он не проходит через PBKDF2, потому что это не человеческая фраза, а 32
 * случайных байта — растягивать нечего. Смысл тот же: сигнальный сервер этого
 * секрета не видел и потому не может вывести медиаключи, даже подменив SDP.
 */
export async function mixRoomSecret(secret: Bytes, roomSecret: Bytes | null): Promise<Bytes> {
  if (roomSecret === null) return secret

  const base = await importHkdf(secret)
  const mixed = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: roomSecret,
      info: encoder.encode('p2p-call/v1/room'),
    },
    base,
    256,
  )
  return new Uint8Array(mixed)
}

/**
 * Разводит общий секрет в четыре независимых ключа AES-256-GCM.
 * Роль нужна, чтобы send одной стороны сошёлся с recv другой.
 */
export async function deriveMediaKeys(secret: Bytes, role: Role): Promise<MediaKeys> {
  const base = await importHkdf(secret)

  const derive = async (kind: MediaKind, direction: Direction): Promise<DirectionKeys> => {
    const chainMaterial = await expand(base, keyLabel(kind, direction, role))
    return chainToKeys(await importHkdf(chainMaterial))
  }

  const [audioSend, audioRecv, videoSend, videoRecv] = await Promise.all([
    derive('audio', 'send'),
    derive('audio', 'recv'),
    derive('video', 'send'),
    derive('video', 'recv'),
  ])

  return {
    audio: { send: audioSend, recv: audioRecv },
    video: { send: videoSend, recv: videoRecv },
  }
}

/** Метка HKDF для конкретного ключа — вынесена отдельно, потому что её легко перепутать. */
export function keyLabel(kind: MediaKind, direction: Direction, role: Role): string {
  // Метка описывает отправителя потока, а не «свою» сторону: только так send
  // инициатора и recv отвечающего сходятся на одном ключе.
  const sender: Role = direction === 'send' ? role : other(role)
  return `p2p-call/v1/${kind}/${sender}`
}

/**
 * Открытая контрольная сумма ключа направления.
 *
 * Нужна, чтобы расхождение ключей называлось расхождением ключей. Иначе оно
 * приходит как OperationError на каждом кадре — сообщение, из которого нельзя
 * понять, разошлись ключи, счётчики или разметка кадра.
 *
 * Выводится отдельной меткой HKDF, поэтому по ней не восстановить ни ключ, ни
 * цепочку: раскрывать её собеседнику, который и так владеет тем же ключом,
 * безопасно.
 */
export async function keyCheck(keys: DirectionKeys): Promise<string> {
  const material = await expand(keys.chain, 'p2p-call/v1/key-check')
  return [...material.subarray(0, 4)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Шаг ratchet: из текущего ключа выводится следующий, обратно не восстановимо. */
export async function ratchet(current: DirectionKeys): Promise<DirectionKeys> {
  const nextMaterial = await expand(current.chain, 'p2p-call/v1/ratchet')
  return chainToKeys(await importHkdf(nextMaterial))
}

/** id ключа живёт в одном байте и заворачивается по кругу. */
export function nextKeyId(current: number): number {
  if (!Number.isInteger(current) || current < 0 || current > 255) {
    throw new RangeError(`id ключа должен влезать в байт, получено ${current}`)
  }
  return (current + 1) % 256
}

function other(role: Role): Role {
  return role === 'initiator' ? 'responder' : 'initiator'
}

async function importHkdf(material: Bytes): Promise<CryptoKey> {
  // Спецификация требует, чтобы HKDF-ключи были неизвлекаемыми.
  return crypto.subtle.importKey('raw', material, 'HKDF', false, ['deriveBits'])
}

async function expand(chain: CryptoKey, label: string): Promise<Bytes> {
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: EMPTY_SALT, info: encoder.encode(label) },
    chain,
    256,
  )
  return new Uint8Array(bits)
}

async function chainToKeys(chain: CryptoKey): Promise<DirectionKeys> {
  const material = await expand(chain, 'p2p-call/v1/media-key')
  const key = await crypto.subtle.importKey('raw', material, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
  return { key, chain }
}
