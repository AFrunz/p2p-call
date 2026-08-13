import type { Role } from '../../src/signaling/types.js'

export type JoinResult =
  | { ok: true; role: Role; peer: Peer | null }
  | { ok: false; reason: 'room-full' | 'capacity' }

export interface Peer {
  /** Куда отправлять ретранслируемые сообщения. */
  send(raw: string): void
  close(): void
}

interface Room {
  peers: Peer[]
  /** Роль каждого участника: она переживает уход и возвращение соседа. */
  roles: Map<Peer, Role>
  /** Момент, когда комната опустела; null — пока в ней кто-то есть. */
  emptySince: number | null
}

/**
 * Реестр комнат на двоих.
 *
 * Сервер принципиально ничего не знает о содержимом: `payload` для него —
 * непрозрачный блоб, запечатанный секретом из фрагмента ссылки. Здесь только
 * маршрутизация и защита от разрастания.
 */
export class RoomRegistry {
  private readonly rooms = new Map<string, Room>()
  private readonly location = new Map<Peer, string>()

  constructor(
    private readonly maxRooms: number,
    private readonly roomTtlMs: number,
  ) {}

  get size(): number {
    return this.rooms.size
  }

  join(roomId: string, peer: Peer, now: number = Date.now()): JoinResult {
    let room = this.rooms.get(roomId)

    if (room === undefined) {
      if (this.rooms.size >= this.maxRooms) {
        this.collect(now)
        if (this.rooms.size >= this.maxRooms) return { ok: false, reason: 'capacity' }
      }
      room = { peers: [], roles: new Map(), emptySince: null }
      this.rooms.set(roomId, room)
    }

    if (room.peers.length >= 2) return { ok: false, reason: 'room-full' }

    // Роль берём свободную, а не по порядку прихода. Иначе после
    // переподключения инициатор возвращается вторым, получает роль
    // отвечающего — и предложение соединения не создаёт никто.
    const existing = room.peers[0] ?? null
    const taken = existing === null ? null : (room.roles.get(existing) ?? null)
    const role: Role = taken === 'initiator' ? 'responder' : 'initiator'

    room.peers.push(peer)
    room.roles.set(peer, role)
    room.emptySince = null
    this.location.set(peer, roomId)

    return { ok: true, role, peer: existing }
  }

  /** Второй участник комнаты, если он есть. */
  partnerOf(peer: Peer): Peer | null {
    const roomId = this.location.get(peer)
    if (roomId === undefined) return null

    const room = this.rooms.get(roomId)
    return room?.peers.find((candidate) => candidate !== peer) ?? null
  }

  leave(peer: Peer, now: number = Date.now()): Peer | null {
    const roomId = this.location.get(peer)
    if (roomId === undefined) return null

    this.location.delete(peer)
    const room = this.rooms.get(roomId)
    if (room === undefined) return null

    room.peers = room.peers.filter((candidate) => candidate !== peer)
    room.roles.delete(peer)
    if (room.peers.length === 0) {
      // Не удаляем сразу: собеседник может переподключиться по той же ссылке.
      room.emptySince = now
      return null
    }
    return room.peers[0] ?? null
  }

  /** Выбрасывает комнаты, пустующие дольше TTL. */
  collect(now: number = Date.now()): number {
    let removed = 0
    for (const [roomId, room] of this.rooms) {
      if (room.emptySince !== null && now - room.emptySince >= this.roomTtlMs) {
        this.rooms.delete(roomId)
        removed++
      }
    }
    return removed
  }
}
