import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildIceServers, mintTurnCredentials } from '../../server/src/turn.js'
import { loadConfig } from '../../server/src/config.js'
import type { Config } from '../../server/src/config.js'

const SECRET = 'a'.repeat(64)
const NOW = 1_700_000_000_000

function config(patch: Partial<Config> = {}): Config {
  return {
    ...loadConfig({}),
    ...patch,
  }
}

describe('mintTurnCredentials', () => {
  it('кладёт срок годности в имя пользователя', () => {
    const { username } = mintTurnCredentials(SECRET, 3600, NOW)
    const [expiry] = username.split(':')

    expect(Number(expiry)).toBe(Math.floor(NOW / 1000) + 3600)
  })

  it('считает пароль так же, как coturn в режиме use-auth-secret', () => {
    const { username, credential } = mintTurnCredentials(SECRET, 3600, NOW)
    const expected = createHmac('sha1', SECRET).update(username).digest('base64')

    expect(credential).toBe(expected)
  })

  it('каждый раз выдаёт новую пару', () => {
    const first = mintTurnCredentials(SECRET, 3600, NOW)
    const second = mintTurnCredentials(SECRET, 3600, NOW)

    expect(first.username).not.toBe(second.username)
    expect(first.credential).not.toBe(second.credential)
  })

  it('не раскрывает секрет ни в имени, ни в пароле', () => {
    const { username, credential } = mintTurnCredentials(SECRET, 3600, NOW)
    expect(username).not.toContain(SECRET)
    expect(credential).not.toContain(SECRET)
  })
})

describe('buildIceServers', () => {
  it('без TURN отдаёт только STUN', () => {
    const servers = buildIceServers(config({ turnHost: null, turnSecret: null }), NOW)

    expect(servers).toHaveLength(1)
    expect(servers[0]!.urls.every((url) => url.startsWith('stun:'))).toBe(true)
    expect(servers[0]!.username).toBeUndefined()
  })

  it('добавляет TURN по UDP и TCP', () => {
    const servers = buildIceServers(
      config({ turnHost: 'turn.example.com', turnSecret: SECRET, turnPort: 3478 }),
      NOW,
    )

    const turn = servers.at(-1)!
    expect(turn.urls).toContain('turn:turn.example.com:3478?transport=udp')
    // TCP нужен там, где UDP зарезан целиком.
    expect(turn.urls).toContain('turn:turn.example.com:3478?transport=tcp')
  })

  it('добавляет turns: только когда TLS включён явно', () => {
    const withoutTls = buildIceServers(
      config({ turnHost: 'turn.example.com', turnSecret: SECRET, turnTls: false }),
      NOW,
    )
    expect(withoutTls.at(-1)!.urls.some((url) => url.startsWith('turns:'))).toBe(false)

    const withTls = buildIceServers(
      config({ turnHost: 'turn.example.com', turnSecret: SECRET, turnTls: true, turnTlsPort: 5349 }),
      NOW,
    )
    expect(withTls.at(-1)!.urls).toContain('turns:turn.example.com:5349?transport=tcp')
  })

  it('никогда не отдаёт клиенту общий секрет coturn', () => {
    const servers = buildIceServers(
      config({ turnHost: 'turn.example.com', turnSecret: SECRET }),
      NOW,
    )
    expect(JSON.stringify(servers)).not.toContain(SECRET)
  })

  it('сохраняет STUN даже когда TURN настроен', () => {
    const servers = buildIceServers(
      config({ turnHost: 'turn.example.com', turnSecret: SECRET }),
      NOW,
    )
    // Прямое соединение всё ещё предпочтительнее ретранслятора.
    expect(servers[0]!.urls[0]).toMatch(/^stun:/)
  })
})

describe('loadConfig', () => {
  it('работает без переменных окружения — это режим «только сигналинг»', () => {
    const parsed = loadConfig({})
    expect(parsed.turnHost).toBeNull()
    expect(parsed.port).toBe(8080)
  })

  it('падает, если TURN_HOST задан без секрета', () => {
    expect(() => loadConfig({ TURN_HOST: 'turn.example.com' })).toThrow(/TURN_SECRET/)
  })

  it('падает на слишком коротком секрете', () => {
    expect(() => loadConfig({ TURN_HOST: 'turn.example.com', TURN_SECRET: 'коротко' })).toThrow()
  })

  it('падает на TURN_TLS без TURN_HOST', () => {
    expect(() => loadConfig({ TURN_TLS: 'true' })).toThrow()
  })

  it('падает на нечисловом порте, а не стартует на случайном', () => {
    expect(() => loadConfig({ PORT: 'восемь тысяч' })).toThrow()
    expect(() => loadConfig({ PORT: '70000' })).toThrow()
  })

  it('падает на STUN-адресе с посторонней схемой', () => {
    expect(() => loadConfig({ STUN_SERVERS: 'http://evil.example.com' })).toThrow()
  })

  it('читает список STUN через запятую', () => {
    const parsed = loadConfig({ STUN_SERVERS: 'stun:a.example.com:3478, stun:b.example.com:3478' })
    expect(parsed.stunServers).toEqual(['stun:a.example.com:3478', 'stun:b.example.com:3478'])
  })
})
