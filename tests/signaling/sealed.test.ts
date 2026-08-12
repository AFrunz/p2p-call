import { describe, expect, it } from 'vitest'
import { SealError, deriveSignalingKey, open, seal } from '../../src/signaling/sealed.js'
import { fromBase64Url, toBase64Url } from '../../src/signaling/codec.js'
import { generateInvite } from '../../src/signaling/link.js'

const SERVER = 'wss://call.example.com/ws'
const MESSAGE = 'v=0\r\no=- 123 2 IN IP4 127.0.0.1\r\na=ice-ufrag:4ZcD\r\n'

async function keyFor(secret = generateInvite(SERVER).secret): Promise<CryptoKey> {
  return deriveSignalingKey(secret)
}

describe('deriveSignalingKey', () => {
  it('из одного секрета комнаты обе стороны получают один ключ', async () => {
    const { secret } = generateInvite(SERVER)
    const sealed = await seal(await keyFor(secret), MESSAGE)
    expect(await open(await keyFor(secret), sealed)).toBe(MESSAGE)
  })

  it('выдаёт неизвлекаемый AES-256-GCM', async () => {
    const key = await keyFor()
    const algorithm = key.algorithm as AesKeyAlgorithm

    expect(algorithm.name).toBe('AES-GCM')
    expect(algorithm.length).toBe(256)
    expect(key.extractable).toBe(false)
  })
})

describe('seal / open', () => {
  it('переживает round-trip', async () => {
    const key = await keyFor()
    expect(await open(key, await seal(key, MESSAGE))).toBe(MESSAGE)
  })

  it('переживает пустое сообщение и юникод', async () => {
    const key = await keyFor()
    for (const text of ['', 'привет 👋', 'a'.repeat(10_000)]) {
      expect(await open(key, await seal(key, text))).toBe(text)
    }
  })

  it('отдаёт блоб в безопасном алфавите — он поедет внутри JSON', async () => {
    expect(await seal(await keyFor(), MESSAGE)).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('каждый раз использует новый nonce', async () => {
    const key = await keyFor()
    const blobs = new Set<string>()
    for (let i = 0; i < 20; i++) blobs.add(await seal(key, MESSAGE))
    expect(blobs.size).toBe(20)
  })

  it('не читается чужим ключом: сервер не подсмотрит SDP', async () => {
    const sealed = await seal(await keyFor(), MESSAGE)
    await expect(open(await keyFor(), sealed)).rejects.toBeInstanceOf(SealError)
  })

  it('ловит подделку шифртекста', async () => {
    // Сервер видит только блоб, но мог бы попробовать его подкрутить —
    // тег AES-GCM это ловит.
    const key = await keyFor()
    const raw = fromBase64Url(await seal(key, MESSAGE))
    raw.set([raw[20]! ^ 0x01], 20)

    await expect(open(key, toBase64Url(raw))).rejects.toBeInstanceOf(SealError)
  })

  it('ловит подделку nonce', async () => {
    const key = await keyFor()
    const raw = fromBase64Url(await seal(key, MESSAGE))
    raw.set([raw[0]! ^ 0x01], 0)

    await expect(open(key, toBase64Url(raw))).rejects.toBeInstanceOf(SealError)
  })

  it('отвергает слишком короткий блоб, а не читает за границей буфера', async () => {
    const key = await keyFor()
    for (const blob of ['', 'AAAA', toBase64Url(new Uint8Array(27))]) {
      await expect(open(key, blob), blob).rejects.toBeInstanceOf(SealError)
    }
  })

  it('отвергает блоб не из base64url', async () => {
    await expect(open(await keyFor(), 'не base64!!')).rejects.toBeInstanceOf(SealError)
  })
})
