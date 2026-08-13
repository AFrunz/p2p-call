import { describe, expect, it } from 'vitest'
import {
  CodeFormatError,
  FORMAT_VERSION,
  PUBLIC_KEY_BYTES,
  decodeEnvelope,
  encodeEnvelope,
  fromBase32,
  fromBase64Url,
  normalizeCode,
  toBase32,
  toBase64Url,
} from '../../src/signaling/codec.js'
import { MAX_HOLD_SECONDS, MIN_HOLD_SECONDS } from '../../src/signaling/codec.js'
import type { Bytes } from '../../src/bytes.js'
import type { Envelope } from '../../src/signaling/types.js'
import { OFFER_SDP } from '../fixtures/sdp.js'

function publicKey(seed = 7): Bytes {
  const key = new Uint8Array(PUBLIC_KEY_BYTES)
  key[0] = 0x04
  for (let i = 1; i < key.length; i++) key[i] = (seed + i * 31) % 256
  return key
}

function envelope(patch: Partial<Envelope> = {}): Envelope {
  return {
    version: FORMAT_VERSION,
    role: 'initiator',
    publicKey: publicKey(),
    frameEncryption: true,
    startAt: 0,
    holdSeconds: 60,
    sdp: OFFER_SDP,
    ...patch,
  }
}

describe('base64url', () => {
  it('не использует символы, ломающиеся при вставке в URL и мессенджеры', async () => {
    const encoded = toBase64Url(new Uint8Array([0xfb, 0xff, 0xbf, 0x3e, 0x3f]))
    expect(encoded).not.toMatch(/[+/=]/)
  })

  it('переживает round-trip на всех остатках по модулю 3', () => {
    for (const length of [0, 1, 2, 3, 4, 5, 64, 65, 255]) {
      const bytes = new Uint8Array(length).map((_, i) => (i * 17) % 256)
      expect(fromBase64Url(toBase64Url(bytes)), `длина ${length}`).toEqual(bytes)
    }
  })
})

describe('base32', () => {
  it('переживает round-trip на всех остатках по модулю 5', () => {
    for (const length of [0, 1, 2, 3, 4, 5, 6, 7, 8, 64, 65, 255]) {
      const bytes = new Uint8Array(length).map((_, i) => (i * 29) % 256)
      expect(fromBase32(toBase32(bytes)), `длина ${length}`).toEqual(bytes)
    }
  })

  it('не использует символов, которые где-то что-то значат', () => {
    // Код рассылают любым каналом. base64url отпадает из-за `_`: разметка
    // съедает `__текст__` как форматирование, и код приходит покалеченным.
    const encoded = toBase32(new Uint8Array(64).map((_, i) => i * 3))
    expect(encoded).toMatch(/^[A-Z2-7]+$/)
  })

  it('не обращает внимания на регистр', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    expect(fromBase32(toBase32(bytes).toLowerCase())).toEqual(bytes)
  })

  it('отвергает посторонние символы', () => {
    expect(() => fromBase32('AAAA_AAA')).toThrow(CodeFormatError)
    expect(() => fromBase32('AAAA1AAA')).toThrow(CodeFormatError)
  })
})

describe('normalizeCode', () => {
  it('переживает переносы строк и пробелы от копипаста через мессенджер', () => {
    const clean = 'AbCd0123_-xyz'
    expect(normalizeCode(' AbCd0123\n_-xy z\t')).toBe(clean)
  })

  it('вытаскивает код из ссылки с хешем', () => {
    expect(normalizeCode('https://user.github.io/p2p-call/#AbCd0123_-xyz')).toBe('AbCd0123_-xyz')
  })

  it('не выдумывает код из пустой строки', () => {
    expect(normalizeCode('   \n  ')).toBe('')
  })
})

describe('encodeEnvelope / decodeEnvelope', () => {
  it('восстанавливает конверт без потерь', async () => {
    const original = envelope()
    const decoded = await decodeEnvelope(await encodeEnvelope(original))

    expect(decoded.version).toBe(original.version)
    expect(decoded.role).toBe(original.role)
    expect(decoded.publicKey).toEqual(original.publicKey)
    expect(decoded.sdp).toBe(original.sdp)
  })

  it('переносит возможность шифровать кадры', async () => {
    // Согласовывать обязательно: если слой включит только одна сторона, вторая
    // отдаст шифртекст прямо в декодер — звук станет шумом, видео пропадёт.
    for (const frameEncryption of [true, false]) {
      const decoded = await decodeEnvelope(await encodeEnvelope(envelope({ frameEncryption })))
      expect(decoded.frameEncryption, String(frameEncryption)).toBe(frameEncryption)
    }
  })

  it('переносит момент общего старта без потери точности', async () => {
    // Обе стороны обязаны начать проверку одновременно, поэтому момент едет в
    // коде, а не считается у каждого свой.
    for (const startAt of [0, 1_700_000_000_000, Date.now() + 60_000]) {
      const decoded = await decodeEnvelope(await encodeEnvelope(envelope({ startAt })))
      expect(decoded.startAt, String(startAt)).toBe(startAt)
    }
  })

  it('различает роли инициатора и отвечающего', async () => {
    const decoded = await decodeEnvelope(await encodeEnvelope(envelope({ role: 'responder' })))
    expect(decoded.role).toBe('responder')
  })

  it('сжимает реальный SDP до размера, пригодного для пересылки', async () => {
    const code = await encodeEnvelope(envelope())
    // Порог с запасом: base32 длиннее base64 примерно на четверть, но зато
    // переживает пересылку через что угодно. За ростом всё равно следим —
    // иначе код не пролезет через мессенджер одним сообщением.
    expect(code.length).toBeLessThan(1500)
  })

  it('отдаёт код только из безопасного алфавита', async () => {
    const code = await encodeEnvelope(envelope())
    expect(code).toMatch(/^[A-Z2-7]+$/)
  })

  it('отвергает публичный ключ неверной длины', async () => {
    await expect(encodeEnvelope(envelope({ publicKey: new Uint8Array(64) }))).rejects.toThrow()
  })

  it('отвергает мусор вместо кода', async () => {
    await expect(decodeEnvelope('привет как дела')).rejects.toBeInstanceOf(CodeFormatError)
  })

  it('отвергает пустой код', async () => {
    await expect(decodeEnvelope('')).rejects.toBeInstanceOf(CodeFormatError)
  })

  it('отвергает обрезанный код, а не молча отдаёт огрызок', async () => {
    const code = await encodeEnvelope(envelope())
    await expect(decodeEnvelope(code.slice(0, Math.floor(code.length / 2)))).rejects.toBeInstanceOf(
      CodeFormatError,
    )
  })

  it('сообщает про несовместимую версию отдельным видом ошибки', async () => {
    const code = await encodeEnvelope(envelope({ version: FORMAT_VERSION + 1 }))
    await expect(decodeEnvelope(code)).rejects.toMatchObject({ kind: 'version' })
  })

  it('переживает большой SDP с IPv6 и десятком кандидатов', async () => {
    // Реальный offer от браузера в корпоративной сети: две медиасекции,
    // host- и srflx-кандидаты на четырёх интерфейсах, длинные адреса IPv6.
    const candidates = [
      'a=candidate:0 1 UDP 2122252543 172.25.63.36 62550 typ host',
      'a=candidate:1 1 UDP 2122187007 2a02:6bf:8007:201:a934:7647:172d:9a5a 62918 typ host',
      'a=candidate:2 1 UDP 2122121471 10.215.154.145 60935 typ host',
      'a=candidate:3 1 UDP 2122055935 2a02:6bf:8080:b83::1:10 63999 typ host',
      'a=candidate:4 1 TCP 2105524479 172.25.63.36 9 typ host tcptype active',
      'a=candidate:5 1 TCP 2105458943 2a02:6bf:8007:201:a934:7647:172d:9a5a 9 typ host tcptype active',
      'a=candidate:6 1 TCP 2105393407 10.215.154.145 9 typ host tcptype active',
      'a=candidate:7 1 TCP 2105327871 2a02:6bf:8080:b83::1:10 9 typ host tcptype active',
      'a=candidate:8 1 UDP 1686052863 93.158.191.252 53699 typ srflx raddr 172.25.63.36 rport 62550',
    ]
    const big = OFFER_SDP.replace(/a=candidate:[^\n]*\n/g, '') + candidates.join('\r\n') + '\r\n'

    const decoded = await decodeEnvelope(await encodeEnvelope(envelope({ sdp: big })))
    expect(decoded.sdp).toBe(big)
  })

  it('переживает SDP в десятки килобайт', async () => {
    // Firefox с полным набором кодеков и расширений выдаёт SDP на несколько
    // килобайт; кодирование не должно спотыкаться о размер.
    const bulky = Array.from(
      { length: 400 },
      (_, index) => `a=candidate:${index} 1 UDP ${2122252543 - index} 2a02:6bf:8007:201:a934:7647:172d:${index} ${40000 + index} typ host`,
    ).join('\r\n')
    const sdp = `${OFFER_SDP}${bulky}\r\n`

    const code = await encodeEnvelope(envelope({ sdp }))
    const decoded = await decodeEnvelope(code)

    expect(sdp.length).toBeGreaterThan(30_000)
    expect(decoded.sdp).toBe(sdp)
  })

  it('терпит код, испачканный пробелами при пересылке', async () => {
    const code = await encodeEnvelope(envelope())
    const dirty = `  ${code.slice(0, 20)}\n${code.slice(20)}  `
    const decoded = await decodeEnvelope(dirty)
    expect(decoded.sdp).toBe(OFFER_SDP)
  })

  it('переносит окно на перенос кода: его задаёт создатель сессии', async () => {
    const code = await encodeEnvelope(envelope({ holdSeconds: 300 }))
    expect((await decodeEnvelope(code)).holdSeconds).toBe(300)
  })

  it('загоняет окно в разумные рамки — число приходит от собеседника', async () => {
    // Ноль начал бы проверку раньше, чем код доедет, а сутки оставили бы
    // человека смотреть на «ожидание» без конца.
    for (const [given, expected] of [
      [0, MIN_HOLD_SECONDS],
      [5, MIN_HOLD_SECONDS],
      [100_000, MAX_HOLD_SECONDS],
    ] as const) {
      const code = await encodeEnvelope(envelope({ holdSeconds: given }))
      expect((await decodeEnvelope(code)).holdSeconds, String(given)).toBe(expected)
    }
  })
})
