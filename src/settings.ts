import { isLocale } from './i18n/index.js'
import type { Locale } from './i18n/index.js'
import { message } from './i18n/message.js'
import type { Message } from './i18n/message.js'
import { QUALITY_PRESETS, isQualityPreset } from './media/quality.js'
import type { QualityPreset } from './media/quality.js'
import { isAllowedServer } from './signaling/link.js'

const STORAGE_KEY = 'p2p-call/settings/v1'

export interface Settings {
  /** Адрес своего сигналинга. null — работаем без сервера, обмениваясь кодами. */
  signalingServer: string | null
  /** null — берём язык браузера. */
  locale: Locale | null
  quality: QualityPreset
  cameraId: string | null
  microphoneId: string | null
}

export const DEFAULT_SETTINGS: Settings = {
  signalingServer: null,
  locale: null,
  quality: 'auto',
  cameraId: null,
  microphoneId: null,
}

export type ServerCheck = { ok: true } | { ok: false; error: Message }

/**
 * Проверяет адрес сигналинга.
 *
 * Страница отдаётся по HTTPS, поэтому `ws://` браузер заблокирует как mixed
 * content — сказать об этом надо в форме, а не оставить пользователя гадать,
 * почему соединение молча не открывается.
 */
export function validateServerUrl(raw: string): ServerCheck {
  const url = raw.trim()
  if (url.length === 0) return { ok: false, error: message('settings.error.empty') }
  if (isAllowedServer(url)) return { ok: true }

  // Отдельная формулировка для ws://: дело не в опечатке, а в том, что страница
  // отдаётся по HTTPS и браузер заблокирует такое соединение как mixed content.
  const scheme = /^wss?:\/\//i.test(url) ? 'settings.error.insecure' : 'settings.error.scheme'
  return { ok: false, error: message(scheme) }
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
  const locale = source['locale']

  return {
    signalingServer: typeof server === 'string' && isAllowedServer(server) ? server : null,
    locale: isLocale(locale) ? locale : null,
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

/**
 * Пресеты для выпадающего меню.
 *
 * Возвращаем ключи, а не готовые подписи: язык переключается на лету, и
 * зашитый в модуль русский текст пришлось бы обходить стороной.
 */
export function qualityOptions(): { value: QualityPreset; labelKey: string }[] {
  return QUALITY_PRESETS.map((value) => ({ value, labelKey: `quality.${value}` }))
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}
