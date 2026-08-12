/**
 * TypeScript 5.7 сделал типизированные массивы generic по типу буфера, а
 * WebCrypto принимает только те, что лежат в обычном ArrayBuffer — не в
 * SharedArrayBuffer. Псевдоним нужен, чтобы это ограничение было явным в
 * сигнатурах, а не вылезало каскадом ошибок на каждом вызове subtle.
 */
export type Bytes = Uint8Array<ArrayBuffer>

/** Склеивает несколько блоков в один буфер. */
export function concatBytes(...chunks: Uint8Array[]): Bytes {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const result = new Uint8Array(total)

  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}
