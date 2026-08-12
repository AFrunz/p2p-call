import type { Bytes } from '../bytes.js'
import { SAS_WORDS } from './wordlist.js'

/** Сколько слов показываем: 5 слов по 8 бит = 40 бит на подбор. */
export const SAS_WORD_COUNT = 5

const encoder = new TextEncoder()

/** Побайтовое сравнение — нужно, чтобы обе стороны отсортировали отпечатки одинаково. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const shared = Math.min(a.length, b.length)
  for (let i = 0; i < shared; i++) {
    const diff = a[i]! - b[i]!
    if (diff !== 0) return diff
  }
  return a.length - b.length
}

/** Каждый байт превращается в слово словаря. */
export function bytesToWords(bytes: Uint8Array, count: number): string[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError(`число слов должно быть неотрицательным целым, получено ${count}`)
  }
  if (bytes.length < count) {
    // Добивать фразу выдуманными словами нельзя: пользователь решит, что сверил
    // больше энтропии, чем есть на самом деле.
    throw new RangeError(`для ${count} слов нужно ${count} байт, получено ${bytes.length}`)
  }

  const words: string[] = []
  for (let i = 0; i < count; i++) words.push(SAS_WORDS[bytes[i]!]!)
  return words
}

/**
 * Выводит контрольную фразу из общего секрета и обоих DTLS-отпечатков.
 *
 * Отпечатки сортируются в канонический порядок, чтобы инициатор и отвечающий
 * получили одну и ту же фразу, не договариваясь, кто из них первый.
 */
export async function deriveSas(
  sharedSecret: Bytes,
  fingerprintA: Uint8Array,
  fingerprintB: Uint8Array,
): Promise<string[]> {
  const [first, second] =
    compareBytes(fingerprintA, fingerprintB) <= 0
      ? [fingerprintA, fingerprintB]
      : [fingerprintB, fingerprintA]

  const salt = new Uint8Array(first.length + second.length)
  salt.set(first, 0)
  salt.set(second, first.length)

  const base = await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode('p2p-call/v1/sas') },
    base,
    SAS_WORD_COUNT * 8,
  )

  return bytesToWords(new Uint8Array(bits), SAS_WORD_COUNT)
}
