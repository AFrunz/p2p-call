import type { ConnectionKind } from '../net/nat.js'

/** Битрейт в человеческом виде: биты — единица, в которой считают каналы связи. */
export function formatBitrate(bitsPerSecond: number): string {
  if (!Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) return '—'
  if (bitsPerSecond < 1_000_000) return `${Math.round(bitsPerSecond / 1000)} кбит/с`
  return `${(bitsPerSecond / 1_000_000).toFixed(1)} Мбит/с`
}

export function formatRoundTrip(milliseconds: number | null): string {
  return milliseconds === null ? '—' : `${milliseconds} мс`
}

export function formatLoss(fraction: number): string {
  if (!Number.isFinite(fraction) || fraction <= 0) return '0%'
  return `${(fraction * 100).toFixed(fraction < 0.01 ? 2 : 1)}%`
}

export function formatResolution(width: number | null, height: number | null): string {
  return width === null || height === null ? '—' : `${width}×${height}`
}

/** Подпись о том, как именно установлено соединение. */
export function describeConnection(kind: ConnectionKind | null): string {
  switch (kind) {
    case 'local':
      return 'прямое, локальная сеть'
    case 'direct':
      return 'прямое соединение'
    case 'relay':
      return 'через ретранслятор'
    default:
      return 'соединение…'
  }
}

/**
 * Что показывать про шифрование.
 *
 * Транспортный слой есть всегда и отключить его нельзя, поэтому «выключено»
 * тут не бывает — бывает «только транспортное», и это надо назвать честно.
 */
export function describeEncryption(frameEncryption: boolean): { text: string; ok: boolean } {
  return frameEncryption
    ? { text: 'сквозное шифрование', ok: true }
    : { text: 'только транспортное шифрование', ok: false }
}
