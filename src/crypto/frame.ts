import type { Bytes } from '../bytes.js'

export type Codec = 'opus' | 'vp8' | 'vp9' | 'h264' | 'av1'

/** Длина тега аутентификации AES-GCM. */
export const TAG_BYTES = 16

/**
 * Трейлер: 8 байт счётчика + 1 байт поколения ключа + 1 байт длины заголовка.
 *
 * Счётчик едет вместе с кадром, потому что приёмнику больше неоткуда взять
 * nonce: порядок кадров он не контролирует, а выводить счётчик из порядка
 * получения нельзя — при потере пакета расшифровка развалится навсегда.
 *
 * Длина заголовка едет по той же причине. Раньше приёмник вычислял её сам, по
 * кодеку и признаку ключевого кадра, — а это догадка: кодек на приёме не всегда
 * известен, признак ключевого кадра есть не в каждом браузере. Разойдясь с
 * отправителем хоть на байт, приёмник строит другой additionalData, и GCM
 * отвергает вообще всё, не объясняя причины.
 */
export const COUNTER_BYTES = 8
export const KEY_ID_BYTES = 1
export const HEADER_SIZE_BYTES = 1
export const MAGIC_BYTES = 1
export const TRAILER_BYTES = COUNTER_BYTES + KEY_ID_BYTES + HEADER_SIZE_BYTES + MAGIC_BYTES

/**
 * Метка «этот кадр собрали мы».
 *
 * Без неё чужой кадр неотличим от своего с неподошедшим ключом: GCM в обоих
 * случаях говорит одно и то же, а чинить надо разное. Угадывать по разметке
 * кодека нельзя — открытый заголовок мы и так оставляем нетронутым, поэтому
 * сигнатура формата стоит на месте и в зашифрованном кадре.
 *
 * Метка не аутентифицирована: подделать её ничего не стоит, но она и не для
 * защиты, а для диагностики. Подделанная приведёт к отказу GCM, то есть ровно
 * к тому же, что и без неё.
 */
export const FRAME_MAGIC = 0x5a

export const NONCE_BYTES = 12

const MAX_STREAM_ID = 0xffffffff
/** Длина открытого заголовка едет в одном байте. */
const MAX_HEADER_BYTES = 255
const MAX_COUNTER = 2n ** 64n - 1n

/** Открытый заголовок видео: у ключевого кадра дескриптор длиннее. */
const VIDEO_HEADER = { key: 10, delta: 3 } as const

export class FrameFormatError extends Error {
  /**
   * Кадр вообще не проходил через наше шифрование.
   *
   * Отличать это от неподошедшего ключа обязательно: короткий кадр — довод в
   * пользу того, что у собеседника слой выключен, а промах по ключу таким
   * доводом не является и не должен приводить к снятию шифрования.
   */
  readonly plaintext: boolean

  constructor(message: string, plaintext = true) {
    super(message)
    this.name = 'FrameFormatError'
    this.plaintext = plaintext
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
 * Ключевой ли это кадр VP8 — по самому кадру, а не по метке браузера.
 *
 * Метку `type` у закодированного кадра ставят не все браузеры, и ошибка здесь
 * дорогая: у ключевого кадра открытыми обязаны остаться десять байт, а не три.
 * Зашифровав седьмой байт, мы прячем от пакетизатора размер первой партиции —
 * он режет кадр не по границам, и до собеседника доезжает уже не тот набор
 * байт. Выглядит это как случайный мусор в трейлере и отказ GCM на каждом
 * кадре, хотя ключи сошлись и кодек у обоих один.
 *
 * В первом байте кадра VP8 младший бит — признак межкадрового предсказания:
 * ноль означает ключевой кадр. Это часть формата, а не браузерная любезность.
 */
export function isVp8KeyFrame(data: Bytes): boolean {
  return data.length > 0 && (data[0]! & 1) === 0
}

/**
 * Сколько байт оставить открытыми у конкретного кадра.
 *
 * Для VP8 смотрим в сам кадр; для остальных кодеков доверяем метке браузера —
 * лучшего источника у нас нет, а разметку их кадров мы всё равно не разбираем.
 */
export function headerSizeFor(data: Bytes, codec: Codec, isKeyFrame: boolean): number {
  if (codec === 'vp8') return isVp8KeyFrame(data) ? VIDEO_HEADER.key : VIDEO_HEADER.delta
  return unencryptedHeaderSize(codec, isKeyFrame)
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
  const headerSize = headerSizeFor(data, codec, isKeyFrame)
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

/** Собирает кадр: header || ciphertext+tag || counter || keyId || headerSize. */
export function packFrame(
  header: Bytes,
  ciphertext: Bytes,
  counter: bigint,
  keyId: number,
): Bytes {
  assertKeyId(keyId)
  assertCounter(counter)
  if (header.length > MAX_HEADER_BYTES) {
    throw new FrameFormatError(`заголовок не влезает в байт длины: ${header.length}`)
  }

  const packed = new Uint8Array(header.length + ciphertext.length + TRAILER_BYTES)
  packed.set(header, 0)
  packed.set(ciphertext, header.length)

  const trailer = header.length + ciphertext.length
  new DataView(packed.buffer).setBigUint64(trailer, counter)
  packed[packed.length - 3] = keyId
  packed[packed.length - 2] = header.length
  packed[packed.length - 1] = FRAME_MAGIC
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
export function unpackFrame(data: Bytes): UnpackedFrame {
  const minimum = TAG_BYTES + TRAILER_BYTES
  if (data.length < minimum) {
    throw new FrameFormatError(
      `кадр слишком короткий: ${data.length}, минимум ${minimum} (тег + трейлер)`,
    )
  }

  if (data[data.length - 1] !== FRAME_MAGIC) {
    throw new FrameFormatError('кадр не проходил через наше шифрование: нет метки')
  }

  const headerSize = data[data.length - 2]!
  if (headerSize + TAG_BYTES + TRAILER_BYTES > data.length) {
    throw new FrameFormatError(
      `заявленный заголовок не помещается в кадр: ${headerSize} из ${data.length}`,
    )
  }

  const trailer = data.length - TRAILER_BYTES
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)

  return {
    header: data.subarray(0, headerSize),
    ciphertext: data.subarray(headerSize, trailer),
    counter: view.getBigUint64(trailer),
    keyId: data[data.length - 3]!,
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
