import {
  decodeServerMessage,
  encodeClientMessage,
} from '../protocol/signaling.js'
import type { IceServerConfig, ServerMessage } from '../protocol/signaling.js'
import { message } from '../i18n/message.js'
import type { Message } from '../i18n/message.js'
import { deriveSignalingKey, open, seal } from './sealed.js'
import type { Invite } from './link.js'
import type { Role } from './types.js'

export interface SignalingEvents {
  /** Мы вошли в комнату; роль определяет, кто делает offer. */
  onJoined(role: Role, iceServers: IceServerConfig[]): void
  onPeerJoined(): void
  onPeerLeft(): void
  /** Расшифрованное содержимое: сервер его никогда не видел. */
  onSignal(payload: string): void
  onError(reason: Message): void
  onClosed(): void
}

/** Задержки перед попытками переподключения, мс. */
const RETRY_DELAYS = [1_000, 2_000, 5_000, 10_000, 20_000]

/**
 * Клиент сигнального сервера. Всё, что уходит в сеть, запечатано ключом из
 * секрета комнаты: сервер видит только идентификатор комнаты и блоб.
 */
export class SignalingClient {
  private socket: WebSocket | null = null
  private key: CryptoKey | null = null
  private closedByUs = false
  private attempt = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly invite: Invite,
    private readonly events: SignalingEvents,
  ) {}

  async connect(): Promise<void> {
    this.key = await deriveSignalingKey(this.invite.secret)

    const socket = new WebSocket(this.invite.server)
    this.socket = socket

    socket.addEventListener('open', () => {
      this.attempt = 0
      socket.send(encodeClientMessage({ t: 'join', room: this.invite.roomId }))
    })

    socket.addEventListener('message', (event) => {
      void this.handle(String(event.data))
    })

    // Ошибку сокета не показываем сразу: за ней всегда идёт close, и решение
    // принимается там — после того, как исчерпаны попытки вернуться.
    socket.addEventListener('error', () => undefined)

    socket.addEventListener('close', () => {
      if (this.closedByUs) return
      if (socket !== this.socket) return

      // Сокет мог умереть от бездействия, от смены сети, от сна устройства.
      // Всё это лечится повторным подключением: комната та же, роль за нами
      // закреплена, а медиа при живом соединении даже не заметит перерыва.
      if (this.attempt < RETRY_DELAYS.length) {
        const delay = RETRY_DELAYS[this.attempt] ?? 20_000
        this.attempt++
        this.retryTimer = setTimeout(() => void this.connect(), delay)
        return
      }
      this.events.onClosed()
    })
  }

  /** Отправляет SDP собеседнику через сервер, предварительно запечатав. */
  async send(payload: string): Promise<void> {
    if (this.socket?.readyState !== WebSocket.OPEN || this.key === null) return
    this.socket.send(encodeClientMessage({ t: 'signal', payload: await seal(this.key, payload) }))
  }

  close(): void {
    this.closedByUs = true
    if (this.retryTimer !== null) clearTimeout(this.retryTimer)
    this.retryTimer = null
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(encodeClientMessage({ t: 'leave' }))
    }
    this.socket?.close()
    this.socket = null
  }

  private async handle(raw: string): Promise<void> {
    // Сервер тоже недоверенный: его могли подменить, поэтому разбираем строго.
    const parsed: ServerMessage | null = decodeServerMessage(raw)
    if (parsed === null) return

    switch (parsed.t) {
      case 'joined':
        return this.events.onJoined(parsed.role, parsed.iceServers)

      case 'peer-joined':
        return this.events.onPeerJoined()

      case 'peer-left':
        return this.events.onPeerLeft()

      case 'signal': {
        if (this.key === null) return
        try {
          this.events.onSignal(await open(this.key, parsed.payload))
        } catch {
          // Блоб не расшифровался: либо у собеседника другая ссылка, либо
          // кто-то по дороге пытался вмешаться. Молча игнорировать нельзя.
          this.events.onError(message('signaling.tampered'))
        }
        return
      }

      case 'error':
        return this.events.onError(describe(parsed.code))
    }
  }
}

function describe(code: string): Message {
  switch (code) {
    case 'room-full':
      return message('signaling.roomFull')
    case 'rate-limited':
      return message('signaling.rateLimited')
    case 'server-error':
      return message('signaling.serverError')
    default:
      return message('signaling.unreachable')
  }
}
