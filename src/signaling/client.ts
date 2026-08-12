import {
  decodeServerMessage,
  encodeClientMessage,
} from '../protocol/signaling.js'
import type { IceServerConfig, ServerMessage } from '../protocol/signaling.js'
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
  onError(message: string): void
  onClosed(): void
}

/**
 * Клиент сигнального сервера.
 *
 * Всё, что уходит в сеть, запечатано ключом из секрета комнаты, а секрет живёт
 * только во фрагменте ссылки. Сервер видит идентификатор комнаты и блоб — ни
 * SDP, ни DTLS-fingerprint ему недоступны.
 */
export class SignalingClient {
  private socket: WebSocket | null = null
  private key: CryptoKey | null = null
  private closedByUs = false

  constructor(
    private readonly invite: Invite,
    private readonly events: SignalingEvents,
  ) {}

  async connect(): Promise<void> {
    this.key = await deriveSignalingKey(this.invite.secret)

    const socket = new WebSocket(this.invite.server)
    this.socket = socket

    socket.addEventListener('open', () => {
      socket.send(encodeClientMessage({ t: 'join', room: this.invite.roomId }))
    })

    socket.addEventListener('message', (event) => {
      void this.handle(String(event.data))
    })

    socket.addEventListener('error', () => {
      this.events.onError('Не удалось связаться с сигнальным сервером.')
    })

    socket.addEventListener('close', () => {
      if (!this.closedByUs) this.events.onClosed()
    })
  }

  /** Отправляет SDP собеседнику через сервер, предварительно запечатав. */
  async send(payload: string): Promise<void> {
    if (this.socket?.readyState !== WebSocket.OPEN || this.key === null) return
    this.socket.send(encodeClientMessage({ t: 'signal', payload: await seal(this.key, payload) }))
  }

  close(): void {
    this.closedByUs = true
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(encodeClientMessage({ t: 'leave' }))
    }
    this.socket?.close()
    this.socket = null
  }

  private async handle(raw: string): Promise<void> {
    // Сервер тоже недоверенный: его могли подменить, поэтому разбираем строго.
    const message: ServerMessage | null = decodeServerMessage(raw)
    if (message === null) return

    switch (message.t) {
      case 'joined':
        return this.events.onJoined(message.role, message.iceServers)

      case 'peer-joined':
        return this.events.onPeerJoined()

      case 'peer-left':
        return this.events.onPeerLeft()

      case 'signal': {
        if (this.key === null) return
        try {
          this.events.onSignal(await open(this.key, message.payload))
        } catch {
          // Блоб не расшифровался: либо у собеседника другая ссылка, либо
          // кто-то по дороге пытался вмешаться. Молча игнорировать нельзя.
          this.events.onError(
            'Сообщение собеседника не прошло проверку подлинности. Убедитесь, что вы открыли одну и ту же ссылку.',
          )
        }
        return
      }

      case 'error':
        return this.events.onError(describe(message.code, message.message))
    }
  }
}

function describe(code: string, fallback: string): string {
  switch (code) {
    case 'room-full':
      return 'В этой комнате уже двое. Создайте новую ссылку.'
    case 'rate-limited':
      return 'Сервер ограничил частоту сообщений и закрыл соединение.'
    case 'server-error':
      return 'Сервер перегружен: слишком много активных комнат.'
    default:
      return fallback
  }
}
