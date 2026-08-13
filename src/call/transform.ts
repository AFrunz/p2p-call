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
  try {
    return install(worker, endpoint, options)
  } catch (error) {
    // Молча провалиться нельзя: неудача здесь означает кадры открытым текстом.
    console.warn(`[p2p] не удалось навесить шифрование на ${options.kind}/${options.direction}:`, error)
    return false
  }
}

function install(
  worker: Worker,
  endpoint: RTCRtpSender | RTCRtpReceiver,
  options: AttachOptions,
): boolean {
  const payload = {
    kind: options.kind,
    direction: options.direction,
    streamId: STREAM_IDS[options.kind],
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

/**
 * Навешивает шифрование на все дорожки соединения.
 *
 * Обходим трансиверы, а не отправителей с дорожками: отправитель без дорожки —
 * это обычное дело в начале звонка (камеру не дали, микрофон включат позже), а
 * его тип всё равно известен по трансиверу. Раньше такой отправитель оставался
 * без трансформа, и подставленная позже дорожка уходила открытым текстом —
 * собеседник видел мусор и снимал шифрование у себя.
 */
export interface AttachResult {
  /** Ни один конец не отказал на месте. */
  attached: boolean
  /**
   * Потоки, от которых ждём подтверждения воркера.
   *
   * Успех конструктора трансформа ещё ничего не значит: воркер может не
   * запуститься, и кадры пойдут мимо шифрования открытым текстом. Собеседник
   * увидит мусор, а мы будем уверять его, что всё навешено.
   */
  streams: string[]
}

export function attachAll(worker: Worker, connection: RTCPeerConnection): AttachResult {
  let attached = true
  const streams: string[] = []

  for (const transceiver of connection.getTransceivers()) {
    const kind = transceiver.receiver.track?.kind
    if (kind !== 'audio' && kind !== 'video') continue

    const endpoints = [
      { endpoint: transceiver.sender, direction: 'send' as const },
      { endpoint: transceiver.receiver, direction: 'recv' as const },
    ]

    for (const { endpoint, direction } of endpoints) {
      const ok = attachTransform(worker, endpoint, { kind, direction })
      if (ok) streams.push(`${kind}/${direction}`)
      attached = ok && attached
    }
  }

  return { attached, streams }
}

/**
 * Досылает воркеру ключи и согласованные кодеки.
 *
 * Отдельным шагом, потому что трансформ вешается до согласования: тогда кодек
 * ещё неизвестен, да и ключей нет — публичный ключ собеседника приезжает
 * позже. Кадры, пришедшие раньше настроек, ждут в очереди потока.
 */
export function configureStreams(
  worker: Worker,
  connection: RTCPeerConnection,
  keys: MediaKeys,
): void {
  const streams: { id: string; codec: Codec; keys: DirectionKeys }[] = []

  for (const transceiver of connection.getTransceivers()) {
    const kind = transceiver.receiver.track?.kind
    if (kind !== 'audio' && kind !== 'video') continue

    streams.push({
      id: `${kind}/send`,
      codec: negotiatedCodec(transceiver.sender, kind),
      keys: keys[kind].send,
    })
    streams.push({
      id: `${kind}/recv`,
      codec: negotiatedCodec(transceiver.receiver, kind),
      keys: keys[kind].recv,
    })
  }

  console.debug(
    `[p2p] настройки потоков отправлены: ${streams.map((s) => `${s.id} (${s.codec})`).join(', ')}`,
  )
  worker.postMessage({ t: 'configure', streams })
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

/** Порог, после которого испорченные кадры перестают быть случайностью. */
export const PLAINTEXT_THRESHOLD = 100

export interface DowngradeEvidence {
  /** Что собеседник ответил про свой слой. null — ещё не отвечал. */
  peerReportedAttached: boolean | null
  /** Сколько его кадров мы расшифровали. */
  decrypted: number
  /** Сколько кадров оказались короче нашей же обвязки. */
  plaintext: number
}

/**
 * Стоит ли снимать шифрование кадров.
 *
 * Кадр без нашей метки через наше шифрование не проходил — это факт, а не
 * догадка по длине или разметке кодека. Поэтому улика перевешивает заявление:
 * собеседник может считать, что слой навешен, и ошибаться. Раньше его слову
 * верили безоговорочно, и звонок оставался сломанным при бодром отчёте с той
 * стороны.
 *
 * Один расшифрованный кадр отменяет всё: раз поток читается, снимать нечего.
 */
export function shouldDowngrade(evidence: DowngradeEvidence): boolean {
  if (evidence.decrypted > 0) return false
  if (evidence.plaintext >= PLAINTEXT_THRESHOLD) return true

  return evidence.peerReportedAttached === false
}
