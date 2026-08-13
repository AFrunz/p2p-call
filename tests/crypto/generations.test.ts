import { describe, expect, it } from 'vitest'
import { FrameFormatError } from '../../src/crypto/frame.js'
import { KEY_HISTORY, ReceiverKeys } from '../../src/crypto/generations.js'
import { deriveMediaKeys, nextKeyId, ratchet } from '../../src/crypto/kdf.js'
import type { DirectionKeys } from '../../src/crypto/kdf.js'

async function keys(): Promise<DirectionKeys> {
  const secret = new Uint8Array(32).fill(7) as Uint8Array<ArrayBuffer>
  return (await deriveMediaKeys(secret, 'initiator')).audio.recv
}

/** Ключ поколения n, посчитанный независимо от проверяемого класса. */
async function generation(base: DirectionKeys, n: number): Promise<CryptoKey> {
  let current = base
  for (let step = 0; step < n; step++) current = await ratchet(current)
  return current.key
}

describe('ReceiverKeys', () => {
  it('отдаёт базовое поколение без ротации', async () => {
    const base = await keys()
    expect(await new ReceiverKeys(base).keyFor(0)).toBe(base.key)
  })

  it('догоняет отправителя, ушедшего вперёд', async () => {
    const base = await keys()
    const receiver = new ReceiverKeys(base)

    expect(await receiver.keyFor(2)).toEqual(await generation(base, 2))
  })

  it('повторный кадр того же поколения не крутит храповик дальше', async () => {
    const base = await keys()
    const receiver = new ReceiverKeys(base)

    const first = await receiver.keyFor(1)
    expect(await receiver.keyFor(1)).toBe(first)
  })

  it('держит прежние поколения: кадры в полёте отстают от ротации', async () => {
    const base = await keys()
    const receiver = new ReceiverKeys(base)

    await receiver.keyFor(1)
    expect(await receiver.keyFor(0)).toBe(base.key)
  })

  it('отвергает далёкий номер поколения, не трогая состояние', async () => {
    // Так выглядит кадр, пришедший до того, как собеседник навесил шифрование:
    // в байте поколения лежит случайный мусор.
    const base = await keys()
    const receiver = new ReceiverKeys(base)

    await expect(receiver.keyFor(32)).rejects.toThrow(FrameFormatError)
    expect(receiver.known).toEqual([0])
    expect(await receiver.keyFor(0)).toBe(base.key)
  })

  it('переживает поток мусорных номеров и продолжает расшифровывать', async () => {
    // Главная поломка: раньше каждый мусорный кадр уводил цепочку вперёд, а
    // вычистка старых поколений уносила рабочий ключ. Приём умирал навсегда.
    const base = await keys()
    const receiver = new ReceiverKeys(base)

    for (const garbage of [32, 200, 99, 255, 128]) {
      await expect(receiver.keyFor(garbage)).rejects.toThrow(FrameFormatError)
    }

    expect(await receiver.keyFor(0)).toBe(base.key)
    expect(await receiver.keyFor(1)).toEqual(await generation(base, 1))
  })

  it('не выдаёт промах по ключу за открытый текст', async () => {
    // Иначе шифрование снимается напрасно: у собеседника оно включено, просто
    // номер поколения не подошёл.
    const receiver = new ReceiverKeys(await keys())

    await receiver.keyFor(32).catch((error: unknown) => {
      expect(error).toBeInstanceOf(FrameFormatError)
      expect((error as FrameFormatError).plaintext).toBe(false)
    })
    expect.assertions(2)
  })

  it('не хранит больше поколений, чем нужно кадрам в полёте', async () => {
    const receiver = new ReceiverKeys(await keys())

    for (let id = 1; id <= 12; id++) await receiver.keyFor(id)

    expect(receiver.known.length).toBeLessThanOrEqual(KEY_HISTORY)
  })

  it('догоняет ротацию через заворот идентификатора', async () => {
    const base = await keys()
    const receiver = new ReceiverKeys(base)

    let id = 0
    for (let step = 0; step < 255; step++) {
      id = nextKeyId(id)
      await receiver.keyFor(id)
    }

    expect(id).toBe(255)
    expect(await receiver.keyFor(0)).toEqual(await generation(base, 256))
  })
})
