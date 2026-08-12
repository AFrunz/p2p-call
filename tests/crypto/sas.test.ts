import { describe, expect, it } from 'vitest'
import { SAS_WORD_COUNT, bytesToWords, compareBytes, deriveSas } from '../../src/crypto/sas.js'
import { SAS_WORDS } from '../../src/crypto/wordlist.js'

const SECRET = new Uint8Array(32).fill(7)
const FP_A = new Uint8Array(32).map((_, i) => i)
const FP_B = new Uint8Array(32).map((_, i) => 255 - i)

describe('словарь SAS', () => {
  it('содержит ровно 256 слов — по слову на байт', () => {
    expect(SAS_WORDS).toHaveLength(256)
  })

  it('не содержит повторов: иначе фраза читается неоднозначно', () => {
    expect(new Set(SAS_WORDS).size).toBe(256)
  })

  it('состоит из коротких слов, пригодных для чтения вслух', () => {
    for (const word of SAS_WORDS) {
      expect(word.length, word).toBeGreaterThanOrEqual(3)
      expect(word.length, word).toBeLessThanOrEqual(8)
      expect(word, word).toMatch(/^[а-яё]+$/)
    }
  })
})

describe('compareBytes', () => {
  it('упорядочивает по первому различающемуся байту', () => {
    expect(compareBytes(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBeLessThan(0)
    expect(compareBytes(new Uint8Array([2, 0]), new Uint8Array([1, 9]))).toBeGreaterThan(0)
  })

  it('считает одинаковые массивы равными', () => {
    expect(compareBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(0)
  })

  it('считает более короткий префикс меньшим', () => {
    expect(compareBytes(new Uint8Array([1]), new Uint8Array([1, 0]))).toBeLessThan(0)
  })
})

describe('bytesToWords', () => {
  it('отображает байт в слово по его номеру', () => {
    expect(bytesToWords(new Uint8Array([0, 1, 255]), 3)).toEqual([
      SAS_WORDS[0],
      SAS_WORDS[1],
      SAS_WORDS[255],
    ])
  })

  it('берёт ровно запрошенное число слов', () => {
    expect(bytesToWords(new Uint8Array(32).fill(3), 5)).toHaveLength(5)
  })

  it('отвергает запрос длиннее доступных байт, а не добивает мусором', () => {
    expect(() => bytesToWords(new Uint8Array([1, 2]), 5)).toThrow()
  })
})

describe('deriveSas', () => {
  it('выдаёт условленное число слов из словаря', async () => {
    const sas = await deriveSas(SECRET, FP_A, FP_B)
    expect(sas).toHaveLength(SAS_WORD_COUNT)
    for (const word of sas) expect(SAS_WORDS).toContain(word)
  })

  it('детерминирован', async () => {
    expect(await deriveSas(SECRET, FP_A, FP_B)).toEqual(await deriveSas(SECRET, FP_A, FP_B))
  })

  it('не зависит от того, чей отпечаток передали первым', async () => {
    // Иначе инициатор и отвечающий увидят разные фразы и решат, что их слушают.
    expect(await deriveSas(SECRET, FP_A, FP_B)).toEqual(await deriveSas(SECRET, FP_B, FP_A))
  })

  it('меняется вместе с секретом — иначе MITM не заметить', async () => {
    const original = await deriveSas(SECRET, FP_A, FP_B)
    const other = await deriveSas(new Uint8Array(32).fill(8), FP_A, FP_B)
    expect(other).not.toEqual(original)
  })

  it('меняется при подмене отпечатка', async () => {
    const tampered = FP_B.slice()
    tampered.set([FP_B[0]! ^ 0x01], 0)
    expect(await deriveSas(SECRET, FP_A, tampered)).not.toEqual(await deriveSas(SECRET, FP_A, FP_B))
  })

  it('даёт достаточную энтропию, чтобы подбор был бессмысленным', () => {
    // 256 слов = 8 бит на слово; 5 слов = 40 бит.
    expect(SAS_WORD_COUNT * 8).toBeGreaterThanOrEqual(32)
  })

  it('размазывает фразы по словарю, а не жмётся к его началу', async () => {
    const used = new Set<string>()
    for (let i = 0; i < 40; i++) {
      const secret = new Uint8Array(32).fill(i)
      for (const word of await deriveSas(secret, FP_A, FP_B)) used.add(word)
    }
    expect(used.size).toBeGreaterThan(80)
  })
})
