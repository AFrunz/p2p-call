import { describe, expect, it } from 'vitest'
import {
  INVITE_VERSION,
  ROOM_SECRET_BYTES,
  buildInviteLink,
  generateInvite,
  isAllowedServer,
  parseInviteLink,
} from '../../src/signaling/link.js'
import { fromBase64Url, toBase64Url } from '../../src/signaling/codec.js'

const BASE = 'https://user.github.io/p2p-call/'
const SERVER = 'wss://call.example.com/ws'

describe('generateInvite', () => {
  it('выдаёт секрет нужной длины', () => {
    expect(generateInvite(SERVER).secret.length).toBe(ROOM_SECRET_BYTES)
  })

  it('каждый раз выдаёт новую комнату и новый секрет', () => {
    const first = generateInvite(SERVER)
    const second = generateInvite(SERVER)
    expect(first.roomId).not.toBe(second.roomId)
    expect(first.secret).not.toEqual(second.secret)
  })

  it('выдаёт идентификатор комнаты в 22 символа base64url', () => {
    expect(generateInvite(SERVER).roomId).toMatch(/^[A-Za-z0-9_-]{22}$/)
  })

  it('не даёт создать приглашение на незашифрованный сервер', () => {
    expect(() => generateInvite('ws://call.example.com/ws')).toThrow()
    expect(() => generateInvite('https://call.example.com/ws')).toThrow()
  })
})

describe('buildInviteLink', () => {
  it('переживает round-trip', () => {
    const invite = generateInvite(SERVER)
    const parsed = parseInviteLink(buildInviteLink(BASE, invite))

    expect(parsed).not.toBeNull()
    expect(parsed!.server).toBe(invite.server)
    expect(parsed!.roomId).toBe(invite.roomId)
    expect(parsed!.secret).toEqual(invite.secret)
  })

  it('прячет всё полезное во фрагмент: до решётки нет ни секрета, ни комнаты', () => {
    // Фрагмент не уходит на сервер ни в запросе, ни в Referer — на этом
    // держится вся защита от подмены со стороны сигнального сервера.
    const invite = generateInvite(SERVER)
    const link = buildInviteLink(BASE, invite)
    const beforeHash = link.slice(0, link.indexOf('#'))

    expect(beforeHash).toBe(BASE)
    expect(beforeHash).not.toContain(invite.roomId)
    expect(beforeHash).not.toContain(toBase64Url(invite.secret))
  })

  it('заменяет уже имеющийся фрагмент, а не приклеивает второй', () => {
    const link = buildInviteLink(`${BASE}#j=старое`, generateInvite(SERVER))
    expect(link.split('#')).toHaveLength(2)
  })

  it('умещается в длину, пригодную для мессенджера и QR', () => {
    expect(buildInviteLink(BASE, generateInvite(SERVER)).length).toBeLessThan(300)
  })

  it('отвергает секрет неверной длины', () => {
    const invite = generateInvite(SERVER)
    expect(() => buildInviteLink(BASE, { ...invite, secret: new Uint8Array(16) })).toThrow()
  })
})

describe('parseInviteLink', () => {
  it('принимает голый фрагмент без адреса страницы', () => {
    const invite = generateInvite(SERVER)
    const link = buildInviteLink(BASE, invite)
    const fragment = link.slice(link.indexOf('#') + 1)

    expect(parseInviteLink(fragment)?.roomId).toBe(invite.roomId)
  })

  it('возвращает null на ссылке без приглашения', () => {
    expect(parseInviteLink(BASE)).toBeNull()
    expect(parseInviteLink(`${BASE}#`)).toBeNull()
    expect(parseInviteLink(`${BASE}#other=value`)).toBeNull()
  })

  it('возвращает null на мусоре во фрагменте', () => {
    expect(parseInviteLink(`${BASE}#j=не-base64url!!`)).toBeNull()
    expect(parseInviteLink(`${BASE}#j=`)).toBeNull()
  })

  it('возвращает null на обрезанном приглашении', () => {
    const link = buildInviteLink(BASE, generateInvite(SERVER))
    expect(parseInviteLink(link.slice(0, link.length - 10))).toBeNull()
  })

  it('возвращает null на незнакомой версии формата', () => {
    const invite = generateInvite(SERVER)
    const link = buildInviteLink(BASE, invite)
    const payload = fromBase64Url(link.slice(link.indexOf('#j=') + 3))
    payload[0] = INVITE_VERSION + 1

    expect(parseInviteLink(`${BASE}#j=${toBase64Url(payload)}`)).toBeNull()
  })

  it('отвергает приглашение, ведущее на незашифрованный сервер', () => {
    // Иначе достаточно подсунуть ссылку с ws://, чтобы сигналинг пошёл открытым
    // текстом мимо TLS.
    const invite = generateInvite(SERVER)
    const link = buildInviteLink(BASE, invite)
    const payload = fromBase64Url(link.slice(link.indexOf('#j=') + 3))

    const evil = 'ws://evil.example.com/ws'
    const server = new TextEncoder().encode(evil)
    const head = payload.subarray(0, 49)
    const tampered = new Uint8Array(49 + 2 + server.length)
    tampered.set(head, 0)
    new DataView(tampered.buffer).setUint16(49, server.length)
    tampered.set(server, 51)

    expect(parseInviteLink(`${BASE}#j=${toBase64Url(tampered)}`)).toBeNull()
  })
})

describe('isAllowedServer', () => {
  it('принимает wss', () => {
    expect(isAllowedServer('wss://call.example.com/ws')).toBe(true)
  })

  it('принимает ws только на локальной машине — для разработки', () => {
    expect(isAllowedServer('ws://localhost:8080/ws')).toBe(true)
    expect(isAllowedServer('ws://127.0.0.1:8080/ws')).toBe(true)
    expect(isAllowedServer('ws://[::1]:8080/ws')).toBe(true)
    expect(isAllowedServer('ws://call.example.com/ws')).toBe(false)
  })

  it('отвергает всё, что не websocket', () => {
    for (const url of ['https://call.example.com', 'http://localhost', 'javascript:alert(1)', '']) {
      expect(isAllowedServer(url), url).toBe(false)
    }
  })
})
