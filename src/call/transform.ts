import type { Codec } from '../crypto/frame.js'
import type { DirectionKeys, MediaKind } from '../crypto/kdf.js'
import type { MediaKeys } from '../crypto/kdf.js'

export type TransformSupport = 'script-transform' | 'encoded-streams' | 'none'

/**
 * Что умеет браузер по сквозному шифрованию кадров.
 *
 * Определяем по наличию API, а не по user-agent: версии, где это появилось,
 * у всех разные, а подделать наличие объекта незачем.
 */
export function detectTransformSupport(): TransformSupport {
  if (typeof window !== 'undefined' && 'RTCRtpScriptTransform' in window) return 'script-transform'

  const sender = RTCRtpSender.prototype as unknown as Record<string, unknown>
  if (typeof sender['createEncodedStreams'] === 'function') return 'encoded-streams'

  return 'none'
}

/** Номер потока в nonce: аудио и видео не должны их делить. */
const STREAM_IDS: Record<MediaKind, number> = { audio: 0, video: 1 }

interface AttachOptions {
  kind: MediaKind
  direction: 'send' | 'recv'
  codec: Codec
  keys: DirectionKeys
}

/**
 * Навешивает шифрование на один отправитель или приёмник.
 *
 * Возвращает false, если браузер не поддерживает нужное API — вызывающий код
 * обязан это заметить и предупредить пользователя, а не делать вид, что всё в
 * порядке.
 */
export function attachTransform(
  worker: Worker,
  endpoint: RTCRtpSender | RTCRtpReceiver,
  options: AttachOptions,
): boolean {
  const payload = {
    kind: options.kind,
    direction: options.direction,
    codec: options.codec,
    streamId: STREAM_IDS[options.kind],
    keys: options.keys,
  }

  const support = detectTransformSupport()

  if (support === 'script-transform') {
    const Transform = (window as unknown as Record<string, unknown>)['RTCRtpScriptTransform'] as {
      new (worker: Worker, options: unknown): unknown
    }
    ;(endpoint as unknown as Record<string, unknown>)['transform'] = new Transform(worker, payload)
    return true
  }

  if (support === 'encoded-streams') {
    const legacy = endpoint as unknown as {
      createEncodedStreams(): { readable: ReadableStream; writable: WritableStream }
    }
    const { readable, writable } = legacy.createEncodedStreams()
    worker.postMessage({ t: 'streams', readable, writable, options: payload }, [
      readable as unknown as Transferable,
      writable as unknown as Transferable,
    ])
    return true
  }

  return false
}

/** Кодек, о котором договорились, — нужен, чтобы знать размер открытого заголовка. */
export function negotiatedCodec(
  endpoint: RTCRtpSender | RTCRtpReceiver,
  kind: MediaKind,
): Codec {
  if (kind === 'audio') return 'opus'

  const parameters = 'getParameters' in endpoint ? endpoint.getParameters() : undefined
  const mime = parameters?.codecs?.[0]?.mimeType?.toLowerCase() ?? ''

  if (mime.includes('vp9')) return 'vp9'
  if (mime.includes('av1')) return 'av1'
  if (mime.includes('h264')) return 'h264'
  return 'vp8'
}

/** Навешивает шифрование на все дорожки соединения. */
export function attachAll(
  worker: Worker,
  connection: RTCPeerConnection,
  keys: MediaKeys,
): boolean {
  let attached = true

  for (const sender of connection.getSenders()) {
    const kind = sender.track?.kind
    if (kind !== 'audio' && kind !== 'video') continue

    attached =
      attachTransform(worker, sender, {
        kind,
        direction: 'send',
        codec: negotiatedCodec(sender, kind),
        keys: keys[kind].send,
      }) && attached
  }

  for (const receiver of connection.getReceivers()) {
    const kind = receiver.track?.kind
    if (kind !== 'audio' && kind !== 'video') continue

    attached =
      attachTransform(worker, receiver, {
        kind,
        direction: 'recv',
        codec: negotiatedCodec(receiver, kind),
        keys: keys[kind].recv,
      }) && attached
  }

  return attached
}

/**
 * Снимает шифрование со всех дорожек.
 *
 * Нужно, когда собеседник кадры не шифрует: наши он всё равно прочесть не
 * сможет, а мы не сможем прочесть его. Рабочий звонок на транспортном
 * шифровании честнее, чем сломанный на сквозном, — при условии, что об этом
 * сказано вслух.
 */
export function detachAll(connection: RTCPeerConnection): void {
  const endpoints: (RTCRtpSender | RTCRtpReceiver)[] = [
    ...connection.getSenders(),
    ...connection.getReceivers(),
  ]

  for (const endpoint of endpoints) {
    const holder = endpoint as unknown as Record<string, unknown>
    if ('transform' in holder) holder['transform'] = null
  }
}
