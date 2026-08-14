import { isLocale } from './i18n/index.js'
import type { Locale } from './i18n/index.js'
import { message } from './i18n/message.js'
import type { Message } from './i18n/message.js'
import { FRAME_RATES, QUALITY_PRESETS, isFrameRate, isQualityPreset } from './media/quality.js'
import type { FrameRate, QualityPreset } from './media/quality.js'
import { isAllowedServer } from './signaling/link.js'

const STORAGE_KEY = 'p2p-call/settings/v1'

export interface Settings {
  /** Адрес своего сигналинга. null — работаем без сервера, обмениваясь кодами. */
  signalingServer: string | null
  /** null — берём язык браузера. */
  locale: Locale | null
  quality: QualityPreset
  /** Частота кадров: задаётся отдельно от разрешения. */
  frameRate: FrameRate
  cameraId: string | null
  microphoneId: string | null
  /**
   * Минимальная задержка вместо плавности.
   *
   * Приёмник перестаёт копить кадры: разговор становится живым, но неровности
   * сети сразу видны рывками.
   */
  lowLatency: boolean
  /** Через сколько секунд после готовности ответа обе стороны начнут проверку. */
  connectDelay: number
}

export const DEFAULT_SETTINGS: Settings = {
  signalingServer: null,
  locale: null,
  quality: 'auto',
  // Тридцать кадров тянет любая камера и любой канал; шестьдесят — осознанный
  // выбор ради плавности, и платить за него полосой должен тот, кто попросил.
  frameRate: 30,
  cameraId: null,
  microphoneId: null,
  lowLatency: false,
  connectDelay: 60,
}

/** Варианты задержки старта: меньше 30 секунд на перенос кода не хватает. */
export const CONNECT_DELAYS = [30, 60, 120, 300] as const

export type ServerCheck = { ok: true } | { ok: false; error: Message }

/**
 * Проверяет адрес сигналинга. `ws://` браузер заблокирует как mixed content —
 * об этом надо сказать в форме, а не оставить пользователя гадать.
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
    frameRate: isFrameRate(source['frameRate']) ? source['frameRate'] : DEFAULT_SETTINGS.frameRate,
    cameraId: stringOrNull(source['cameraId']),
    microphoneId: stringOrNull(source['microphoneId']),
    lowLatency: source['lowLatency'] === true,
    connectDelay: isConnectDelay(source['connectDelay'])
      ? source['connectDelay']
      : DEFAULT_SETTINGS.connectDelay,
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

/**
 * Частоты для второй группы переключателей.
 *
 * Подпись у всех одна и та же с подстановкой числа: заводить по ключу на
 * значение значило бы дублировать в словарях одну и ту же фразу.
 */
export function frameRateOptions(): { value: FrameRate; labelKey: string; params: { value: number } }[] {
  return FRAME_RATES.map((value) => ({ value, labelKey: 'quality.fps', params: { value } }))
}

export function isConnectDelay(value: unknown): value is number {
  return typeof value === 'number' && (CONNECT_DELAYS as readonly number[]).includes(value)
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}
