import { describe, expect, it } from 'vitest'
import {
  CodeFormatError,
  FORMAT_VERSION,
  PUBLIC_KEY_BYTES,
  decodeEnvelope,
  encodeEnvelope,
  fromBase64Url,
  normalizeCode,
  toBase64Url,
} from '../../src/signaling/codec.js'
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

  it('различает роли инициатора и отвечающего', async () => {
    const decoded = await decodeEnvelope(await encodeEnvelope(envelope({ role: 'responder' })))
    expect(decoded.role).toBe('responder')
  })

  it('сжимает реальный SDP до размера, влезающего в QR-код', async () => {
    const code = await encodeEnvelope(envelope())
    // Порог с запасом: QR byte-mode вмещает заметно больше, но за ростом кода
    // надо следить — иначе сканирование с телефона станет мучением.
    expect(code.length).toBeLessThan(1200)
  })

  it('отдаёт код только из безопасного алфавита', async () => {
    const code = await encodeEnvelope(envelope())
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/)
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

  it('терпит код, испачканный пробелами при пересылке', async () => {
    const code = await encodeEnvelope(envelope())
    const dirty = `  ${code.slice(0, 20)}\n${code.slice(20)}  `
    const decoded = await decodeEnvelope(dirty)
    expect(decoded.sdp).toBe(OFFER_SDP)
  })
})
