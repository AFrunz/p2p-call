import type { Bytes } from '../bytes.js'

export type Codec = 'opus' | 'vp8' | 'vp9' | 'h264' | 'av1'

/** Длина тега аутентификации AES-GCM. */
export const TAG_BYTES = 16

/**
 * Трейлер: 8 байт счётчика кадров + 1 байт идентификатора ключа.
 *
 * Счётчик едет вместе с кадром, потому что приёмнику больше неоткуда взять
 * nonce: порядок кадров он не контролирует, а выводить счётчик из порядка
 * получения нельзя — при потере пакета расшифровка развалится навсегда.
 */
export const COUNTER_BYTES = 8
export const KEY_ID_BYTES = 1
export const TRAILER_BYTES = COUNTER_BYTES + KEY_ID_BYTES

export const NONCE_BYTES = 12

const MAX_STREAM_ID = 0xffffffff
const MAX_COUNTER = 2n ** 64n - 1n

/** Открытый заголовок видео: у ключевого кадра дескриптор длиннее. */
const VIDEO_HEADER = { key: 10, delta: 3 } as const

export class FrameFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FrameFormatError'
  }
}

/**
 * Сколько байт в начале кадра обязаны остаться открытыми, иначе пакетизатор и
 * декодер не смогут разобрать поток. Эти байты не шифруются, но попадают в
 * additionalData AES-GCM, то есть подделать их незаметно нельзя.
 */
export function unencryptedHeaderSize(codec: Codec, isKeyFrame: boolean): number {
  if (codec === 'opus') return 1
  return isKeyFrame ? VIDEO_HEADER.key : VIDEO_HEADER.delta
}

/**
 * Строит nonce детерминированно: 4 байта id потока + 8 байт счётчика кадров.
 * Случайный nonce здесь недопустим — коллизия под одним ключом в GCM раскрывает
 * ключ аутентификации.
 */
export function buildNonce(streamId: number, counter: bigint): Bytes {
  if (!Number.isInteger(streamId) || streamId < 0 || streamId > MAX_STREAM_ID) {
    throw new FrameFormatError(`id потока вне диапазона uint32: ${streamId}`)
  }
  if (typeof counter !== 'bigint' || counter < 0n || counter > MAX_COUNTER) {
    // Заворачивать счётчик нельзя: повтор nonce под одним ключом ломает GCM.
    throw new FrameFormatError(`счётчик кадров вне диапазона uint64: ${counter}`)
  }

  const nonce = new Uint8Array(NONCE_BYTES)
  const view = new DataView(nonce.buffer)
  view.setUint32(0, streamId)
  view.setBigUint64(4, counter)
  return nonce
}

export interface SplitFrame {
  /** Открытый заголовок кодека, уходит в additionalData. */
  header: Bytes
  /** Тело, которое шифруется. */
  body: Bytes
}

export function splitFrame(data: Bytes, codec: Codec, isKeyFrame: boolean): SplitFrame {
  const headerSize = unencryptedHeaderSize(codec, isKeyFrame)
  if (data.length < headerSize) {
    throw new FrameFormatError(
      `кадр короче обязательного заголовка ${codec}: ${data.length} < ${headerSize}`,
    )
  }

  return {
    header: data.subarray(0, headerSize),
    body: data.subarray(headerSize),
  }
}

/** Собирает кадр для передачи: header || ciphertext+tag || counter || keyId. */
export function packFrame(
  header: Bytes,
  ciphertext: Bytes,
  counter: bigint,
  keyId: number,
): Bytes {
  assertKeyId(keyId)
  assertCounter(counter)

  const packed = new Uint8Array(header.length + ciphertext.length + TRAILER_BYTES)
  packed.set(header, 0)
  packed.set(ciphertext, header.length)

  const trailer = header.length + ciphertext.length
  new DataView(packed.buffer).setBigUint64(trailer, counter)
  packed[packed.length - 1] = keyId
  return packed
}

export interface UnpackedFrame {
  header: Bytes
  ciphertext: Bytes
  counter: bigint
  keyId: number
}

/**
 * Разбирает принятый кадр. Кидает FrameFormatError, если кадр короче минимума —
 * данные приходят от собеседника, доверять их длине нельзя.
 */
export function unpackFrame(data: Bytes, codec: Codec, isKeyFrame: boolean): UnpackedFrame {
  const headerSize = unencryptedHeaderSize(codec, isKeyFrame)
  const minimum = headerSize + TAG_BYTES + TRAILER_BYTES

  if (data.length < minimum) {
    throw new FrameFormatError(
      `кадр слишком короткий: ${data.length}, минимум ${minimum} (заголовок + тег + трейлер)`,
    )
  }

  const trailer = data.length - TRAILER_BYTES
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)

  return {
    header: data.subarray(0, headerSize),
    ciphertext: data.subarray(headerSize, trailer),
    counter: view.getBigUint64(trailer),
    keyId: data[data.length - 1]!,
  }
}

function assertKeyId(keyId: number): void {
  if (!Number.isInteger(keyId) || keyId < 0 || keyId > 255) {
    throw new FrameFormatError(`id ключа должен влезать в байт, получено ${keyId}`)
  }
}

function assertCounter(counter: bigint): void {
  if (typeof counter !== 'bigint' || counter < 0n || counter > MAX_COUNTER) {
    throw new FrameFormatError(`счётчик кадров вне диапазона uint64: ${counter}`)
  }
}
