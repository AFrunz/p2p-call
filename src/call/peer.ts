import { classifyConnection } from '../net/nat.js'
import type { ConnectionRoute } from '../net/nat.js'
import type { CandidateType } from '../signaling/types.js'

/** Сколько ждём полного сбора кандидатов, прежде чем показать код. */
export const GATHER_TIMEOUT_MS = 5000

export function createConnection(iceServers: RTCIceServer[]): RTCPeerConnection {
  // Пул кандидатов не прогреваем: он запускает механику ICE ещё до того, как
  // появились описания, и агент успевает сделать выводы о соединении, которого
  // пока нет.
  return new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' })
}

/**
 * Кодеки, чью разметку мы умеем оставлять открытой.
 *
 * Шифрование кадров обязано не трогать первые байты: по ним пакетизатор режет
 * кадр на RTP-пакеты, а декодер собирает обратно. Для VP8 это ровно три байта
 * (десять у ключевого кадра) — их мы и оставляем. У H.264 разметка совсем
 * другая: там NAL-юниты, и зашифровав их, мы отдаём пакетизатору мусор. Кадр
 * уезжает разбитым не по границам, приходит другой длины, и GCM отвергает всё
 * подряд, не называя причины.
 *
 * Разбирать NAL-юниты ради этого незачем: VP8 умеют все браузеры.
 */
const FRAME_SAFE_VIDEO = ['video/vp8', 'video/rtx', 'video/red', 'video/ulpfec', 'video/flexfec-03']

/**
 * Ставит вперёд видеокодеки, разметку которых мы разбираем.
 *
 * Именно переупорядочивает, а не вычёркивает остальные. Вычеркнув, можно
 * остаться без общего кодека с собеседником — и тогда звонок не состоится
 * вовсе, что заметно хуже, чем разговор без сквозного слоя. Если чужой кодек
 * всё-таки выиграет, это увидит проверка перед навешиванием шифрования.
 *
 * Вызывать обязательно до createOffer и createAnswer — позже предпочтение в
 * SDP уже не попадёт.
 */
export function preferFrameSafeVideo(connection: RTCPeerConnection): boolean {
  let codecs: readonly { mimeType: string }[]
  try {
    codecs = RTCRtpReceiver.getCapabilities?.('video')?.codecs ?? []
  } catch {
    return false
  }

  const safe = codecs.filter((codec) => FRAME_SAFE_VIDEO.includes(codec.mimeType.toLowerCase()))
  if (safe.length === 0) return false
  const ordered = [...safe, ...codecs.filter((codec) => !safe.includes(codec))]

  let applied = false
  for (const transceiver of connection.getTransceivers()) {
    if (transceiver.receiver.track?.kind !== 'video') continue
    if (typeof transceiver.setCodecPreferences !== 'function') continue

    try {
      const setPreferences = transceiver.setCodecPreferences as (codecs: unknown) => void
      setPreferences.call(transceiver, ordered)
      applied = true
    } catch (error) {
      console.warn('[p2p] не удалось выстроить порядок видеокодеков:', error)
    }
  }
  return applied
}

/**
 * Ждёт окончания сбора ICE-кандидатов.
 *
 * Код подключения показывается один раз и целиком, поэтому trickle здесь не
 * годится: кандидаты, приехавшие после отправки кода, до собеседника уже не
 * доберутся. Таймаут нужен, чтобы один зависший STUN не держал пользователя.
 */
export async function waitForGathering(
  connection: RTCPeerConnection,
  timeoutMs: number = GATHER_TIMEOUT_MS,
): Promise<void> {
  if (connection.iceGatheringState === 'complete') return

  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      connection.removeEventListener('icegatheringstatechange', onChange)
      resolve()
    }
    const onChange = () => {
      if (connection.iceGatheringState === 'complete') finish()
    }

    const timer = setTimeout(finish, timeoutMs)
    connection.addEventListener('icegatheringstatechange', onChange)
  })
}

export interface CallStats {
  /** Исходящий и входящий битрейт, бит/с. */
  outboundBitrate: number
  inboundBitrate: number
  /** Круговая задержка, мс. null — ещё не измерена. */
  roundTripMs: number | null
  /** Доля потерянных пакетов на приёме, 0..1. */
  packetLoss: number
  /** Каким путём прошло соединение. null — пара кандидатов ещё не выбрана. */
  route: ConnectionRoute | null
  /** Разрешение принимаемого видео. */
  frameWidth: number | null
  frameHeight: number | null
  /** Частота принимаемого видео: по ней видно рывки. */
  fps: number | null
  /** Разброс задержки пакетов, мс: он и вызывает дёрганое воспроизведение. */
  jitterMs: number | null
  /**
   * Что слышит наш микрофон, 0..1.
   *
   * Ноль при включённом микрофоне означает, что звука нет на входе, а не в
   * передаче: выбран не тот вход, приглушено в системе, закрыт шторкой.
   */
  micLevel: number | null
}

interface Snapshot {
  bytesSent: number
  bytesReceived: number
  timestamp: number
}

/** Накопитель для битрейта: WebRTC отдаёт суммы, а показывать надо скорость. */
export class StatsCollector {
  private previous: Snapshot | null = null

  async sample(connection: RTCPeerConnection): Promise<CallStats> {
    const report = await connection.getStats()

    let bytesSent = 0
    let bytesReceived = 0
    let timestamp = 0
    let roundTripMs: number | null = null
    let packetsReceived = 0
    let packetsLost = 0
    let frameWidth: number | null = null
    let frameHeight: number | null = null
    let fps: number | null = null
    let jitterMs: number | null = null
    let micLevel: number | null = null
    let route: ConnectionRoute | null = null

    const candidates = new Map<string, { type: CandidateType; address: string }>()

    report.forEach((entry) => {
      const stat = entry as Record<string, unknown>

      if (stat['type'] === 'local-candidate' || stat['type'] === 'remote-candidate') {
        candidates.set(String(stat['id']), {
          type: String(stat['candidateType']) as CandidateType,
          address: String(stat['address'] ?? ''),
        })
      }
    })

    report.forEach((entry) => {
      const stat = entry as Record<string, unknown>

      switch (stat['type']) {
        case 'media-source':
          if (stat['kind'] === 'audio') micLevel = numberOrNull(stat['audioLevel'])
          break

        case 'outbound-rtp':
          bytesSent += Number(stat['bytesSent'] ?? 0)
          timestamp = Math.max(timestamp, Number(stat['timestamp'] ?? 0))
          break

        case 'inbound-rtp':
          bytesReceived += Number(stat['bytesReceived'] ?? 0)
          packetsReceived += Number(stat['packetsReceived'] ?? 0)
          packetsLost += Math.max(0, Number(stat['packetsLost'] ?? 0))
          timestamp = Math.max(timestamp, Number(stat['timestamp'] ?? 0))
          if (stat['kind'] === 'video') {
            frameWidth = numberOrNull(stat['frameWidth'])
            frameHeight = numberOrNull(stat['frameHeight'])
            fps = numberOrNull(stat['framesPerSecond'])
          }
          {
            const jitter = numberOrNull(stat['jitter'])
            if (jitter !== null) jitterMs = Math.max(jitterMs ?? 0, Math.round(jitter * 1000))
          }
          break

        case 'candidate-pair':
          if (stat['state'] !== 'succeeded' && stat['nominated'] !== true) break
          roundTripMs = numberOrNull(stat['currentRoundTripTime'])
          if (roundTripMs !== null) roundTripMs = Math.round(roundTripMs * 1000)

          {
            const local = candidates.get(String(stat['localCandidateId']))
            const remote = candidates.get(String(stat['remoteCandidateId']))
            if (local !== undefined && remote !== undefined) {
              route = classifyConnection({
                localType: local.type,
                localAddress: local.address,
                remoteType: remote.type,
                remoteAddress: remote.address,
              })
            }
          }
          break
      }
    })

    const snapshot: Snapshot = { bytesSent, bytesReceived, timestamp }
    const rates = this.rates(snapshot)
    this.previous = snapshot

    const total = packetsReceived + packetsLost
    return {
      ...rates,
      roundTripMs,
      packetLoss: total > 0 ? packetsLost / total : 0,
      route,
      frameWidth,
      frameHeight,
      fps,
      jitterMs,
      micLevel,
    }
  }

  private rates(current: Snapshot): { outboundBitrate: number; inboundBitrate: number } {
    const previous = this.previous
    if (previous === null || current.timestamp <= previous.timestamp) {
      return { outboundBitrate: 0, inboundBitrate: 0 }
    }

    const seconds = (current.timestamp - previous.timestamp) / 1000
    return {
      outboundBitrate: Math.max(0, ((current.bytesSent - previous.bytesSent) * 8) / seconds),
      inboundBitrate: Math.max(0, ((current.bytesReceived - previous.bytesReceived) * 8) / seconds),
    }
  }
}

function numberOrNull(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}


/**
 * Просит приёмники держать буфер минимальным.
 *
 * Плавность видео достигается буферизацией: приёмник копит кадры, чтобы
 * сгладить неравномерность сети. Этот буфер и есть основная задержка. Ноль
 * сжимает его до предела — разговор становится живым, но любая неровность
 * сети сразу видна рывком.
 *
 * Свойство нестандартное и есть не везде; там, где его нет, режим просто не
 * даёт эффекта, и это честнее, чем притворяться, будто он применился.
 */
export function applyPlayoutDelay(connection: RTCPeerConnection, lowLatency: boolean): boolean {
  let applied = false

  for (const receiver of connection.getReceivers()) {
    const holder = receiver as unknown as Record<string, unknown>
    if (!('playoutDelayHint' in holder)) continue

    holder['playoutDelayHint'] = lowLatency ? 0 : null
    applied = true
  }
  return applied
}
