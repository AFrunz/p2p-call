import type { Bytes } from '../bytes.js'
import { message } from '../i18n/message.js'
import type { Message } from '../i18n/message.js'
import { RATCHET_INTERVAL_MS } from '../crypto/kdf.js'
import {
  deriveMediaKeys,
  deriveSharedSecret,
  exportPublicKey,
  generateKeyPair,
  importPublicKey,
  mixPassphrase,
  mixRoomSecret,
} from '../crypto/kdf.js'
import type { MediaKeys } from '../crypto/kdf.js'
import { deriveSas } from '../crypto/sas.js'
import { decodeMessage, encodeMessage } from '../protocol/messages.js'
import type { ControlMessage } from '../protocol/messages.js'
import { buildIceServers } from '../net/turn.js'
import type { NetworkReport } from '../net/probe.js'
import { decodeEnvelope, encodeEnvelope } from '../signaling/codec.js'
import { CodeFormatError } from '../signaling/codec.js'
import type { Envelope } from '../signaling/types.js'

/** У каждой причины свой совет: обрезанный код и чужая версия лечатся по-разному. */
const CODE_ERRORS: Record<string, string> = {
  malformed: 'session.codeUnreadable',
  truncated: 'session.codeTruncated',
  version: 'session.codeVersion',
}
import { SignalingClient } from '../signaling/client.js'
import { buildInviteLink, generateInvite, parseInviteLink } from '../signaling/link.js'
import type { Invite } from '../signaling/link.js'
import {
  countCandidates,
  extractFingerprint,
  insertCandidates,
  parseCandidateLine,
} from '../signaling/sdp.js'
import type { Role } from '../signaling/types.js'
import type { QualityPreset } from '../media/quality.js'
import { applyQuality, describeMissing, requestMedia, stopStream } from './media.js'
import { StatsCollector, createConnection, waitForGathering } from './peer.js'
import type { CallStats } from './peer.js'
import { attachAll, detectTransformSupport } from './transform.js'

/**
 * Сколько ждём соединения с момента, когда ICE начал проверять пары.
 *
 * Отсчитывать раньше нельзя: в режиме кодов между генерацией ответа и его
 * применением на той стороне стоит человек с буфером обмена.
 */
const CONNECT_TIMEOUT_MS = 30_000

export type Phase =
  | 'idle'
  | 'preparing'
  /** Свой код готов, ждём код собеседника. */
  | 'awaiting-exchange'
  /** Ссылка создана, ждём, когда собеседник её откроет. */
  | 'awaiting-peer'
  | 'connecting'
  | 'connected'
  | 'failed'
  | 'ended'

/**
 * Почему звонок закончился.
 *
 * `peer` ставится только по явному прощанию собеседника, `lost` — когда связь
 * оборвалась молча. Разница для пользователя существенная: в первом случае
 * ничего не сломалось, во втором стоит проверить сеть.
 */
export type EndReason = 'local' | 'peer' | 'lost'

export interface SessionView {
  phase: Phase
  endReason: EndReason | null
  role: Role | null
  /** Код для передачи собеседнику (режим без сервера). */
  outgoingCode: string | null
  /** Ссылка-приглашение (режим со своим сервером). */
  inviteLink: string | null
  /** Контрольная фраза для сверки голосом. */
  sas: string[] | null
  /** Работает ли сквозное шифрование кадров поверх штатного DTLS-SRTP. */
  frameEncryption: boolean
  network: NetworkReport | null
  /** Состояние ICE: видно в строке ожидания и в консольном журнале. */
  iceState: RTCIceConnectionState | null
  stats: CallStats | null
  peerMuted: { audio: boolean; video: boolean }
  /** Наше состояние: по умолчанию входим в звонок молча и без картинки. */
  muted: { audio: boolean; video: boolean }
  /** Есть ли что передавать: без камеры или микрофона кнопки бессмысленны. */
  canSend: { audio: boolean; video: boolean }
  /** Предупреждение, не мешающее звонку, — в отличие от error. */
  notice: Message | null
  error: Message | null
  /**
   * Провал такого рода, что без сервера-ретранслятора его не обойти.
   * Интерфейс по этому признаку показывает кнопку настройки сервера.
   */
  suggestServer: boolean
}

export interface SessionOptions {
  quality: QualityPreset
  passphrase: string | null
  cameraId?: string | null
  microphoneId?: string | null
  /** Адрес сигналинга; null — режим ручного обмена кодами. */
  signalingServer?: string | null
  /** Базовый адрес страницы для сборки ссылки. */
  pageUrl: string
  /**
   * Уже захваченный поток с главного экрана.
   *
   * Без него сессия просит камеру второй раз: пользователь ждёт лишние
   * секунды, а первый поток продолжает держать устройство. Переданный поток
   * сессия не останавливает — он принадлежит вызывающему коду.
   */
  stream?: MediaStream | null
  /**
   * Готовый отчёт диагностики сети.
   *
   * Считается один раз на главном экране: поднимать ради него ещё пару
   * RTCPeerConnection в момент звонка — лишняя работа и лишние секунды.
   */
  network?: NetworkReport | null
}

type Listener = (view: SessionView) => void

/**
 * Оркестратор звонка: держит состояние и сводит вместе медиа, ICE, шифрование
 * и сигналинг. Оба режима — ручной обмен кодами и подключение по ссылке —
 * используют один и тот же конверт с SDP; разница только в том, кто его несёт.
 */
export class CallSession {
  private readonly listeners = new Set<Listener>()
  private view: SessionView = {
    phase: 'idle',
    endReason: null,
    role: null,
    outgoingCode: null,
    inviteLink: null,
    sas: null,
    frameEncryption: false,
    network: null,
    iceState: null,
    stats: null,
    peerMuted: { audio: false, video: false },
    muted: { audio: true, video: true },
    canSend: { audio: false, video: false },
    notice: null,
    error: null,
    suggestServer: false,
  }

  private connection: RTCPeerConnection | null = null
  private channel: RTCDataChannel | null = null
  private worker: Worker | null = null
  private signaling: SignalingClient | null = null
  private invite: Invite | null = null

  private keyPair: CryptoKeyPair | null = null
  private remotePublicKey: Bytes | null = null
  private keys: MediaKeys | null = null

  private localStream: MediaStream | null = null
  /** Свой ли поток: чужой гасить нельзя, его ещё показывают на главном экране. */
  private ownsStream = false
  private readonly remoteStream = new MediaStream()
  private readonly stats = new StatsCollector()
  private statsTimer: ReturnType<typeof setInterval> | null = null
  private ratchetTimer: ReturnType<typeof setInterval> | null = null
  private watchdog: ReturnType<typeof setTimeout> | null = null
  /** Кандидаты, собранные событиями: страховка на случай пустого SDP. */
  private gathered: string[] = []
  private restarted = false
  /** Соединение хоть раз состоялось: обрыв после этого — не «не удалось подключиться». */
  private wasConnected = false

  constructor(private options: SessionOptions) {}

  /**
   * Сводка по требованию: `__p2p.stats()` в консоли.
   *
   * Автоматическая выкладка привязана к провалу и может не успеть, если
   * соединение закрылось раньше. Ручная работает, пока звонок жив.
   */
  diagnose(): void {
    void this.dumpCandidates()
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.view)
    return () => this.listeners.delete(listener)
  }

  get phase(): Phase {
    return this.view.phase
  }

  get media(): { local: MediaStream | null; remote: MediaStream } {
    return { local: this.localStream, remote: this.remoteStream }
  }

  /** Захватывает камеру и параллельно проверяет сеть. */
  async prepare(): Promise<void> {
    this.patch({ phase: 'preparing', error: null, suggestServer: false, endReason: null })

    try {
      const existing = this.options.stream ?? null
      let notice: Message | null = null

      if (existing !== null) {
        // Поток уже захвачен на главном экране вместе с выбранным состоянием
        // микрофона и камеры — переспрашивать разрешение незачем.
        this.localStream = existing
        this.ownsStream = false
      } else {
        const media = await requestMedia({
          preset: this.options.quality,
          cameraId: this.options.cameraId ?? null,
          microphoneId: this.options.microphoneId ?? null,
        })
        this.localStream = media.stream
        this.ownsStream = true

        // Входим в звонок молча и без картинки: включить себя — осознанное
        // действие, а случайно оказаться в эфире быть не должно.
        for (const track of media.stream.getTracks()) track.enabled = false
        notice = media.problem?.text ?? describeMissing(media.missing)
      }

      this.keyPair = await generateKeyPair()

      const stream = this.localStream
      const audio = stream.getAudioTracks()
      const video = stream.getVideoTracks()

      this.patch({
        canSend: { audio: audio.length > 0, video: video.length > 0 },
        muted: {
          audio: !(audio[0]?.enabled ?? false),
          video: !(video[0]?.enabled ?? false),
        },
        notice,
        phase: 'idle',
        network: this.options.network ?? null,
      })
    } catch {
      this.fail(message('session.prepareFailed'))
    }
  }

  // --- режим без сервера: обмен кодами ------------------------------------

  /** Создаёт звонок и возвращает код для собеседника. */
  async createCode(): Promise<void> {
    try {
      await this.openConnection('initiator')
      const connection = this.connection!

      this.channel = connection.createDataChannel('control', { ordered: true })
      this.bindChannel(this.channel)

      await connection.setLocalDescription(await connection.createOffer())
      await waitForGathering(connection)

      this.patch({ phase: 'awaiting-exchange', outgoingCode: await this.buildCode('initiator') })
    } catch (error) {
      this.fail(describe(error))
    }
  }

  /**
   * Принимает код собеседника.
   *
   * Один и тот же обработчик и для присоединяющегося (пришёл offer), и для
   * создателя звонка (пришёл ответ) — роль определяется по тому, есть ли уже
   * собственное локальное описание.
   */
  async acceptCode(code: string): Promise<void> {
    // Разбор кода вынесен в отдельный try: раньше в ту же ветку попадали
    // ошибки со всего остального блока, и «код не распознан» показывалось
    // там, где код был в полном порядке.
    let envelope: Envelope
    try {
      envelope = await decodeEnvelope(code)
    } catch (error) {
      const kind = error instanceof CodeFormatError ? error.kind : 'malformed'
      console.debug(
        `[p2p] код не разобрался: ${kind}, символов ${code.trim().length},` +
          ` начало «${code.trim().slice(0, 12)}», конец «${code.trim().slice(-12)}»`,
      )
      return this.fail(message(CODE_ERRORS[kind] ?? 'session.codeUnreadable'))
    }

    try {
      this.remotePublicKey = envelope.publicKey

      // Ответный код без своего звонка означает, что сессия уже закрылась —
      // например, по таймауту. Пытаться применить его как приглашение нельзя:
      // браузер отвергнет answer, поданный как offer, и причина потеряется.
      if (this.connection === null && envelope.role === 'responder') {
        return this.fail(message('session.answerWithoutOffer'))
      }

      if (this.connection === null) {
        await this.openConnection('responder')
        const connection = this.connection!

        await connection.setRemoteDescription({ type: 'offer', sdp: envelope.sdp })
        await connection.setLocalDescription(await connection.createAnswer())
        await waitForGathering(connection)

        this.patch({ phase: 'connecting', outgoingCode: await this.buildCode('responder') })
      } else {
        if (envelope.role !== 'responder') throw new SessionError('session.wrongCodeRole')
        await this.connection.setRemoteDescription({ type: 'answer', sdp: envelope.sdp })
        this.patch({ phase: 'connecting' })
      }

      await this.establishKeys()
    } catch (error) {
      this.fail(describe(error))
    }
  }

  // --- режим со своим сервером: подключение по ссылке ----------------------

  /** Создаёт комнату на своём сервере и возвращает ссылку-приглашение. */
  async createLink(): Promise<void> {
    const server = this.options.signalingServer
    if (server === null || server === undefined) return this.fail(message('session.noServer'))

    try {
      this.invite = generateInvite(server)
      this.patch({
        phase: 'awaiting-peer',
        inviteLink: buildInviteLink(this.options.pageUrl, this.invite),
      })
      await this.openSignaling(this.invite)
    } catch (error) {
      this.fail(describe(error))
    }
  }

  /** Подключается по чужой ссылке. */
  async joinLink(url: string): Promise<void> {
    const invite = parseInviteLink(url)
    if (invite === null) return this.fail(message('session.badLink'))

    try {
      this.invite = invite
      this.patch({ phase: 'connecting' })
      await this.openSignaling(invite)
    } catch (error) {
      this.fail(describe(error))
    }
  }

  private async openSignaling(invite: Invite): Promise<void> {
    this.signaling = new SignalingClient(invite, {
      onJoined: (role, iceServers) => {
        void this.onJoined(role, iceServers)
      },
      onPeerJoined: () => {
        void this.onPeerJoined()
      },
      onPeerLeft: () => {
        if (this.wasConnected) this.endCall('peer')
        else this.patch({ error: message('session.peerLeft') })
      },
      onSignal: (payload) => {
        void this.onSignal(payload)
      },
      onError: (reason) => this.patch({ error: reason }),
      onClosed: () => {
        if (this.view.phase !== 'connected') {
          this.patch({ error: message('session.signalingClosed') })
        }
      },
    })

    await this.signaling.connect()
  }

  private async onJoined(role: Role, iceServers: unknown[]): Promise<void> {
    // Список ICE приходит от сервера: он знает про свой TURN, а мы — нет.
    await this.openConnection(role, iceServers as RTCIceServer[])

    if (role === 'initiator') {
      this.channel = this.connection!.createDataChannel('control', { ordered: true })
      this.bindChannel(this.channel)
    }
    this.patch({ role })
  }

  private async onPeerJoined(): Promise<void> {
    if (this.view.role !== 'initiator' || this.connection === null) return

    await this.connection.setLocalDescription(await this.connection.createOffer())
    await waitForGathering(this.connection)
    await this.signaling?.send(await this.buildCode('initiator'))
    this.patch({ phase: 'connecting' })
  }

  private async onSignal(payload: string): Promise<void> {
    const connection = this.connection
    if (connection === null) return

    try {
      const envelope = await decodeEnvelope(payload)
      this.remotePublicKey = envelope.publicKey

      if (envelope.role === 'initiator') {
        await connection.setRemoteDescription({ type: 'offer', sdp: envelope.sdp })
        await connection.setLocalDescription(await connection.createAnswer())
        await waitForGathering(connection)
        await this.signaling?.send(await this.buildCode('responder'))
      } else {
        await connection.setRemoteDescription({ type: 'answer', sdp: envelope.sdp })
      }

      this.patch({ phase: 'connecting' })
      await this.establishKeys()
    } catch (error) {
      this.fail(describe(error))
    }
  }

  // --- общая часть ---------------------------------------------------------

  private async openConnection(role: Role, iceServers?: RTCIceServer[]): Promise<void> {
    const connection = createConnection(iceServers ?? buildIceServers())
    this.connection = connection
    this.patch({ role })

    const tracks = this.localStream?.getTracks() ?? []
    for (const track of tracks) connection.addTrack(track, this.localStream!)

    // Без собственной дорожки m-строка не появится, и мы не получим встречный
    // поток. Явный recvonly-трансивер оставляет возможность смотреть и слушать
    // тому, у кого камеры и микрофона нет.
    for (const kind of ['audio', 'video'] as const) {
      if (!tracks.some((track) => track.kind === kind)) {
        connection.addTransceiver(kind, { direction: 'recvonly' })
      }
    }

    connection.addEventListener('track', (event) => {
      this.remoteStream.addTrack(event.track)
    })

    connection.addEventListener('datachannel', (event) => {
      this.channel = event.channel
      this.bindChannel(event.channel)
    })

    connection.addEventListener('connectionstatechange', () => {
      this.trace('connection')
      void this.onConnectionState(connection.connectionState)
    })

    // Журнал состояний в консоли: вслепую отличить «не собрались кандидаты» от
    // «собрались, но пара не сошлась» иначе невозможно.
    for (const event of ['iceconnectionstatechange', 'icegatheringstatechange'] as const) {
      connection.addEventListener(event, () => {
        this.trace(event)
        this.patch({ iceState: connection.iceConnectionState })

        // Отсчёт начинаем с момента, когда пары действительно проверяются.
        // Раньше он стартовал сразу после генерации ответного кода — и тикал,
        // пока человек переносил этот код в другую вкладку.
        if (connection.iceConnectionState === 'checking') this.startWatchdog()
        if (connection.iceConnectionState === 'connected' || connection.iceConnectionState === 'completed') {
          this.stopWatchdog()
        }
      })
    }

    connection.addEventListener('icecandidate', (event) => {
      // Конец сбора приходит по-разному: null у одних движков, пустая строка у
      // других. Обе формы — не кандидат.
      const line = event.candidate?.candidate ?? ''
      if (line.length === 0) return

      this.gathered.push(line)
      const parsed = parseCandidateLine(line)
      console.debug('[p2p] кандидат', parsed?.type, parsed?.protocol, parsed?.address)
    })

    connection.addEventListener('icecandidateerror', (event) => {
      const error = event as RTCPeerConnectionIceErrorEvent
      console.debug('[p2p] ошибка кандидата', error.errorCode, error.errorText, error.url)
    })
  }

  private trace(reason: string): void {
    const connection = this.connection
    if (connection === null) return

    console.debug(
      `[p2p] ${reason}: conn=${connection.connectionState} ice=${connection.iceConnectionState}` +
        ` gather=${connection.iceGatheringState} sig=${connection.signalingState}`,
    )
  }

  private async onConnectionState(state: RTCPeerConnectionState): Promise<void> {
    if (state === 'connected') {
      this.stopWatchdog()
      this.wasConnected = true
      this.patch({ phase: 'connected', error: null, endReason: null })
      this.startTimers()
      return
    }

    if (state === 'failed') {
      this.stopWatchdog()

      // Обрыв уже состоявшегося звонка — это не «не удалось подключиться».
      // Советовать поднять сервер тут бессмысленно: только что всё работало.
      if (this.wasConnected) return this.endCall('lost')

      // Рестарт ICE имеет смысл только там, где новый offer есть кому
      // доставить. В режиме кодов сигналинга нет: раньше мы молча отправляли
      // его в никуда и возвращались, оставляя пользователя без ответа.
      if (!this.restarted && this.connection !== null && this.signaling !== null && this.view.role === 'initiator') {
        this.restarted = true
        try {
          await this.connection.setLocalDescription(
            await this.connection.createOffer({ iceRestart: true }),
          )
          await waitForGathering(this.connection)
          await this.signaling?.send(await this.buildCode('initiator'))
          return
        } catch {
          // Не вышло — падаем в общий текст ниже.
        }
      }
      // Обязательно ДО fail: teardown закрывает соединение, а getStats на
      // закрытом уже ничего не расскажет — выкладка терялась целиком.
      const summary = await this.dumpCandidates()
      this.fail(unreachableMessage(this.view.network, summary), true)
    }
  }

  /** Собирает конверт с нашим SDP и публичным ключом. */
  private async buildCode(role: Role): Promise<string> {
    const description = this.connection?.localDescription
    if (description == null || this.keyPair === null) throw new SessionError('session.notReady')

    // Кандидаты обязаны уехать вместе с кодом: обмен одноразовый, добавить их
    // потом некуда. Если браузер не положил их в localDescription — дописываем.
    const sdp = insertCandidates(description.sdp, this.gathered)
    console.debug('[p2p] кандидатов в коде:', countCandidates(sdp))

    return encodeEnvelope({
      version: 1,
      role,
      publicKey: await exportPublicKey(this.keyPair.publicKey),
      sdp,
    })
  }

  /**
   * Договаривается о ключах и включает шифрование кадров.
   *
   * Соль для парольной фразы — оба DTLS-отпечатка в каноническом порядке: она
   * привязывает ключи к конкретной паре сертификатов, а не к произвольной сессии.
   */
  private async establishKeys(): Promise<void> {
    const connection = this.connection
    if (connection === null || this.keyPair === null || this.remotePublicKey === null) return
    if (this.keys !== null) return

    const localSdp = connection.localDescription?.sdp ?? ''
    const remoteSdp = connection.remoteDescription?.sdp ?? ''
    const localFingerprint = extractFingerprint(localSdp)
    const remoteFingerprint = extractFingerprint(remoteSdp)

    if (localFingerprint === null || remoteFingerprint === null) {
      return this.fail(message('session.noFingerprint'))
    }

    const salt = concat(localFingerprint, remoteFingerprint)
    const ecdh = await deriveSharedSecret(
      this.keyPair.privateKey,
      await importPublicKey(this.remotePublicKey),
    )

    const withPassphrase = await mixPassphrase(ecdh, this.options.passphrase, salt)
    const secret = await mixRoomSecret(withPassphrase, this.invite?.secret ?? null)

    const role = this.view.role ?? 'initiator'
    this.keys = await deriveMediaKeys(secret, role)

    const sas = await deriveSas(secret, localFingerprint, remoteFingerprint)
    const frameEncryption = this.startTransforms()

    this.patch({ sas, frameEncryption })
  }

  private startTransforms(): boolean {
    if (this.connection === null || this.keys === null) return false
    if (detectTransformSupport() === 'none') return false

    this.worker = new Worker(new URL('../crypto/media-worker.js', import.meta.url), {
      type: 'module',
    })
    return attachAll(this.worker, this.connection, this.keys)
  }

  /**
   * Сторожевой таймер на установку соединения.
   *
   * ICE умеет застревать в `checking` десятками секунд и не всегда доходит до
   * `failed`. Без таймера пользователь смотрит на «устанавливаем соединение»
   * бесконечно и не получает ни ответа, ни кнопки следующего шага.
   */
  private startWatchdog(): void {
    this.stopWatchdog()
    this.watchdog = setTimeout(() => {
      if (this.view.phase === 'connected') return
      this.trace('сторожевой таймер')

      void this.dumpCandidates().then((summary) => {
        this.fail(unreachableMessage(this.view.network, summary), true)
      })
    }, CONNECT_TIMEOUT_MS)
  }

  /**
   * Сводка по кандидатам и парам одной строкой.
   *
   * Ключевой вопрос при провале — дошли ли до нас кандидаты собеседника вообще.
   * Ноль удалённых означает, что код разобрался, но ICE их не принял: проблема
   * в SDP. Пары в состоянии failed при ненулевых обеих сторонах означают
   * обратное — до сети дошло, а она не пустила.
   */
  private async dumpCandidates(): Promise<IceSummary> {
    const empty: IceSummary = { local: 0, remote: 0, pairs: 0, sameHost: false }
    const connection = this.connection
    if (connection === null) return empty

    try {
      const report = await connection.getStats()
      const local = new Map<string, string>()
      const remote = new Map<string, string>()
      const pairs: string[] = []

      report.forEach((entry) => {
        const stat = entry as Record<string, unknown>
        const describeCandidate = () =>
          `${String(stat['candidateType'])}/${String(stat['protocol'])} ${String(stat['address'])}:${String(stat['port'])}`

        if (stat['type'] === 'local-candidate') local.set(String(stat['id']), describeCandidate())
        if (stat['type'] === 'remote-candidate') remote.set(String(stat['id']), describeCandidate())
        if (stat['type'] === 'candidate-pair') {
          pairs.push(
            `${String(stat['state'])} ${String(stat['localCandidateId'])}->${String(stat['remoteCandidateId'])}`,
          )
        }
      })

      console.debug(
        `[p2p] ИТОГ: своих кандидатов ${local.size}, чужих ${remote.size}, пар ${pairs.length}`,
      )
      for (const [id, text] of remote) console.debug('[p2p] чужой', id, text)
      for (const pair of pairs.slice(0, 12)) {
        const [state, ids] = pair.split(' ')
        const [from, to] = (ids ?? '').split('->')
        console.debug('[p2p] пара', state, local.get(from ?? '') ?? from, '->', remote.get(to ?? '') ?? to)
      }

      // Совпадение адресов у обеих сторон означает, что участники сидят на
      // одной машине. Тогда NAT ни при чём, и советовать сменить Wi-Fi — врать.
      const addresses = (source: Map<string, string>) =>
        new Set([...source.values()].map((text) => text.split(' ')[1]?.split(':')[0] ?? ''))
      const mine = addresses(local)
      const sameHost = [...addresses(remote)].some(
        (address) => address.length > 0 && mine.has(address),
      )

      return { local: local.size, remote: remote.size, pairs: pairs.length, sameHost }
    } catch (error) {
      console.debug('[p2p] статистика недоступна:', error)
      return empty
    }
  }

  private stopWatchdog(): void {
    if (this.watchdog !== null) clearTimeout(this.watchdog)
    this.watchdog = null
  }

  private startTimers(): void {
    this.statsTimer ??= setInterval(() => {
      if (this.connection === null) return
      void this.stats.sample(this.connection).then((stats) => this.patch({ stats }))
    }, 1000)

    // Ротация ключей: воркер сам догоняет поколение по идентификатору в кадре.
    this.ratchetTimer ??= setInterval(() => {
      this.sendControl({ t: 'keyRotate', keyId: 0 })
    }, RATCHET_INTERVAL_MS)
  }

  private bindChannel(channel: RTCDataChannel): void {
    // Собеседник должен сразу узнать, что мы вошли выключенными, иначе он
    // будет ждать картинку, которой нет.
    channel.addEventListener('open', () => {
      for (const kind of ['audio', 'video'] as const) {
        this.sendControl({ t: 'mute', kind, muted: this.view.muted[kind] })
      }
    })

    channel.addEventListener('message', (event) => {
      const control = decodeMessage(String(event.data))
      if (control === null) return

      if (control.t === 'mute') {
        this.patch({ peerMuted: { ...this.view.peerMuted, [control.kind]: control.muted } })
      }
      if (control.t === 'bye') this.endCall('peer')
    })
  }

  private sendControl(control: ControlMessage): void {
    if (this.channel?.readyState === 'open') this.channel.send(encodeMessage(control))
  }

  // --- управление во время звонка -----------------------------------------

  setMuted(kind: 'audio' | 'video', muted: boolean): void {
    const tracks =
      kind === 'audio' ? this.localStream?.getAudioTracks() : this.localStream?.getVideoTracks()

    for (const track of tracks ?? []) track.enabled = !muted
    this.patch({ muted: { ...this.view.muted, [kind]: muted } })
    this.sendControl({ t: 'mute', kind, muted })
  }

  /** Текущее состояние своих дорожек — нужно интерфейсу для кнопок. */
  isMuted(kind: 'audio' | 'video'): boolean {
    return this.view.muted[kind]
  }

  async setQuality(quality: QualityPreset): Promise<void> {
    this.options = { ...this.options, quality }
    if (this.connection !== null && this.localStream !== null) {
      await applyQuality(this.connection, this.localStream, quality)
    }
    this.sendControl({ t: 'quality', preset: quality })
  }

  hangUp(): void {
    this.sendControl({ t: 'bye' })
    this.endCall('local')
  }

  private endCall(reason: EndReason): void {
    this.teardown()
    this.patch({ phase: 'ended', endReason: reason, error: null })
  }

  private teardown(): void {
    this.stopWatchdog()
    if (this.statsTimer !== null) clearInterval(this.statsTimer)
    if (this.ratchetTimer !== null) clearInterval(this.ratchetTimer)
    this.statsTimer = null
    this.ratchetTimer = null

    this.signaling?.close()
    this.channel?.close()
    this.connection?.close()
    this.worker?.terminate()
    if (this.ownsStream) stopStream(this.localStream)

    this.signaling = null
    this.channel = null
    this.connection = null
    this.worker = null
    this.localStream = null
  }

  private fail(reason: Message, suggestServer = false): void {
    this.teardown()
    this.patch({ phase: 'failed', error: reason, suggestServer })
  }

  private patch(changes: Partial<SessionView>): void {
    this.view = { ...this.view, ...changes }
    for (const listener of this.listeners) listener(this.view)
  }
}

function concat(a: Uint8Array, b: Uint8Array): Bytes {
  const result = new Uint8Array(a.length + b.length)
  result.set(a, 0)
  result.set(b, a.length)
  return result
}

/** Ошибка сессии несёт ключ локализации, а не готовый текст. */
class SessionError extends Error {
  constructor(readonly key: string) {
    super(key)
    this.name = 'SessionError'
  }
}

function describe(error: unknown): Message {
  return error instanceof SessionError ? message(error.key) : message('session.unknownError')
}

/** Что удалось узнать про ICE к моменту провала. */
export interface IceSummary {
  local: number
  remote: number
  pairs: number
  /** Обе стороны на одной машине: адреса кандидатов совпадают. */
  sameHost: boolean
}

/**
 * Текст для случая, когда все пути исчерпаны.
 *
 * Уточнение — отдельный ключ, а не склейка строк: собирать фразу из кусков на
 * разных языках нельзя, порядок слов везде свой.
 */
function unreachableMessage(network: NetworkReport | null, ice?: IceSummary): Message {
  // Участники на одной машине — про NAT говорить бессмысленно, мешает что-то
  // локальное. Совет «смените мобильный интернет на Wi-Fi» тут просто ложь.
  if (ice?.sameHost === true) return message('session.unreachable.sameHost')
  if (network?.verdict === 'symmetric') return message('session.unreachable.symmetric')
  if (network?.verdict === 'blocked') return message('session.unreachable.blocked')
  return message('session.unreachable')
}
