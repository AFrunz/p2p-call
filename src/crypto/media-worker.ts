/// <reference lib="webworker" />

import { nextKeyId, ratchet } from './kdf.js'
import type { DirectionKeys } from './kdf.js'
import {
  FrameFormatError,
  buildNonce,
  packFrame,
  splitFrame,
  unencryptedHeaderSize,
  unpackFrame,
} from './frame.js'
import type { Codec } from './frame.js'
import type { Direction, MediaKind } from './kdf.js'

/**
 * Шифрование кадров вне главного потока.
 *
 * Сюда попадают уже закодированные кадры: заголовок кодека остаётся открытым
 * (иначе пакетизатор и декодер не разберут поток), но подписывается как
 * additionalData, поэтому подделать его незаметно нельзя.
 */

export interface TransformOptions {
  kind: MediaKind
  direction: Direction
  codec: Codec
  streamId: number
  keys: DirectionKeys
}

/** Сколько поколений ключа держим на приёме: кадры в полёте отстают от ротации. */
const KEY_HISTORY = 4

interface SenderState {
  counter: bigint
  keyId: number
  keys: DirectionKeys
}

interface ReceiverState {
  /** Поколения ключей по их идентификатору. */
  generations: Map<number, CryptoKey>
  /** Последнее выведенное поколение — от него идём вперёд при ротации. */
  latest: DirectionKeys
  latestId: number
}

const senders = new Map<string, SenderState>()
const receivers = new Map<string, ReceiverState>()

/** Счётчики по каждому потоку: без них не понять, доходят ли кадры вообще. */
const counters = new Map<string, { ok: number; failed: number; plaintext: number }>()

function report(id: string, reason?: string): void {
  const state = counters.get(id) ?? { ok: 0, failed: 0, plaintext: 0 }
  self.postMessage({
    t: 'stats',
    id,
    ok: state.ok,
    failed: state.failed,
    plaintext: state.plaintext,
    reason,
  })
}

interface EncodedFrame {
  data: ArrayBuffer
  type?: 'key' | 'delta'
}

function streamKey(options: TransformOptions): string {
  return `${options.kind}/${options.direction}`
}

function isKeyFrame(frame: EncodedFrame): boolean {
  // У аудиокадров типа нет — трактуем их как обычные.
  return frame.type === 'key'
}

async function encrypt(frame: EncodedFrame, options: TransformOptions): Promise<void> {
  const id = streamKey(options)
  let state = senders.get(id)
  if (state === undefined) {
    state = { counter: 0n, keyId: 0, keys: options.keys }
    senders.set(id, state)
  }

  const data = new Uint8Array(frame.data)
  const { header, body } = splitFrame(data, options.codec, isKeyFrame(frame))
  const nonce = buildNonce(options.streamId, state.counter)

  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: header },
      state.keys.key,
      body,
    ),
  )

  frame.data = packFrame(header, ciphertext, state.counter, state.keyId).buffer
  state.counter++
}

async function decrypt(frame: EncodedFrame, options: TransformOptions): Promise<void> {
  const id = streamKey(options)
  let state = receivers.get(id)
  if (state === undefined) {
    state = {
      generations: new Map([[0, options.keys.key]]),
      latest: options.keys,
      latestId: 0,
    }
    receivers.set(id, state)
  }

  const data = new Uint8Array(frame.data)
  const unpacked = unpackFrame(data, options.codec, isKeyFrame(frame))
  const key = await keyForGeneration(state, unpacked.keyId)

  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: buildNonce(options.streamId, unpacked.counter),
        additionalData: unpacked.header,
      },
      key,
      unpacked.ciphertext,
    ),
  )

  const restored = new Uint8Array(unpacked.header.length + plaintext.length)
  restored.set(unpacked.header, 0)
  restored.set(plaintext, unpacked.header.length)
  frame.data = restored.buffer
}

/**
 * Догоняет ротацию отправителя по keyId из кадра. Шагов вперёд ограниченное
 * число: иначе подделанный keyId заставит крутить ratchet вечно.
 */
async function keyForGeneration(state: ReceiverState, keyId: number): Promise<CryptoKey> {
  const known = state.generations.get(keyId)
  if (known !== undefined) return known

  for (let step = 0; step < KEY_HISTORY; step++) {
    state.latest = await ratchet(state.latest)
    state.latestId = nextKeyId(state.latestId)
    state.generations.set(state.latestId, state.latest.key)

    if (state.latestId === keyId) {
      // Старые поколения держим ровно столько, сколько нужно кадрам в полёте.
      for (const id of state.generations.keys()) {
        if (state.generations.size > KEY_HISTORY) state.generations.delete(id)
        else break
      }
      return state.latest.key
    }
  }

  throw new FrameFormatError(`неизвестное поколение ключа: ${keyId}`)
}

function transformer(options: TransformOptions): TransformStream {
  const apply = options.direction === 'send' ? encrypt : decrypt

  const id = streamKey(options)
  counters.set(id, { ok: 0, failed: 0, plaintext: 0 })

  return new TransformStream({
    async transform(frame: EncodedFrame, controller) {
      const state = counters.get(id)!
      try {
        await apply(frame, options)
        controller.enqueue(frame)

        state.ok++
        if (state.ok === 1 || state.ok % 200 === 0) report(id)
      } catch (error) {
        // Битый или чужой кадр просто выбрасываем: уронив поток, мы оборвали
        // бы весь звонок из-за одного пакета.
        state.failed++
        // Кадр, который короче нашего же заголовка, шифровали не мы. Это не
        // сбой расшифровки, а признак того, что на той стороне слой выключен.
        if (error instanceof FrameFormatError) state.plaintext++

        if (state.failed === 1 || state.failed % 200 === 0) {
          report(id, error instanceof Error ? error.message : String(error))
        }
      }
    },
  })
}

function pipe(
  readable: ReadableStream,
  writable: WritableStream,
  options: TransformOptions,
): void {
  readable
    .pipeThrough(transformer(options))
    .pipeTo(writable)
    .catch(() => {
      // Поток закрывается при завершении звонка — это не ошибка.
    })
}

/** Современный путь: RTCRtpScriptTransform (Safari, Firefox, свежий Chrome). */
self.addEventListener('rtctransform', (event) => {
  const transform = (event as Event & { transformer: RTCRtpScriptTransformer }).transformer
  const options = transform.options as TransformOptions

  self.postMessage({ t: 'attached', id: streamKey(options), codec: options.codec })
  pipe(transform.readable, transform.writable, options)
})

/** Устаревший путь: createEncodedStreams в старых сборках Chrome. */
self.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as
    | { t: 'streams'; readable: ReadableStream; writable: WritableStream; options: TransformOptions }
    | { t: unknown }

  if (data.t === 'streams') {
    const message = data as {
      readable: ReadableStream
      writable: WritableStream
      options: TransformOptions
    }
    pipe(message.readable, message.writable, message.options)
  }
})

/** Тип из спецификации WebRTC Encoded Transform, ещё не везде в lib.dom. */
interface RTCRtpScriptTransformer {
  readable: ReadableStream
  writable: WritableStream
  options: unknown
}
