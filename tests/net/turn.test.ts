import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STUN_SERVERS,
  buildIceServers,
  parseTurnUrl,
  validateTurnConfig,
} from '../../src/net/turn.js'

describe('parseTurnUrl', () => {
  it('подставляет порт 3478 и udp для turn:', () => {
    expect(parseTurnUrl('turn:turn.example.com')).toEqual({
      scheme: 'turn',
      host: 'turn.example.com',
      port: 3478,
      transport: 'udp',
    })
  })

  it('подставляет порт 5349 и tcp для turns:', () => {
    expect(parseTurnUrl('turns:turn.example.com')).toEqual({
      scheme: 'turns',
      host: 'turn.example.com',
      port: 5349,
      transport: 'tcp',
    })
  })

  it('уважает явный порт', () => {
    expect(parseTurnUrl('turn:turn.example.com:3479')).toMatchObject({ port: 3479 })
  })

  it('читает transport из query', () => {
    expect(parseTurnUrl('turn:turn.example.com:3478?transport=tcp')).toMatchObject({
      transport: 'tcp',
    })
  })

  it('понимает IPv6-литерал в скобках', () => {
    expect(parseTurnUrl('turn:[2001:db8::1]:3478')).toMatchObject({
      host: '2001:db8::1',
      port: 3478,
    })
  })

  it('отвергает stun: — это поле именно под TURN', () => {
    expect(parseTurnUrl('stun:stun.example.com')).toBeNull()
  })

  it('отвергает http и прочие схемы', () => {
    expect(parseTurnUrl('https://turn.example.com')).toBeNull()
  })

  it('отвергает строку без схемы', () => {
    expect(parseTurnUrl('turn.example.com:3478')).toBeNull()
  })

  it('отвергает пустой хост', () => {
    expect(parseTurnUrl('turn:')).toBeNull()
  })

  it('отвергает нечисловой и выходящий за диапазон порт', () => {
    expect(parseTurnUrl('turn:turn.example.com:abc')).toBeNull()
    expect(parseTurnUrl('turn:turn.example.com:70000')).toBeNull()
    expect(parseTurnUrl('turn:turn.example.com:0')).toBeNull()
  })

  it('отвергает неизвестный transport', () => {
    expect(parseTurnUrl('turn:turn.example.com?transport=quic')).toBeNull()
  })
})

describe('validateTurnConfig', () => {
  it('принимает полный корректный конфиг', () => {
    expect(
      validateTurnConfig({ url: 'turn:turn.example.com:3478', username: 'u', credential: 'p' }),
    ).toEqual({ ok: true })
  })

  it('собирает все ошибки разом, а не по одной', () => {
    const result = validateTurnConfig({ url: 'nonsense', username: '', credential: '' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.length).toBeGreaterThanOrEqual(3)
  })

  it('требует учётные данные: анонимный TURN практически не встречается', () => {
    const result = validateTurnConfig({ url: 'turn:turn.example.com', username: 'u' })
    expect(result.ok).toBe(false)
  })

  it('не принимает пробелы вместо логина', () => {
    const result = validateTurnConfig({
      url: 'turn:turn.example.com',
      username: '   ',
      credential: 'p',
    })
    expect(result.ok).toBe(false)
  })
})

describe('buildIceServers', () => {
  it('без TURN отдаёт только STUN — это штатный режим, а не ошибка', () => {
    const servers = buildIceServers(null)
    expect(servers).toHaveLength(DEFAULT_STUN_SERVERS.length)
    expect(servers.every((s) => String(s.urls).startsWith('stun:'))).toBe(true)
  })

  it('добавляет TURN с учётными данными, сохраняя STUN', () => {
    const servers = buildIceServers({
      url: 'turn:turn.example.com:3478',
      username: 'u',
      credential: 'p',
    })
    expect(servers).toHaveLength(DEFAULT_STUN_SERVERS.length + 1)

    const turn = servers.at(-1)!
    expect(String(turn.urls)).toContain('turn:turn.example.com:3478')
    expect(turn.username).toBe('u')
    expect(turn.credential).toBe('p')
  })

  it('игнорирует заведомо невалидный TURN вместо того, чтобы сломать весь ICE', () => {
    const servers = buildIceServers({ url: 'nonsense', username: '', credential: '' })
    expect(servers).toHaveLength(DEFAULT_STUN_SERVERS.length)
  })

  it('использует несколько разных STUN — иначе не определить тип NAT', () => {
    expect(new Set(DEFAULT_STUN_SERVERS).size).toBeGreaterThanOrEqual(2)
  })
})
