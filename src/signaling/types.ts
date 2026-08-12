import type { Bytes } from '../bytes.js'

/** Тип ICE-кандидата в порядке возрастания «стоимости» пути. */
export type CandidateType = 'host' | 'srflx' | 'prflx' | 'relay'

/** Разобранный ICE-кандидат из строки `a=candidate:...`. */
export interface IceCandidateInfo {
  foundation: string
  /** 1 = RTP, 2 = RTCP. */
  component: number
  protocol: 'udp' | 'tcp'
  priority: number
  address: string
  port: number
  type: CandidateType
  /** Базовый адрес — для srflx/relay указывает на локальный интерфейс. */
  relatedAddress?: string
  relatedPort?: number
  tcpType?: 'active' | 'passive' | 'so'
}

/** Роль участника: кто создал звонок, кто присоединился. */
export type Role = 'initiator' | 'responder'

/**
 * Полезная нагрузка кода подключения.
 *
 * SDP хранится целиком: браузеры расходятся в payload type и extmap, и попытка
 * пересобрать SDP из «канонического шаблона» ломает интероп между Chrome и
 * Safari. Deflate сжимает SDP в 4-6 раз за счёт повторов, чего достаточно,
 * чтобы код влезал в QR.
 */
export interface Envelope {
  version: number
  role: Role
  /** Сырой публичный ключ ECDH P-256, 65 байт, формат raw (0x04 || X || Y). */
  publicKey: Bytes
  sdp: string
}
