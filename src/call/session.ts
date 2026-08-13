import type { Bytes } from '../bytes.js'
import { message } from '../i18n/message.js'
import type { Message } from '../i18n/message.js'
import { RATCHET_INTERVAL_MS, keyCheck } from '../crypto/kdf.js'
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
import { compareBytes, deriveSas } from '../crypto/sas.js'
import { decodeMessage, encodeMessage } from '../protocol/messages.js'
import type { ControlMessage } from '../protocol/messages.js'
import { buildIceServers } from '../net/turn.js'
import type { NetworkReport } from '../net/probe.js'
import { DEFAULT_HOLD_SECONDS, FORMAT_VERSION, decodeEnvelope, encodeEnvelope } from '../signaling/codec.js'
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
  stripCandidates,
} from '../signaling/sdp.js'
import type { Role } from '../signaling/types.js'
import type { QualityPreset } from '../media/quality.js'
import { applyQuality, describeMissing, requestMedia, stopStream } from './media.js'
import { StatsCollector, createConnection, restrictVideoCodecs, waitForGathering } from './peer.js'
import type { CallStats } from './peer.js'
import {
  attachAll,
  attachTransform,
  detachAll,
  detectTransformSupport,
  negotiatedCodec,
  shouldDowngrade,
} from './transform.js'

/**
 * Сколько ждём соединения после начала проверки пар.
 *
 * В режиме кодов между генерацией ответа и его применением стоит человек с
 * буфером обмена, поэтому запас втрое больше, чем при живом сигналинге.
 */
const CONNECT_TIMEOUT_MS = { manual: 180_000, signaling: 45_000 }

/** Сколько раз пересобираем ответ, пока собеседник несёт код. */
const MAX_ANSWER_REFRESH = 3

/**
 * Как часто подкидываем агенту заведомо недостижимого кандидата.
 *
 * ICE объявляет провал, когда проверять больше нечего: список пар исчерпан,
 * сбор завершён. Пока появляются новые пары, агент остаётся в checking — на
 * этом и держится ожидание, пока человек несёт код.
 */
const KEEP_ALIVE_INTERVAL_MS = 4000

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

/**
 * Почему сквозное шифрование кадров включено или нет.
 *
 * Пользователю мало флажка: «транспортное шифрование» без причины читается как
 * поломка, хотя чаще это осознанный откат ради работающего звонка.
 */
export type EncryptionReason =
  | 'pending'
  | 'active'
  | 'unsupported'
  | 'peerUnsupported'
  | 'attachFailed'
  | 'peerPlaintext'
  | 'codecUnsupported'

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
  /** Почему шифрование кадров сейчас в таком состоянии — для пояснения в интерфейсе. */
  encryptionReason: EncryptionReason
  network: NetworkReport | null
  /** Когда начнётся проверка пар. null — расписание не назначено. */
  startAt: number | null
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
   * Сколько секунд даётся на перенос кода.
   *
   * Учитывается у того, кто создаёт сессию: он выбирает, как код поедет.
   * Отвечающий берёт это число из самого кода.
   */
  connectDelay?: number
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
    encryptionReason: 'pending',
    network: null,
    startAt: null,
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
  /** Умеет ли собеседник шифровать кадры. Включаем слой только если оба. */
  private peerFrameEncryption = false
  private encryptionReason: EncryptionReason = 'pending'
  /** Что собеседник сказал про свой слой шифрования. null — ещё не говорил. */
  private peerAttachedEncryption: boolean | null = null
  /** Сколько наших кадров собеседник отбросил в прошлом отчёте. */
  private peerFailedFrames: number | null = null
  private peerFramesWarned = false
  /**
   * Окно на перенос кода. У создателя — из его настроек, у отвечающего — из
   * полученного кода: разъехавшиеся окна означали бы, что одна сторона начнёт
   * проверку, пока вторая ещё держит кандидатов.
   */
  private holdSeconds = DEFAULT_HOLD_SECONDS
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
  /** Приглашение собеседника: по нему пересобираем ответ, если ICE отвалился. */
  private pendingOffer: string | null = null
  /** Кандидаты собеседника, придержанные до готовности человека. */
  private heldCandidates: string[] = []
  private releaseTimer: ReturnType<typeof setTimeout> | null = null
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null
  private keepAliveIndex = 0
  private refreshes = 0
  private restarted = false
  /** Соединение хоть раз состоялось: обрыв после этого — не «не удалось подключиться». */
  private wasConnected = false

  constructor(private options: SessionOptions) {
    // Своё окно нужно только создателю сессии; отвечающий перезапишет его
    // числом из кода, как только код разберётся.
    this.holdSeconds = options.connectDelay ?? DEFAULT_HOLD_SECONDS
  }

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

  /** Ждём ли нажатия «код вставлен»: кандидаты придержаны, проверка не начата. */
  get isHoldingCandidates(): boolean {
    return this.heldCandidates.length > 0
  }

  /** Есть ли что обновлять: приглашение сохранено и мы отвечающая сторона. */
  get canRefreshAnswer(): boolean {
    return this.pendingOffer !== null && this.view.role === 'responder' && this.signaling === null
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

      this.patch({
        phase: 'awaiting-exchange',
        outgoingCode: await this.buildCode('initiator', connection),
      })
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
      this.peerFrameEncryption = envelope.frameEncryption

      // Ответный код без своего звонка означает, что сессия уже закрылась —
      // например, по таймауту. Пытаться применить его как приглашение нельзя:
      // браузер отвергнет answer, поданный как offer, и причина потеряется.
      if (this.connection === null && envelope.role === 'responder') {
        return this.fail(message('session.answerWithoutOffer'))
      }

      if (this.connection === null) {
        await this.openConnection('responder')
        const connection = this.connection!

        this.pendingOffer = envelope.sdp
        this.holdSeconds = envelope.holdSeconds

        // Кандидатов собеседника придерживаем: без них парам не из чего
        // строиться, ICE не начинает проверку и не сдаётся через полминуты,
        // пока человек несёт код на второе устройство.
        const held = this.signaling === null ? stripCandidates(envelope.sdp) : null
        this.heldCandidates = held?.candidates ?? []
        await connection.setRemoteDescription({ type: 'offer', sdp: held?.sdp ?? envelope.sdp })

        // Только теперь: до удалённого описания addIceCandidate падает, и
        // капельница глохла на первом же вызове, ни разу не сработав.
        if (held !== null) this.scheduleRelease(Date.now() + this.holdSeconds * 1000)
        await connection.setLocalDescription(await connection.createAnswer())
        await waitForGathering(connection)

        this.patch({ phase: 'connecting', outgoingCode: await this.buildCode('responder', connection) })
      } else {
        if (envelope.role !== 'responder') throw new SessionError('session.wrongCodeRole')

        // Придерживаем и здесь: иначе ожидание в пустоту просто переезжает на
        // эту сторону, пока человек идёт в мессенджер сказать «я вставил».
        const answer = this.signaling === null ? stripCandidates(envelope.sdp) : null
        this.heldCandidates = answer?.candidates ?? []
        await this.connection.setRemoteDescription({
          type: 'answer',
          sdp: answer?.sdp ?? envelope.sdp,
        })
        if (answer !== null) this.scheduleRelease(envelope.startAt)
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
      this.peerFrameEncryption = envelope.frameEncryption

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

    // Без собственной дорожки m-строка не появится, и встречный поток не
    // придёт. Направление sendrecv, а не recvonly: тогда камеру, занятую в
    // момент старта, можно подставить позже через replaceTrack — без нового
    // обмена кодами, которого в ручном режиме взять негде.
    for (const kind of ['audio', 'video'] as const) {
      if (!tracks.some((track) => track.kind === kind)) {
        connection.addTransceiver(kind, { direction: 'sendrecv' })
      }
    }

    // До createOffer и createAnswer: позже предпочтение в SDP уже не попадёт.
    if (detectTransformSupport() !== 'none') {
      const restricted = restrictVideoCodecs(connection)
      console.debug(`[p2p] видео ограничено разбираемыми кодеками: ${restricted}`)
    }

    connection.addEventListener('track', (event) => {
      this.remoteStream.addTrack(event.track)
      console.debug(
        `[p2p] пришла дорожка ${event.track.kind}:` +
          ` enabled=${event.track.enabled} muted=${event.track.muted} ${event.track.readyState}`,
      )
      event.track.addEventListener('mute', () =>
        console.debug(`[p2p] дорожка ${event.track.kind} замолчала`),
      )
      event.track.addEventListener('unmute', () =>
        console.debug(`[p2p] дорожка ${event.track.kind} заговорила`),
      )
    })

    connection.addEventListener('datachannel', (event) => {
      this.channel = event.channel
      this.bindChannel(event.channel)
    })

    connection.addEventListener('connectionstatechange', () => {
      this.trace('connection')
      void this.onConnectionState(connection.connectionState, connection)
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

  private async onConnectionState(
    state: RTCPeerConnectionState,
    connection: RTCPeerConnection,
  ): Promise<void> {
    // События приходят и от соединения, которое мы уже заменили при пересборке
    // ответа. Его мнение о жизни нас больше не касается.
    if (connection !== this.connection) return

    if (state === 'connected') {
      this.stopWatchdog()
      this.wasConnected = true
      this.patch({ phase: 'connected', error: null, endReason: null })
      this.startTimers()
      return
    }

    if (state === 'failed') {
      // До обмена кодами проверять нечего: удалённого описания нет, пары не
      // строятся. Провал в этот момент — не отказ сети, а следствие того, что
      // вкладку свернули или усыпили. Хоронить из-за него звонок нельзя: код
      // уже унесли на второе устройство.
      if (this.view.phase === 'awaiting-exchange') {
        console.debug('[p2p] провал ICE до обмена кодами — игнорируем')
        return
      }

      this.stopWatchdog()

      // Обрыв уже состоявшегося звонка — это не «не удалось подключиться».
      // Советовать поднять сервер тут бессмысленно: только что всё работало.
      if (this.wasConnected) return this.endCall('lost')

      // Отвечающий начинает проверять пары сразу, а инициатор — только получив
      // ответный код. Всё это время браузер долбится в тишину и секунд через
      // тридцать сдаётся сам. Пересобираем ответ вместо того, чтобы хоронить
      // звонок: человек ещё несёт код.
      if (await this.refreshAnswer()) return

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

  /**
   * Отдаёт придержанных кандидатов и запускает проверку пар.
   *
   * Нажимается человеком, когда обе стороны вставили коды. Достаточно нажатия
   * с одной стороны: вторая, даже придерживая своих кандидатов, отвечает на
   * входящие проверки и достраивает пару сама.
   */
  /**
   * Назначает общий момент старта.
   *
   * Часы устройств расходятся на секунды, а ICE ретранслирует проверки
   * десятками секунд — такого запаса хватает. Момент из прошлого означает, что
   * человек нёс код дольше расписания: тогда начинаем сразу.
   */
  private scheduleRelease(startAt: number): void {
    if (this.releaseTimer !== null) clearTimeout(this.releaseTimer)

    const wait = Math.max(0, startAt - Date.now())
    this.patch({ startAt })
    this.releaseTimer = setTimeout(() => void this.startChecking(), wait)
    this.startKeepAlive()
  }

  /**
   * Держит агента в работе, пока настоящие кандидаты придержаны.
   *
   * Адреса из TEST-NET (RFC 5737) заведомо никуда не ведут: пара честно
   * провалится, но сам факт её появления не даёт агенту закрыть список и
   * объявить, что соединяться не с чем.
   */
  private startKeepAlive(): void {
    if (this.keepAliveTimer !== null) return

    const feed = () => {
      const connection = this.connection
      if (connection === null || this.heldCandidates.length === 0) return this.stopKeepAlive()

      this.keepAliveIndex++
      const index = this.keepAliveIndex
      const candidate =
        `candidate:${900000 + index} 1 udp ${index} 198.51.100.${(index % 254) + 1}` +
        ` ${20000 + (index % 40000)} typ host`

      void connection
        .addIceCandidate({ candidate, sdpMLineIndex: 0 })
        .then(() => {
          if (index % 5 === 1) {
            console.debug(`[p2p] удерживаем ICE: подкормок ${index}, состояние ${connection.iceConnectionState}`)
          }
        })
        .catch((error: unknown) => {
          console.debug('[p2p] удержание ICE прервано:', error instanceof Error ? error.name : error)
          this.stopKeepAlive()
        })
    }

    feed()
    this.keepAliveTimer = setInterval(feed, KEEP_ALIVE_INTERVAL_MS)
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer !== null) clearInterval(this.keepAliveTimer)
    this.keepAliveTimer = null
  }

  /**
   * Отпускает придержанных кандидатов. Вызывается только по расписанию.
   *
   * Кнопки «начать сейчас» здесь быть не может: отпустив кандидатов в одиночку,
   * сторона начинает проверки, на которые вторая ещё не отвечает, и сжигает
   * своё окно до общего момента. Согласовать досрочный старт нечем — канала
   * между сторонами до соединения нет.
   */
  private async startChecking(): Promise<void> {
    const connection = this.connection
    const held = this.heldCandidates
    if (connection === null || held.length === 0) return

    this.heldCandidates = []
    this.stopKeepAlive()
    if (this.releaseTimer !== null) clearTimeout(this.releaseTimer)
    this.releaseTimer = null
    this.patch({ startAt: null })

    for (const candidate of held) {
      try {
        await connection.addIceCandidate({ candidate, sdpMLineIndex: 0 })
      } catch {
        // Один непринятый кандидат не повод бросать остальные.
      }
    }
    this.patch({ phase: 'connecting' })
  }

  /**
   * Пересобирает ответ на то же приглашение с новыми ICE-данными.
   *
   * Возвращает true, если получилось: тогда в интерфейсе появляется свежий код
   * взамен протухшего, и обмен можно закончить спокойно.
   */
  async refreshAnswer(manual = false): Promise<boolean> {
    const offer = this.pendingOffer
    if (offer === null || this.signaling !== null) return false
    if (this.view.role !== 'responder') return false
    // Лимит только для автоматических попыток: нажатие человека — это уже
    // осознанное решение, ограничивать его незачем.
    if (!manual && this.refreshes >= MAX_ANSWER_REFRESH) return false

    if (!manual) this.refreshes++
    try {
      this.connection?.close()
      this.worker?.terminate()
      this.worker = null
      this.keys = null
      this.gathered = []

      await this.openConnection('responder')
      const connection = this.connection!

      const held = stripCandidates(offer)
      this.heldCandidates = held.candidates
      await connection.setRemoteDescription({ type: 'offer', sdp: held.sdp })
      await connection.setLocalDescription(await connection.createAnswer())
      await waitForGathering(connection)

      this.patch({
        outgoingCode: await this.buildCode('responder', connection),
        notice: message('session.answerRefreshed'),
      })
      await this.establishKeys()
      return true
    } catch {
      return false
    }
  }

  /** Собирает конверт с нашим SDP и публичным ключом. */
  private async buildCode(role: Role, from?: RTCPeerConnection): Promise<string> {
    const connection = from ?? this.connection
    const description = connection?.localDescription
    if (description == null || this.keyPair === null) {
      // Обычно это гонка: соединение снесли, пока мы ждали сбор кандидатов.
      // Текст про «ещё не готово» тут вводит в заблуждение, поэтому пишем в
      // журнал, что произошло на самом деле.
      console.debug(
        `[p2p] код не собрать: соединение ${connection == null ? 'снесено' : 'без описания'}` +
          `${connection === this.connection ? '' : ' (подменено на другое)'}`,
      )
      throw new SessionError('session.notReady')
    }

    // Кандидаты обязаны уехать вместе с кодом: обмен одноразовый, добавить их
    // потом некуда. Если браузер не положил их в localDescription — дописываем.
    const sdp = insertCandidates(description.sdp, this.gathered)
    const code = await encodeEnvelope({
      version: FORMAT_VERSION,
      role,
      publicKey: await exportPublicKey(this.keyPair.publicKey),
      frameEncryption: detectTransformSupport() !== 'none',
      startAt: this.view.startAt ?? 0,
      holdSeconds: this.holdSeconds,
      sdp,
    })

    console.debug(
      `[p2p] код готов: кандидатов ${countCandidates(sdp)}, символов ${code.length}`,
    )
    return code
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
      console.debug(
        `[p2p] нет отпечатка: свой ${localFingerprint === null ? 'НЕТ' : 'есть'},` +
          ` чужой ${remoteFingerprint === null ? 'НЕТ' : 'есть'};` +
          ` длины SDP ${localSdp.length}/${remoteSdp.length};` +
          ` строки: «${/a=fingerprint:[^\r\n]*/i.exec(localSdp)?.[0] ?? '—'}»` +
          ` / «${/a=fingerprint:[^\r\n]*/i.exec(remoteSdp)?.[0] ?? '—'}»`,
      )
      return this.fail(message('session.noFingerprint'))
    }

    // Порядок канонический, как в SAS: local||remote у сторон разный, и с
    // парольной фразой ключи разъезжались бы, а расшифровка молча падала.
    const [first, second] =
      compareBytes(localFingerprint, remoteFingerprint) <= 0
        ? [localFingerprint, remoteFingerprint]
        : [remoteFingerprint, localFingerprint]
    const salt = concat(first, second)
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

    console.debug(`[p2p] ключи выведены: роль ${role}`)
    this.patch({ sas, frameEncryption, encryptionReason: this.encryptionReason })
    this.announceEncryption()
    void this.announceKeyCheck()
  }

  private startTransforms(): boolean {
    if (this.connection === null || this.keys === null) return false
    if (detectTransformSupport() === 'none') {
      this.encryptionReason = 'unsupported'
      return false
    }

    // Включать шифрование в одну сторону нельзя: собеседник отдаст шифртекст
    // прямо в декодер — звук станет шумом, видео пропадёт.
    if (!this.peerFrameEncryption) {
      console.debug('[p2p] собеседник не умеет шифровать кадры — слой выключен с обеих сторон')
      this.encryptionReason = 'peerUnsupported'
      return false
    }

    // Разметку кадра мы разбираем только у VP8. Согласовалось другое — честнее
    // остаться на транспортном шифровании, чем отдать поток, который собеседник
    // не сможет прочесть ни одним кадром.
    if (!this.videoCodecSupported()) {
      this.encryptionReason = 'codecUnsupported'
      return false
    }

    const worker = new Worker(new URL('../crypto/media-worker.js', import.meta.url), {
      type: 'module',
    })
    this.worker = worker

    // Без этих сообщений неясно даже, доехали ли кадры до воркера: медиа
    // ломается тихо, соединение при этом выглядит здоровым.
    worker.addEventListener('error', (event) => {
      console.debug('[p2p] воркер шифрования не запустился:', event.message)
    })
    worker.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as {
        t?: string
        id?: string
        ok?: number
        failed?: number
        plaintext?: number
        reason?: string
        codec?: string
      }
      if (data.t === 'attached') console.debug(`[p2p] шифрование включено: ${data.id} (${data.codec})`)
      if (data.t !== 'stats') return

      console.debug(
        `[p2p] кадры ${data.id}: обработано ${data.ok}, отброшено ${data.failed}` +
          (data.reason === undefined ? '' : ` — ${data.reason}`),
      )

      // Свои провалы расшифровки собеседник у себя не видит: у него всё
      // отправляется штатно. Поэтому сообщаем их сами.
      if (data.id?.endsWith('/recv') !== true) return
      this.sendControl({ t: 'frames', ok: data.ok ?? 0, failed: data.failed ?? 0 })

      // Кадры короче нашего заголовка шифровали не мы — если только собеседник
      // не сказал обратного: его слову верим больше, чем счётчику.
      const downgrade = shouldDowngrade({
        peerReportedAttached: this.peerAttachedEncryption,
        decrypted: data.ok ?? 0,
        plaintext: data.plaintext ?? 0,
      })
      if (downgrade) this.downgradeEncryption()
    })

    const attached = attachAll(worker, this.connection, this.keys)
    const silent = this.connection.getSenders().filter((sender) => sender.track === null).length
    console.debug(
      `[p2p] трансформ навешен: ${attached}, отправителей ${this.connection.getSenders().length}` +
        ` (без дорожки ${silent}), получателей ${this.connection.getReceivers().length}`,
    )
    this.encryptionReason = attached ? 'active' : 'attachFailed'
    return attached
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
    }, this.signaling === null ? CONNECT_TIMEOUT_MS.manual : CONNECT_TIMEOUT_MS.signaling)
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
      this.announceEncryption()
      void this.announceKeyCheck()
    })

    channel.addEventListener('message', (event) => {
      const control = decodeMessage(String(event.data))
      if (control === null) return

      if (control.t === 'mute') {
        this.patch({ peerMuted: { ...this.view.peerMuted, [control.kind]: control.muted } })
      }
      if (control.t === 'quality') {
        // Просьбу собеседника выполняем: камера у нас, а смотрит он. Иначе
        // селектор качества управлял бы тем, чего человек не видит.
        console.debug(`[p2p] собеседник просит качество ${control.preset}`)
        void this.applyPeerQuality(control.preset)
      }
      if (control.t === 'encryption') {
        // Свой слой шифрования видно по журналу, а чужой — только с его слов.
        // Без этого односторонний открытый текст выглядит как наша поломка.
        console.debug(
          `[p2p] собеседник о шифровании кадров: навешено ${control.attached}` +
            `, поддержка ${control.support}`,
        )
        // Прямой ответ надёжнее счёта испорченных кадров: там любой промах по
        // ключу выглядел как открытый текст, и слой снимался напрасно.
        this.peerAttachedEncryption = control.attached
        if (
          shouldDowngrade({ peerReportedAttached: control.attached, decrypted: 0, plaintext: 0 })
        ) {
          this.downgradeEncryption(control.support === 'none' ? 'peerUnsupported' : 'attachFailed')
        }
      }
      if (control.t === 'keyCheck') void this.compareKeys(control.audio, control.video)
      if (control.t === 'frames') this.onPeerFrames(control.ok, control.failed)
      if (control.t === 'bye') this.endCall('peer')
    })
  }

  /**
   * Что собеседник сделал с нашими кадрами.
   *
   * Ноль расшифрованных при растущем счётчике отброшенных означает, что наш
   * поток до него доезжает, но читается как мусор: у нас шифрование включено,
   * у него — нет. В своей консоли этого не видно, отсюда и отчёт.
   */
  /**
   * Выключает шифрование кадров, когда собеседник его не применяет.
   *
   * Иначе звонок остаётся сломанным в обе стороны: его кадры мы отбрасываем,
   * наши он декодирует как шум. Транспортное шифрование при этом никуда не
   * девается — отключить его в WebRTC нельзя, — но сказать о понижении надо
   * вслух, и бейдж это показывает.
   */
  private downgradeEncryption(reason: EncryptionReason = 'peerPlaintext'): void {
    if (!this.view.frameEncryption || this.connection === null) return

    console.debug(`[p2p] снимаем шифрование кадров: ${reason}`)
    detachAll(this.connection)
    this.worker?.terminate()
    this.worker = null

    this.encryptionReason = reason
    this.patch({
      frameEncryption: false,
      encryptionReason: reason,
      notice: message('session.encryptionDowngraded'),
    })

    // Снятие в одну сторону хуже поломки, которую оно лечит: собеседник
    // продолжит шифровать, и его кадры пойдут прямо в декодер.
    this.announceEncryption()
  }

  /**
   * Что собеседник сделал с нашими кадрами.
   *
   * Счётчики накопительные, а первые кадры проваливаются всегда: пока идёт
   * согласование, трансформ ещё не навешен. Ругаться на накопленную сумму
   * значит ругаться на нормальный старт звонка, поэтому смотрим, растёт ли
   * число провалов между двумя подряд отчётами.
   */
  private onPeerFrames(ok: number, failed: number): void {
    console.debug(`[p2p] собеседник о наших кадрах: расшифровал ${ok}, отбросил ${failed}`)

    const previous = this.peerFailedFrames
    this.peerFailedFrames = failed
    if (ok > 0 || previous === null || failed <= previous || this.peerFramesWarned) return

    this.peerFramesWarned = true
    // Причину не выдумываем: расхождение ключей уже названо сверкой, снятый
    // слой — прямым отчётом. Осталось сказать то, что знаем наверняка.
    this.patch({ notice: message('session.peerCannotDecrypt') })
  }

  /**
   * Рассказывает собеседнику, удалось ли нам навесить шифрование.
   *
   * Согласование в конверте говорит лишь о намерении: браузер может заявить
   * поддержку и всё равно не применить трансформ. Тогда одна сторона шлёт
   * открытый текст, а вторая гадает, что сломалось у неё.
   */
  private announceEncryption(): void {
    this.sendControl({
      t: 'encryption',
      attached: this.view.frameEncryption,
      support: detectTransformSupport(),
    })
  }

  /**
   * Отдаёт контрольные суммы ключей, которыми мы шифруем.
   *
   * Собеседник сверит их со своими ключами приёма: сойтись они обязаны, а если
   * не сошлись — это расхождение ключей, и назвать его надо так, а не оставлять
   * в виде OperationError на каждом кадре.
   */
  /** Разбираем ли мы разметку согласованного видеокодека. */
  private videoCodecSupported(): boolean {
    const receiver = this.connection?.getReceivers().find((item) => item.track?.kind === 'video')
    if (receiver === undefined) return true

    const codec = negotiatedCodec(receiver, 'video')
    if (codec === 'vp8') return true

    console.debug(`[p2p] видео согласовано как ${codec} — разметку такого кадра мы не разбираем`)
    return false
  }

  private async announceKeyCheck(): Promise<void> {
    if (this.keys === null) return

    this.sendControl({
      t: 'keyCheck',
      audio: await keyCheck(this.keys.audio.send),
      video: await keyCheck(this.keys.video.send),
    })
  }

  private async compareKeys(audio: string, video: string): Promise<void> {
    if (this.keys === null) return

    const mine = {
      audio: await keyCheck(this.keys.audio.recv),
      video: await keyCheck(this.keys.video.recv),
    }
    const mismatched = (['audio', 'video'] as const).filter((kind) => {
      const theirs = kind === 'audio' ? audio : video
      return mine[kind] !== theirs
    })

    if (mismatched.length === 0) {
      console.debug('[p2p] ключи сошлись')
      return
    }

    console.debug(
      `[p2p] ключи разошлись (${mismatched.join(', ')}): у нас ${mine.audio}/${mine.video},` +
        ` у собеседника ${audio}/${video}`,
    )
    this.patch({ notice: message('session.keyMismatch') })
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

  /**
   * Подставляет дорожку, добытую уже во время звонка.
   *
   * Трансиверы созданы заранее, поэтому замена не требует нового обмена
   * кодами — иначе занятая на старте камера оставалась бы недоступной до
   * конца разговора.
   */
  async attachTrack(track: MediaStreamTrack): Promise<void> {
    const sender = this.connection
      ?.getTransceivers()
      .find((item) => item.receiver.track.kind === track.kind)?.sender

    if (sender !== undefined) {
      await sender.replaceTrack(track)

      // Шифрование навешивается на отправителей при выводе ключей, а тогда у
      // этого дорожки ещё не было — и она ушла бы открытым текстом прямо в
      // расшифровщик собеседника.
      const kind = track.kind === 'audio' ? 'audio' : 'video'
      if (this.worker !== null && this.keys !== null && this.view.frameEncryption) {
        attachTransform(this.worker, sender, {
          kind,
          direction: 'send',
          codec: negotiatedCodec(sender, kind),
          keys: this.keys[kind].send,
        })
      }
    }
    this.localStream?.addTrack(track)

    const kind = track.kind === 'audio' ? 'audio' : 'video'
    this.patch({
      canSend: { ...this.view.canSend, [kind]: true },
      muted: { ...this.view.muted, [kind]: !track.enabled },
    })
  }

  /** Текущее состояние своих дорожек — нужно интерфейсу для кнопок. */
  isMuted(kind: 'audio' | 'video'): boolean {
    return this.view.muted[kind]
  }

  /** Меняет исходящее качество по просьбе собеседника, не трогая свой выбор. */
  private async applyPeerQuality(quality: QualityPreset): Promise<void> {
    if (this.connection === null || this.localStream === null) return
    await applyQuality(this.connection, this.localStream, quality)
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
    this.stopKeepAlive()
    if (this.releaseTimer !== null) clearTimeout(this.releaseTimer)
    this.releaseTimer = null
    if (this.statsTimer !== null) clearInterval(this.statsTimer)
    if (this.ratchetTimer !== null) clearInterval(this.ratchetTimer)
    this.statsTimer = null
    this.ratchetTimer = null

    this.signaling?.close()
    this.channel?.close()
    this.connection?.close()
    this.worker?.terminate()

    // Входящие дорожки тоже надо погасить: пока они живы, телефон считает,
    // что разговор продолжается.
    for (const track of this.remoteStream.getTracks()) {
      track.stop()
      this.remoteStream.removeTrack(track)
    }
    if (this.ownsStream) stopStream(this.localStream)

    this.signaling = null
    this.channel = null
    this.connection = null
    this.worker = null
    this.localStream = null
  }

  private fail(reason: Message, suggestServer = false): void {
    console.debug(`[p2p] провал: ${reason.key} (фаза ${this.view.phase})`)
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
