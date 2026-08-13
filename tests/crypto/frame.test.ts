import { describe, expect, it } from 'vitest'
import {
  FrameFormatError,
  NONCE_BYTES,
  TAG_BYTES,
  TRAILER_BYTES,
  buildNonce,
  packFrame,
  splitFrame,
  unencryptedHeaderSize,
  unpackFrame,
} from '../../src/crypto/frame.js'
import type { Codec } from '../../src/crypto/frame.js'
import type { Bytes } from '../../src/bytes.js'

function bytes(length: number, seed = 1): Bytes {
  return new Uint8Array(length).map((_, i) => (seed + i * 13) % 256)
}

describe('unencryptedHeaderSize', () => {
  it('оставляет открытым один байт Opus', () => {
    expect(unencryptedHeaderSize('opus', false)).toBe(1)
    expect(unencryptedHeaderSize('opus', true)).toBe(1)
  })

  it('оставляет больше байт у ключевого кадра видео', () => {
    for (const codec of ['vp8', 'vp9', 'h264', 'av1'] as const) {
      const key = unencryptedHeaderSize(codec, true)
      const delta = unencryptedHeaderSize(codec, false)
      expect(key, codec).toBeGreaterThan(delta)
      expect(delta, codec).toBeGreaterThan(0)
    }
  })

  it('оставляет открытым строго ограниченный кусок: не шифровать полкадра', () => {
    for (const codec of ['opus', 'vp8', 'vp9', 'h264', 'av1'] as const) {
      expect(unencryptedHeaderSize(codec, true), codec).toBeLessThanOrEqual(16)
    }
  })
})

describe('buildNonce', () => {
  it('всегда 12 байт', () => {
    expect(buildNonce(0, 0n).length).toBe(NONCE_BYTES)
    expect(buildNonce(0xffffffff, 0xffffffffffffffn).length).toBe(NONCE_BYTES)
  })

  it('детерминирован: те же входы дают тот же nonce', () => {
    expect(buildNonce(42, 1234n)).toEqual(buildNonce(42, 1234n))
  })

  it('различается для соседних счётчиков — иначе GCM ломается', () => {
    expect(buildNonce(1, 100n)).not.toEqual(buildNonce(1, 101n))
  })

  it('различается для разных потоков при одном счётчике', () => {
    expect(buildNonce(1, 100n)).not.toEqual(buildNonce(2, 100n))
  })

  it('не даёт коллизий на большой выборке счётчиков', () => {
    const seen = new Set<string>()
    for (let i = 0n; i < 2000n; i++) seen.add(buildNonce(7, i).join(','))
    expect(seen.size).toBe(2000)
  })

  it('переживает счётчик, не влезающий в 32 бита', () => {
    const big = buildNonce(1, 2n ** 40n)
    expect(big).not.toEqual(buildNonce(1, 0n))
  })

  it('падает, а не заворачивается по кругу, при переполнении счётчика', () => {
    // Повтор nonce под одним ключом в GCM раскрывает ключ аутентификации:
    // здесь единственный правильный исход — остановиться.
    expect(() => buildNonce(1, 2n ** 64n)).toThrow()
  })

  it('отвергает некорректный идентификатор потока', () => {
    expect(() => buildNonce(-1, 0n)).toThrow()
    expect(() => buildNonce(2 ** 32, 0n)).toThrow()
  })

  it('отвергает отрицательный счётчик', () => {
    expect(() => buildNonce(1, -1n)).toThrow()
  })
})

describe('splitFrame', () => {
  it('режет кадр на открытый заголовок и шифруемое тело', () => {
    const frame = bytes(100)
    const { header, body } = splitFrame(frame, 'vp8', false)

    expect(header.length).toBe(unencryptedHeaderSize('vp8', false))
    expect(header.length + body.length).toBe(frame.length)
    expect([...header]).toEqual([...frame.slice(0, header.length)])
    expect([...body]).toEqual([...frame.slice(header.length)])
  })

  it('допускает кадр ровно в размер заголовка с пустым телом', () => {
    const size = unencryptedHeaderSize('opus', false)
    const { body } = splitFrame(bytes(size), 'opus', false)
    expect(body.length).toBe(0)
  })

  it('отвергает кадр короче обязательного заголовка', () => {
    expect(() => splitFrame(new Uint8Array(2), 'vp8', true)).toThrow(FrameFormatError)
  })

  it('отвергает пустой кадр', () => {
    expect(() => splitFrame(new Uint8Array(0), 'opus', false)).toThrow(FrameFormatError)
  })
})

describe('packFrame / unpackFrame', () => {
  const codec: Codec = 'vp8'
  const isKeyFrame = false

  function roundTrip(keyId: number, counter = 7n) {
    const header = bytes(unencryptedHeaderSize(codec, isKeyFrame), 3)
    const ciphertext = bytes(80, 9)
    const packed = packFrame(header, ciphertext, counter, keyId)
    return { header, ciphertext, packed, unpacked: unpackFrame(packed) }
  }

  it('восстанавливает заголовок, шифртекст, счётчик и id ключа', () => {
    const { header, ciphertext, unpacked } = roundTrip(5, 1234n)
    expect([...unpacked.header]).toEqual([...header])
    expect([...unpacked.ciphertext]).toEqual([...ciphertext])
    expect(unpacked.counter).toBe(1234n)
    expect(unpacked.keyId).toBe(5)
  })

  it('добавляет ровно трейлер поверх полезной нагрузки', () => {
    const { header, ciphertext, packed } = roundTrip(0)
    expect(packed.length).toBe(header.length + ciphertext.length + TRAILER_BYTES)
  })

  it('переносит счётчик, восстанавливая тот же nonce на приёме', () => {
    // Без счётчика в кадре приёмник не соберёт nonce: порядок кадров он не
    // контролирует, а потеря пакета сбила бы счёт навсегда.
    for (const counter of [0n, 1n, 2n ** 32n, 2n ** 64n - 1n]) {
      const { unpacked } = roundTrip(3, counter)
      expect(unpacked.counter, String(counter)).toBe(counter)
      expect(buildNonce(1, unpacked.counter)).toEqual(buildNonce(1, counter))
    }
  })

  it('переносит id ключа во всём диапазоне байта', () => {
    for (const keyId of [0, 1, 127, 254, 255]) {
      expect(roundTrip(keyId).unpacked.keyId).toBe(keyId)
    }
  })

  it('отвергает id ключа вне одного байта', () => {
    const header = bytes(unencryptedHeaderSize(codec, isKeyFrame))
    expect(() => packFrame(header, bytes(10), 0n, 256)).toThrow()
    expect(() => packFrame(header, bytes(10), 0n, -1)).toThrow()
    expect(() => packFrame(header, bytes(10), 0n, 1.5)).toThrow()
  })

  it('отвергает счётчик вне uint64', () => {
    const header = bytes(unencryptedHeaderSize(codec, isKeyFrame))
    expect(() => packFrame(header, bytes(10), -1n, 0)).toThrow()
    expect(() => packFrame(header, bytes(10), 2n ** 64n, 0)).toThrow()
  })

  it('отвергает кадр, в котором не помещается даже тег аутентификации', () => {
    // Данные приходят от собеседника: короткий кадр должен отвергаться,
    // а не приводить к чтению за границей буфера.
    const tooShort = new Uint8Array(unencryptedHeaderSize(codec, isKeyFrame) + TAG_BYTES)
    expect(() => unpackFrame(tooShort)).toThrow(FrameFormatError)
  })

  it('отвергает пустой кадр', () => {
    expect(() => unpackFrame(new Uint8Array(0))).toThrow(FrameFormatError)
  })

  it('переносит длину заголовка, а не вычисляет её на приёме заново', () => {
    // Приёмник не всегда знает кодек и не в каждом браузере видит признак
    // ключевого кадра. Разойдясь с отправителем на байт, он строит другой
    // additionalData, и GCM отвергает вообще всё, не называя причины.
    for (const size of [0, 1, 3, 10, 255]) {
      const packed = packFrame(bytes(size, 3), bytes(40, 9), 1n, 0)
      expect(unpackFrame(packed).header.length, String(size)).toBe(size)
    }
  })

  it('отвергает заголовок, который не помещается в присланный кадр', () => {
    const packed = packFrame(bytes(3, 3), bytes(40, 9), 1n, 0)
    packed[packed.length - 1] = 200

    expect(() => unpackFrame(packed)).toThrow(FrameFormatError)
  })

  it('отвергает заголовок длиннее одного байта: длину некуда записать', () => {
    expect(() => packFrame(bytes(256), bytes(10), 0n, 0)).toThrow(FrameFormatError)
  })
})
