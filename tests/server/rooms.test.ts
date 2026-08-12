import { describe, expect, it } from 'vitest'
import { RoomRegistry } from '../../server/src/rooms.js'
import type { Peer } from '../../server/src/rooms.js'

const ROOM = 'AAAAAAAAAAAAAAAAAAAAAA'
const OTHER = 'BBBBBBBBBBBBBBBBBBBBBB'

/** Участник, запоминающий всё, что ему отправили. */
function peer(): Peer & { sent: string[]; closed: boolean } {
  const state = {
    sent: [] as string[],
    closed: false,
    send(raw: string) {
      state.sent.push(raw)
    },
    close() {
      state.closed = true
    },
  }
  return state
}

function registry(maxRooms = 10, ttlMs = 60_000): RoomRegistry {
  return new RoomRegistry(maxRooms, ttlMs)
}

describe('вход в комнату', () => {
  it('первого делает инициатором, второго отвечающим', () => {
    const rooms = registry()
    expect(rooms.join(ROOM, peer())).toMatchObject({ ok: true, role: 'initiator' })
    expect(rooms.join(ROOM, peer())).toMatchObject({ ok: true, role: 'responder' })
  })

  it('сообщает второму, что в комнате уже кто-то есть', () => {
    const rooms = registry()
    const first = peer()
    rooms.join(ROOM, first)

    const result = rooms.join(ROOM, peer())
    expect(result.ok && result.peer).toBe(first)
  })

  it('первого никем не встречает', () => {
    const rooms = registry()
    const result = rooms.join(ROOM, peer())
    expect(result.ok && result.peer).toBeNull()
  })

  it('не пускает третьего: комната строго на двоих', () => {
    const rooms = registry()
    rooms.join(ROOM, peer())
    rooms.join(ROOM, peer())

    expect(rooms.join(ROOM, peer())).toEqual({ ok: false, reason: 'room-full' })
  })

  it('держит комнаты независимо друг от друга', () => {
    const rooms = registry()
    rooms.join(ROOM, peer())
    expect(rooms.join(OTHER, peer())).toMatchObject({ role: 'initiator' })
    expect(rooms.size).toBe(2)
  })
})

describe('маршрутизация между участниками', () => {
  it('находит собеседника с обеих сторон', () => {
    const rooms = registry()
    const alice = peer()
    const bob = peer()
    rooms.join(ROOM, alice)
    rooms.join(ROOM, bob)

    expect(rooms.partnerOf(alice)).toBe(bob)
    expect(rooms.partnerOf(bob)).toBe(alice)
  })

  it('не находит собеседника, пока участник один', () => {
    const rooms = registry()
    const alice = peer()
    rooms.join(ROOM, alice)
    expect(rooms.partnerOf(alice)).toBeNull()
  })

  it('не находит собеседника у постороннего соединения', () => {
    expect(registry().partnerOf(peer())).toBeNull()
  })

  it('не путает участников разных комнат', () => {
    const rooms = registry()
    const alice = peer()
    const stranger = peer()
    rooms.join(ROOM, alice)
    rooms.join(OTHER, stranger)

    expect(rooms.partnerOf(alice)).toBeNull()
  })
})

describe('выход из комнаты', () => {
  it('возвращает оставшегося, чтобы его предупредили', () => {
    const rooms = registry()
    const alice = peer()
    const bob = peer()
    rooms.join(ROOM, alice)
    rooms.join(ROOM, bob)

    expect(rooms.leave(alice)).toBe(bob)
  })

  it('на последнем участнике возвращает null', () => {
    const rooms = registry()
    const alice = peer()
    rooms.join(ROOM, alice)
    expect(rooms.leave(alice)).toBeNull()
  })

  it('освобождает место для нового участника', () => {
    const rooms = registry()
    const alice = peer()
    rooms.join(ROOM, alice)
    rooms.join(ROOM, peer())
    rooms.leave(alice)

    expect(rooms.join(ROOM, peer())).toMatchObject({ ok: true })
  })

  it('терпит выход того, кто никуда не входил', () => {
    expect(() => registry().leave(peer())).not.toThrow()
  })

  it('терпит повторный выход', () => {
    const rooms = registry()
    const alice = peer()
    rooms.join(ROOM, alice)
    rooms.leave(alice)

    expect(rooms.leave(alice)).toBeNull()
  })
})

describe('уборка комнат', () => {
  it('держит опустевшую комнату, пока не вышел TTL', () => {
    // Собеседник мог перезагрузить вкладку и вернуться по той же ссылке.
    const rooms = registry(10, 60_000)
    const alice = peer()
    rooms.join(ROOM, alice, 0)
    rooms.leave(alice, 0)

    rooms.collect(59_000)
    expect(rooms.size).toBe(1)
  })

  it('выбрасывает комнату после TTL', () => {
    const rooms = registry(10, 60_000)
    const alice = peer()
    rooms.join(ROOM, alice, 0)
    rooms.leave(alice, 0)

    expect(rooms.collect(60_000)).toBe(1)
    expect(rooms.size).toBe(0)
  })

  it('не трогает живые комнаты', () => {
    const rooms = registry(10, 1)
    rooms.join(ROOM, peer(), 0)

    expect(rooms.collect(1_000_000)).toBe(0)
    expect(rooms.size).toBe(1)
  })

  it('отказывает в новой комнате при переполнении', () => {
    const rooms = registry(1, 60_000)
    rooms.join(ROOM, peer(), 0)

    expect(rooms.join(OTHER, peer(), 0)).toEqual({ ok: false, reason: 'capacity' })
  })

  it('перед отказом пытается убрать протухшие комнаты', () => {
    const rooms = registry(1, 60_000)
    const alice = peer()
    rooms.join(ROOM, alice, 0)
    rooms.leave(alice, 0)

    expect(rooms.join(OTHER, peer(), 60_000)).toMatchObject({ ok: true })
  })
})
