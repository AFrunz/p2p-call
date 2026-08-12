import type { Bytes } from '../bytes.js'
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
import { probeNetwork } from '../net/probe.js'
import type { NetworkReport } from '../net/probe.js'
import { decodeEnvelope, encodeEnvelope } from '../signaling/codec.js'
import { CodeFormatError } from '../signaling/codec.js'
import { SignalingClient } from '../signaling/client.js'
import { buildInviteLink, generateInvite, parseInviteLink } from '../signaling/link.js'
import type { Invite } from '../signaling/link.js'
import { extractFingerprint } from '../signaling/sdp.js'
import type { Role } from '../signaling/types.js'
import type { QualityPreset } from '../media/quality.js'
import { applyQuality, describeMissing, requestMedia, stopStream } from './media.js'
import { StatsCollector, createConnection, waitForGathering } from './peer.js'
import type { CallStats } from './peer.js'
import { attachAll, detectTransformSupport } from './transform.js'

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

export interface SessionView {
  phase: Phase
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
  stats: CallStats | null
  peerMuted: { audio: boolean; video: boolean }
  /** Наше состояние: по умолчанию входим в звонок молча и без картинки. */
  muted: { audio: boolean; video: boolean }
  /** Есть ли что передавать: без камеры или микрофона кнопки бессмысленны. */
  canSend: { audio: boolean; video: boolean }
  /** Предупреждение, не мешающее звонку, — в отличие от error. */
  notice: string | null
  error: string | null
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
    role: null,
    outgoingCode: null,
    inviteLink: null,
    sas: null,
    frameEncryption: false,
    network: null,
    stats: null,
    peerMuted: { audio: false, video: false },
    muted: { audio: true, video: true },
    canSend: { audio: false, video: false },
    notice: null,
    error: null,
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
  private readonly remoteStream = new MediaStream()
  private readonly stats = new StatsCollector()
  private statsTimer: ReturnType<typeof setInterval> | null = null
  private ratchetTimer: ReturnType<typeof setInterval> | null = null
  private restarted = false

  constructor(private options: SessionOptions) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.view)
    return () => this.listeners.delete(listener)
  }

  get media(): { local: MediaStream | null; remote: MediaStream } {
    return { local: this.localStream, remote: this.remoteStream }
  }

  /** Захватывает камеру и параллельно проверяет сеть. */
  async prepare(): Promise<void> {
    this.patch({ phase: 'preparing', error: null })

    try {
      const media = await requestMedia({
        preset: this.options.quality,
        cameraId: this.options.cameraId ?? null,
        microphoneId: this.options.microphoneId ?? null,
      })
      this.localStream = media.stream
      this.keyPair = await generateKeyPair()

      // Входим в звонок молча и без картинки: включить себя — осознанное
      // действие, а вот случайно оказаться в эфире не должно быть возможно.
      for (const track of media.stream.getTracks()) track.enabled = false

      // Отсутствие устройств не мешает подключиться: без них человек будет
      // смотреть и слушать. Но сказать об этом надо явно.
      this.patch({
        canSend: {
          audio: media.stream.getAudioTracks().length > 0,
          video: media.stream.getVideoTracks().length > 0,
        },
        notice: media.problem?.message ?? describeMissing(media.missing),
      })

      // Диагностика сети идёт фоном: она полезна, но задерживать из-за неё
      // показ своего изображения незачем.
      void probeNetwork(buildIceServers().map((server) => String(server.urls))).then((network) =>
        this.patch({ network }),
      )

      this.patch({ phase: 'idle' })
    } catch (error) {
      this.fail(error instanceof Error ? error.message : 'Не удалось подготовить звонок.')
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
    try {
      const envelope = await decodeEnvelope(code)
      this.remotePublicKey = envelope.publicKey

      if (this.connection === null) {
        await this.openConnection('responder')
        const connection = this.connection!

        await connection.setRemoteDescription({ type: 'offer', sdp: envelope.sdp })
        await connection.setLocalDescription(await connection.createAnswer())
        await waitForGathering(connection)

        this.patch({ phase: 'connecting', outgoingCode: await this.buildCode('responder') })
      } else {
        if (envelope.role !== 'responder') {
          throw new Error('Это код создателя звонка, а нужен ответный код собеседника.')
        }
        await this.connection.setRemoteDescription({ type: 'answer', sdp: envelope.sdp })
        this.patch({ phase: 'connecting' })
      }

      await this.establishKeys()
    } catch (error) {
      this.fail(
        error instanceof CodeFormatError
          ? 'Код не распознан. Проверьте, что скопировали его целиком.'
          : describe(error),
      )
    }
  }

  // --- режим со своим сервером: подключение по ссылке ----------------------

  /** Создаёт комнату на своём сервере и возвращает ссылку-приглашение. */
  async createLink(): Promise<void> {
    const server = this.options.signalingServer
    if (server === null || server === undefined) {
      return this.fail('Сначала укажите адрес своего сигнального сервера в настройках.')
    }

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
    if (invite === null) return this.fail('Ссылка-приглашение не распознана.')

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
      onPeerLeft: () => this.patch({ error: 'Собеседник отключился.' }),
      onSignal: (payload) => {
        void this.onSignal(payload)
      },
      onError: (message) => this.patch({ error: message }),
      onClosed: () => {
        if (this.view.phase !== 'connected') {
          this.patch({ error: 'Соединение с сигнальным сервером разорвано.' })
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
      void this.onConnectionState(connection.connectionState)
    })
  }

  private async onConnectionState(state: RTCPeerConnectionState): Promise<void> {
    if (state === 'connected') {
      this.patch({ phase: 'connected', error: null })
      this.startTimers()
      return
    }

    if (state === 'failed') {
      // Маппинги NAT могли смениться — одна автоматическая попытка оправдана.
      if (!this.restarted && this.connection !== null && this.view.role === 'initiator') {
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
      this.fail(unreachableMessage(this.view.network))
    }
  }

  /** Собирает конверт с нашим SDP и публичным ключом. */
  private async buildCode(role: Role): Promise<string> {
    const description = this.connection?.localDescription
    if (description == null || this.keyPair === null) {
      throw new Error('Соединение ещё не готово.')
    }

    return encodeEnvelope({
      version: 1,
      role,
      publicKey: await exportPublicKey(this.keyPair.publicKey),
      sdp: description.sdp,
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
      return this.fail('В SDP нет отпечатка SHA-256: продолжать небезопасно.')
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
      const message = decodeMessage(String(event.data))
      if (message === null) return

      if (message.t === 'mute') {
        this.patch({ peerMuted: { ...this.view.peerMuted, [message.kind]: message.muted } })
      }
      if (message.t === 'bye') this.patch({ error: 'Собеседник завершил звонок.' })
    })
  }

  private sendControl(message: ControlMessage): void {
    if (this.channel?.readyState === 'open') this.channel.send(encodeMessage(message))
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
    this.teardown()
    this.patch({ phase: 'ended' })
  }

  private teardown(): void {
    if (this.statsTimer !== null) clearInterval(this.statsTimer)
    if (this.ratchetTimer !== null) clearInterval(this.ratchetTimer)
    this.statsTimer = null
    this.ratchetTimer = null

    this.signaling?.close()
    this.channel?.close()
    this.connection?.close()
    this.worker?.terminate()
    stopStream(this.localStream)

    this.signaling = null
    this.channel = null
    this.connection = null
    this.worker = null
    this.localStream = null
  }

  private fail(message: string): void {
    this.teardown()
    this.patch({ phase: 'failed', error: message })
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'Неизвестная ошибка.'
}

/** Текст для случая, когда все пути исчерпаны. */
function unreachableMessage(network: NetworkReport | null): string {
  const reason =
    network?.verdict === 'symmetric'
      ? 'Ваш роутер выдаёт новый внешний порт на каждого собеседника (symmetric NAT). '
      : network?.verdict === 'blocked'
        ? 'В вашей сети заблокирован UDP. '
        : ''

  return (
    `Не удалось установить прямое соединение. ${reason}` +
    'Попробуйте перейти с мобильного интернета на Wi-Fi, отключить VPN — ' +
    'или развернуть свой сервер, достаточно одному из вас.'
  )
}
