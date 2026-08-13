import { isQualityPreset } from '../media/quality.js'
import type { QualityPreset } from '../media/quality.js'

/** Как собеседник шифрует кадры — знать это можно только с его слов. */
export type TransformSupportName = 'script-transform' | 'encoded-streams' | 'none'

const SUPPORT_NAMES: readonly string[] = ['script-transform', 'encoded-streams', 'none']

/**
 * Служебные сообщения поверх DataChannel. Приходят от собеседника, поэтому
 * decodeMessage возвращает null на любом отклонении от схемы.
 */
export type ControlMessage =
  | { t: 'mute'; kind: 'audio' | 'video'; muted: boolean }
  | { t: 'quality'; preset: QualityPreset }
  | { t: 'keyRotate'; keyId: number }
  | { t: 'ping'; ts: number }
  | { t: 'pong'; ts: number }
  | { t: 'frames'; ok: number; failed: number }
  | { t: 'encryption'; attached: boolean; support: TransformSupportName }
  | { t: 'keyCheck'; audio: string; video: string }
  | { t: 'bye' }

export function encodeMessage(message: ControlMessage): string {
  return JSON.stringify(message)
}

/** Возвращает null на любом некорректном вводе — исключений наружу не бросает. */
export function decodeMessage(raw: string): ControlMessage | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null

  // Читаем только известные поля и собираем сообщение заново: что бы ни лежало
  // в исходном объекте, наружу уходит ровно объявленная структура.
  const source = parsed as Record<string, unknown>

  switch (source['t']) {
    case 'mute': {
      const kind = source['kind']
      const muted = source['muted']
      if ((kind !== 'audio' && kind !== 'video') || typeof muted !== 'boolean') return null
      return { t: 'mute', kind, muted }
    }
    case 'quality': {
      const preset = source['preset']
      return isQualityPreset(preset) ? { t: 'quality', preset } : null
    }
    case 'keyRotate': {
      const keyId = source['keyId']
      if (!isByte(keyId)) return null
      return { t: 'keyRotate', keyId }
    }
    case 'ping': {
      const ts = source['ts']
      return isTimestamp(ts) ? { t: 'ping', ts } : null
    }
    case 'pong': {
      const ts = source['ts']
      return isTimestamp(ts) ? { t: 'pong', ts } : null
    }
    case 'frames': {
      const ok = source['ok']
      const failed = source['failed']
      if (!isCount(ok) || !isCount(failed)) return null
      return { t: 'frames', ok, failed }
    }
    case 'encryption': {
      const attached = source['attached']
      const support = source['support']
      if (typeof attached !== 'boolean') return null
      if (typeof support !== 'string' || !SUPPORT_NAMES.includes(support)) return null
      return { t: 'encryption', attached, support: support as TransformSupportName }
    }
    case 'keyCheck': {
      const audio = source['audio']
      const video = source['video']
      if (!isCheck(audio) || !isCheck(video)) return null
      return { t: 'keyCheck', audio, video }
    }
    case 'bye':
      return { t: 'bye' }
    default:
      return null
  }
}

/** Контрольная сумма — ровно восемь шестнадцатеричных цифр. */
function isCheck(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}$/.test(value)
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isByte(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
