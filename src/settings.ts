import { QUALITY_PRESETS, isQualityPreset } from './media/quality.js'
import type { QualityPreset } from './media/quality.js'
import { isAllowedServer } from './signaling/link.js'

const STORAGE_KEY = 'p2p-call/settings/v1'

export interface Settings {
  /** Адрес своего сигналинга. null — работаем без сервера, обмениваясь кодами. */
  signalingServer: string | null
  quality: QualityPreset
  cameraId: string | null
  microphoneId: string | null
}

export const DEFAULT_SETTINGS: Settings = {
  signalingServer: null,
  quality: 'auto',
  cameraId: null,
  microphoneId: null,
}

export type ServerCheck = { ok: true } | { ok: false; error: string }

/**
 * Проверяет адрес сигналинга.
 *
 * Страница отдаётся по HTTPS, поэтому `ws://` браузер заблокирует как mixed
 * content — сказать об этом надо в форме, а не оставить пользователя гадать,
 * почему соединение молча не открывается.
 */
export function validateServerUrl(raw: string): ServerCheck {
  const url = raw.trim()
  if (url.length === 0) return { ok: false, error: 'Укажите адрес сигнального сервера.' }

  if (isAllowedServer(url)) return { ok: true }

  if (/^wss?:\/\//i.test(url)) {
    return {
      ok: false,
      error: 'Незашифрованный ws:// разрешён только на localhost. Используйте wss://',
    }
  }
  return { ok: false, error: 'Адрес должен начинаться с wss:// — например, wss://call.example.com/ws' }
}

/** Читает настройки, молча заменяя испорченные значения умолчаниями. */
export function loadSettings(storage: Storage): Settings {
  let parsed: unknown
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (raw === null) return { ...DEFAULT_SETTINGS }
    parsed = JSON.parse(raw)
  } catch {
    return { ...DEFAULT_SETTINGS }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ...DEFAULT_SETTINGS }
  }

  const source = parsed as Record<string, unknown>
  const server = source['signalingServer']
  const quality = source['quality']

  return {
    signalingServer: typeof server === 'string' && isAllowedServer(server) ? server : null,
    quality: isQualityPreset(quality) ? quality : DEFAULT_SETTINGS.quality,
    cameraId: stringOrNull(source['cameraId']),
    microphoneId: stringOrNull(source['microphoneId']),
  }
}

export function saveSettings(storage: Storage, settings: Settings): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // Приватный режим может запрещать запись. Настройки не сохранятся, но
    // звонить это не мешает — падать тут незачем.
  }
}

/** Список пресетов для выпадающего меню вместе с человеческими подписями. */
export function qualityOptions(): { value: QualityPreset; label: string }[] {
  const labels: Record<QualityPreset, string> = {
    auto: 'Автоматически',
    '360p': '360p — экономно',
    '720p': '720p — обычно',
    '1080p': '1080p — максимум',
  }
  return QUALITY_PRESETS.map((value) => ({ value, label: labels[value] }))
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}
