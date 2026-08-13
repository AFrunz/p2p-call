/// <reference lib="webworker" />

import { ReceiverKeys } from './generations.js'
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

/**
 * Что известно о потоке в момент навешивания трансформа.
 *
 * Ни ключей, ни кодека здесь нет: трансформ вешается до согласования, потому
 * что после него браузер может уже не принять его всерьёз — кодировщик
 * запущен, и кадры пойдут мимо. Ключи и кодек досылаются отдельно, а кадры до
 * их прихода ждут в очереди самого потока.
 */
export interface TransformOptions {
  kind: MediaKind
  direction: Direction
  streamId: number
}

interface StreamConfig {
  codec: Codec
  keys: DirectionKeys
}

interface SenderState {
  counter: bigint
  keyId: number
  keys: DirectionKeys
}

const senders = new Map<string, SenderState>()
const receivers = new Map<string, ReceiverKeys>()

/** Настройки потоков и те, кто их ждёт. */
const configs = new Map<string, StreamConfig>()
const waiting = new Map<string, ((config: StreamConfig) => void)[]>()

function configure(id: string, config: StreamConfig): void {
  configs.set(id, config)
  for (const resolve of waiting.get(id) ?? []) resolve(config)
  waiting.delete(id)
}

function awaitConfig(id: string): StreamConfig | Promise<StreamConfig> {
  const ready = configs.get(id)
  if (ready !== undefined) return ready

  return new Promise<StreamConfig>((resolve) => {
    waiting.set(id, [...(waiting.get(id) ?? []), resolve])
  })
}

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

async function encrypt(
  frame: EncodedFrame,
  options: TransformOptions,
  config: StreamConfig,
): Promise<void> {
  const id = streamKey(options)
  let state = senders.get(id)
  if (state === undefined) {
    state = { counter: 0n, keyId: 0, keys: config.keys }
    senders.set(id, state)
  }

  const data = new Uint8Array(frame.data)
  const { header, body } = splitFrame(data, config.codec, isKeyFrame(frame))
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

async function decrypt(
  frame: EncodedFrame,
  options: TransformOptions,
  config: StreamConfig,
): Promise<void> {
  const id = streamKey(options)
  let state = receivers.get(id)
  if (state === undefined) {
    state = new ReceiverKeys(config.keys)
    receivers.set(id, state)
  }

  const data = new Uint8Array(frame.data)
  const unpacked = unpackFrame(data)
  const key = await state.keyFor(unpacked.keyId)

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

function transformer(options: TransformOptions): TransformStream {
  const apply = options.direction === 'send' ? encrypt : decrypt

  const id = streamKey(options)
  counters.set(id, { ok: 0, failed: 0, plaintext: 0 })

  return new TransformStream({
    async transform(frame: EncodedFrame, controller) {
      // Кадры, пришедшие до ключей, ждут здесь: поток сам придержит очередь.
      // Пропустить их открытым текстом нельзя — это ровно то, ради чего слой и
      // существует.
      const config = await awaitConfig(id)

      const state = counters.get(id)!
      try {
        await apply(frame, options, config)
        controller.enqueue(frame)

        state.ok++
        if (state.ok === 1 || state.ok % 200 === 0) report(id)
      } catch (error) {
        // Битый или чужой кадр просто выбрасываем: уронив поток, мы оборвали
        // бы весь звонок из-за одного пакета.
        state.failed++
        // Кадр, который короче нашего же заголовка, шифровали не мы. Это не
        // сбой расшифровки, а признак того, что на той стороне слой выключен.
        if (error instanceof FrameFormatError && error.plaintext) state.plaintext++

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

  self.postMessage({ t: 'attached', id: streamKey(options) })
  pipe(transform.readable, transform.writable, options)
})

/** Устаревший путь: createEncodedStreams в старых сборках Chrome. */
self.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as
    | { t: 'streams'; readable: ReadableStream; writable: WritableStream; options: TransformOptions }
    | { t: unknown }

  if (data.t === 'configure') {
    const message = data as unknown as {
      streams: { id: string; codec: Codec; keys: DirectionKeys }[]
    }
    for (const stream of message.streams) {
      configure(stream.id, { codec: stream.codec, keys: stream.keys })
    }
    return
  }

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
