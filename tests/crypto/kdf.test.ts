import { describe, expect, it } from 'vitest'
import {
  PBKDF2_ITERATIONS,
  deriveMediaKeys,
  deriveSharedSecret,
  exportPublicKey,
  generateKeyPair,
  keyCheck,
  importPublicKey,
  keyLabel,
  mixPassphrase,
  mixRoomSecret,
  nextKeyId,
  ratchet,
} from '../../src/crypto/kdf.js'
import type { Bytes } from '../../src/bytes.js'
import type { DirectionKeys, MediaKeys } from '../../src/crypto/kdf.js'

const PLAINTEXT = new TextEncoder().encode('кадр')
const NONCE = new Uint8Array(12).fill(1)

async function encrypt(key: CryptoKey): Promise<ArrayBuffer> {
  return crypto.subtle.encrypt({ name: 'AES-GCM', iv: NONCE }, key, PLAINTEXT)
}

async function decrypt(key: CryptoKey, data: ArrayBuffer): Promise<ArrayBuffer> {
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: NONCE }, key, data)
}

/** Проверяет, что поколением ключей одной стороны читается поток другой. */
async function interoperates(a: DirectionKeys, b: DirectionKeys): Promise<boolean> {
  try {
    const plain = await decrypt(b.key, await encrypt(a.key))
    return new TextDecoder().decode(plain) === 'кадр'
  } catch {
    return false
  }
}

/** Полный обмен ключами между двумя сторонами, как в реальном звонке. */
async function handshake(passphrase: string | null = null): Promise<{
  initiator: MediaKeys
  responder: MediaKeys
  secret: Bytes
}> {
  const alice = await generateKeyPair()
  const bob = await generateKeyPair()

  const aliceRaw = await exportPublicKey(alice.publicKey)
  const bobRaw = await exportPublicKey(bob.publicKey)

  const salt = new Uint8Array(16).fill(9)
  const aliceSecret = await mixPassphrase(
    await deriveSharedSecret(alice.privateKey, await importPublicKey(bobRaw)),
    passphrase,
    salt,
  )
  const bobSecret = await mixPassphrase(
    await deriveSharedSecret(bob.privateKey, await importPublicKey(aliceRaw)),
    passphrase,
    salt,
  )

  return {
    initiator: await deriveMediaKeys(aliceSecret, 'initiator'),
    responder: await deriveMediaKeys(bobSecret, 'responder'),
    secret: aliceSecret,
  }
}

describe('ключевая пара', () => {
  it('экспортируется в 65 байт формата raw', async () => {
    const pair = await generateKeyPair()
    const raw = await exportPublicKey(pair.publicKey)
    expect(raw.length).toBe(65)
    expect(raw[0]).toBe(0x04)
  })

  it('переживает экспорт и импорт', async () => {
    const pair = await generateKeyPair()
    const raw = await exportPublicKey(pair.publicKey)
    expect(await exportPublicKey(await importPublicKey(raw))).toEqual(raw)
  })

  it('каждый звонок получает свежую эфемерную пару', async () => {
    const first = await exportPublicKey((await generateKeyPair()).publicKey)
    const second = await exportPublicKey((await generateKeyPair()).publicKey)
    expect(first).not.toEqual(second)
  })

  it('отвергает мусор вместо публичного ключа', async () => {
    await expect(importPublicKey(new Uint8Array(65))).rejects.toThrow()
    await expect(importPublicKey(new Uint8Array(10))).rejects.toThrow()
  })
})

describe('deriveSharedSecret', () => {
  it('обе стороны приходят к одному секрету', async () => {
    const alice = await generateKeyPair()
    const bob = await generateKeyPair()

    const fromAlice = await deriveSharedSecret(alice.privateKey, bob.publicKey)
    const fromBob = await deriveSharedSecret(bob.privateKey, alice.publicKey)

    expect(fromAlice).toEqual(fromBob)
    expect(fromAlice.length).toBeGreaterThanOrEqual(32)
  })

  it('с третьей стороной секрет другой', async () => {
    const alice = await generateKeyPair()
    const bob = await generateKeyPair()
    const eve = await generateKeyPair()

    const withBob = await deriveSharedSecret(alice.privateKey, bob.publicKey)
    const withEve = await deriveSharedSecret(alice.privateKey, eve.publicKey)

    expect(withBob).not.toEqual(withEve)
  })
})

describe('mixPassphrase', () => {
  const secret = new Uint8Array(32).fill(4)
  const salt = new Uint8Array(16).fill(9)

  it('без фразы оставляет секрет нетронутым', async () => {
    expect(await mixPassphrase(secret, null, salt)).toEqual(secret)
    expect(await mixPassphrase(secret, '', salt)).toEqual(secret)
  })

  it('с фразой меняет секрет', async () => {
    expect(await mixPassphrase(secret, 'общая тайна', salt)).not.toEqual(secret)
  })

  it('детерминирован при тех же входах', async () => {
    const first = await mixPassphrase(secret, 'общая тайна', salt)
    const second = await mixPassphrase(secret, 'общая тайна', salt)
    expect(first).toEqual(second)
  })

  it('разные фразы дают разные секреты', async () => {
    const first = await mixPassphrase(secret, 'фраза один', salt)
    const second = await mixPassphrase(secret, 'фраза два', salt)
    expect(first).not.toEqual(second)
  })

  it('перебор фразы стоит дорого', async () => {
    // Фраза, скорее всего, будет человеческой и слабой — без большого числа
    // итераций она не защищает ни от чего.
    expect(PBKDF2_ITERATIONS).toBeGreaterThanOrEqual(100_000)
  })
})

describe('keyLabel', () => {
  it('send одной стороны совпадает с recv другой', () => {
    expect(keyLabel('audio', 'send', 'initiator')).toBe(keyLabel('audio', 'recv', 'responder'))
    expect(keyLabel('video', 'send', 'responder')).toBe(keyLabel('video', 'recv', 'initiator'))
  })

  it('все четыре метки различны', () => {
    const labels = new Set([
      keyLabel('audio', 'send', 'initiator'),
      keyLabel('audio', 'recv', 'initiator'),
      keyLabel('video', 'send', 'initiator'),
      keyLabel('video', 'recv', 'initiator'),
    ])
    expect(labels.size).toBe(4)
  })

  it('привязана к версии протокола', () => {
    expect(keyLabel('audio', 'send', 'initiator')).toMatch(/v1/)
  })
})

describe('deriveMediaKeys', () => {
  it('связывает передачу инициатора с приёмом отвечающего', async () => {
    const { initiator, responder } = await handshake()
    expect(await interoperates(initiator.audio.send, responder.audio.recv)).toBe(true)
    expect(await interoperates(initiator.video.send, responder.video.recv)).toBe(true)
  })

  it('связывает передачу отвечающего с приёмом инициатора', async () => {
    const { initiator, responder } = await handshake()
    expect(await interoperates(responder.audio.send, initiator.audio.recv)).toBe(true)
    expect(await interoperates(responder.video.send, initiator.video.recv)).toBe(true)
  })

  it('держит аудио и видео на независимых ключах', async () => {
    const { initiator, responder } = await handshake()
    expect(await interoperates(initiator.audio.send, responder.video.recv)).toBe(false)
  })

  it('не даёт расшифровать собственный исходящий поток ключом приёма', async () => {
    const { initiator } = await handshake()
    expect(await interoperates(initiator.audio.send, initiator.audio.recv)).toBe(false)
  })

  it('с общей парольной фразой связь по-прежнему работает', async () => {
    const { initiator, responder } = await handshake('общая тайна')
    expect(await interoperates(initiator.audio.send, responder.audio.recv)).toBe(true)
  })

  it('расходится вместе с секретом: чужая фраза не подойдёт', async () => {
    // Именно это защищает звонок, если канал обмена кодами скомпрометирован:
    // подменивший ключи получит другой секрет и другие медиаключи.
    const { initiator, secret } = await handshake('общая тайна')

    const sameSecret = await deriveMediaKeys(secret, 'responder')
    expect(await interoperates(initiator.audio.send, sameSecret.audio.recv)).toBe(true)

    const foreign = new Uint8Array(new ArrayBuffer(secret.length)).fill(1)
    const otherSecret = await deriveMediaKeys(foreign, 'responder')
    expect(await interoperates(initiator.audio.send, otherSecret.audio.recv)).toBe(false)
  })

  it('выдаёт ключи AES-GCM на 256 бит', async () => {
    const { initiator } = await handshake()
    const algorithm = initiator.audio.send.key.algorithm as AesKeyAlgorithm
    expect(algorithm.name).toBe('AES-GCM')
    expect(algorithm.length).toBe(256)
  })

  it('не позволяет выгрузить ключ из памяти', async () => {
    const { initiator } = await handshake()
    expect(initiator.audio.send.key.extractable).toBe(false)
    expect(initiator.audio.send.chain.extractable).toBe(false)
  })
})

describe('ratchet', () => {
  it('обе стороны, провернув ratchet, остаются совместимы', async () => {
    const { initiator, responder } = await handshake()
    const nextSend = await ratchet(initiator.audio.send)
    const nextRecv = await ratchet(responder.audio.recv)
    expect(await interoperates(nextSend, nextRecv)).toBe(true)
  })

  it('новый ключ не совпадает со старым', async () => {
    const { initiator, responder } = await handshake()
    const nextSend = await ratchet(initiator.audio.send)
    expect(await interoperates(nextSend, responder.audio.recv)).toBe(false)
  })

  it('не откатывается назад: старый ключ не расшифрует новый кадр', async () => {
    const { initiator, responder } = await handshake()
    const twice = await ratchet(await ratchet(initiator.audio.send))
    const once = await ratchet(responder.audio.recv)
    expect(await interoperates(twice, once)).toBe(false)
  })
})

describe('nextKeyId', () => {
  it('увеличивает id на единицу', () => {
    expect(nextKeyId(0)).toBe(1)
    expect(nextKeyId(41)).toBe(42)
  })

  it('заворачивается, оставаясь в одном байте', () => {
    expect(nextKeyId(255)).toBe(0)
  })

  it('отвергает id вне диапазона байта', () => {
    expect(() => nextKeyId(256)).toThrow()
    expect(() => nextKeyId(-1)).toThrow()
  })
})

describe('mixRoomSecret', () => {
  const secret = new Uint8Array(32).fill(4)
  const room = new Uint8Array(32).fill(5)

  it('без секрета комнаты оставляет всё как есть', async () => {
    expect(await mixRoomSecret(secret, null)).toEqual(secret)
  })

  it('с секретом комнаты меняет результат', async () => {
    expect(await mixRoomSecret(secret, room)).not.toEqual(secret)
  })

  it('детерминирован — иначе стороны не сойдутся', async () => {
    expect(await mixRoomSecret(secret, room)).toEqual(await mixRoomSecret(secret, room))
  })

  it('разные комнаты дают разные секреты', async () => {
    const other = new Uint8Array(32).fill(6)
    expect(await mixRoomSecret(secret, room)).not.toEqual(await mixRoomSecret(secret, other))
  })

  it('привязывает ключи к ссылке: без её секрета сервер их не выведет', async () => {
    // Сигнальный сервер видит только запечатанные блобы и идентификатор
    // комнаты, поэтому этот вход ему недоступен даже при подмене SDP.
    const mixed = await mixRoomSecret(secret, room)
    const withKeys = await deriveMediaKeys(mixed, 'initiator')
    const serverGuess = await deriveMediaKeys(secret, 'responder')

    expect(await interoperates(withKeys.audio.send, serverGuess.audio.recv)).toBe(false)
  })

  it('контрольная сумма сходится у send одной стороны и recv другой', async () => {
    const secret = new Uint8Array(32).fill(11) as Uint8Array<ArrayBuffer>
    const initiator = await deriveMediaKeys(secret, 'initiator')
    const responder = await deriveMediaKeys(secret, 'responder')

    expect(await keyCheck(initiator.audio.send)).toBe(await keyCheck(responder.audio.recv))
    expect(await keyCheck(initiator.video.recv)).toBe(await keyCheck(responder.video.send))
  })

  it('контрольная сумма расходится, когда роли совпали по ошибке', async () => {
    // Ровно этот случай и надо ловить: обе стороны считают себя инициатором,
    // сверочная фраза при этом сходится, а медиаключи — нет.
    const secret = new Uint8Array(32).fill(11) as Uint8Array<ArrayBuffer>
    const one = await deriveMediaKeys(secret, 'initiator')
    const two = await deriveMediaKeys(secret, 'initiator')

    expect(await keyCheck(one.audio.send)).not.toBe(await keyCheck(two.audio.recv))
  })

  it('по контрольной сумме не восстановить ключ направления', async () => {
    const secret = new Uint8Array(32).fill(11) as Uint8Array<ArrayBuffer>
    const keys = (await deriveMediaKeys(secret, 'initiator')).audio.send

    const check = await keyCheck(keys)
    expect(check).toMatch(/^[0-9a-f]{8}$/)
    expect(check).not.toBe(await keyCheck(await ratchet(keys)))
  })
})
