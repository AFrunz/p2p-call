import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  loadSettings,
  qualityOptions,
  saveSettings,
  validateServerUrl,
} from '../src/settings.js'
import { QUALITY_PRESETS } from '../src/media/quality.js'

/** Хранилище в памяти, чтобы не тащить в тесты jsdom. */
function storage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial))
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
  }
}

/** Хранилище, запрещающее запись, — так ведёт себя приватный режим. */
function readOnlyStorage(): Storage {
  return {
    ...storage(),
    setItem() {
      throw new DOMException('quota', 'QuotaExceededError')
    },
  }
}

describe('validateServerUrl', () => {
  it('принимает wss', () => {
    expect(validateServerUrl('wss://call.example.com/ws')).toEqual({ ok: true })
  })

  it('принимает ws на localhost — для локальной разработки', () => {
    expect(validateServerUrl('ws://localhost:8080/ws')).toEqual({ ok: true })
  })

  it('объясняет, почему ws:// не подходит снаружи', () => {
    // У ws:// своя причина отказа — mixed content, а не опечатка в схеме.
    // Пользователю нужны разные подсказки, поэтому и ключи разные.
    const insecure = validateServerUrl('ws://call.example.com/ws')
    const wrong = validateServerUrl('call.example.com')

    expect(insecure.ok).toBe(false)
    expect(wrong.ok).toBe(false)
    if (!insecure.ok) expect(insecure.error.key).toBe('settings.error.insecure')
    if (!wrong.ok) expect(wrong.error.key).toBe('settings.error.scheme')
  })

  it('отвергает пустой адрес', () => {
    const result = validateServerUrl('   ')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.key).toBe('settings.error.empty')
  })

  it('отвергает http и мусор', () => {
    for (const url of ['https://call.example.com', 'call.example.com', 'javascript:alert(1)']) {
      expect(validateServerUrl(url).ok, url).toBe(false)
    }
  })
})

describe('loadSettings', () => {
  it('на пустом хранилище отдаёт умолчания', () => {
    expect(loadSettings(storage())).toEqual(DEFAULT_SETTINGS)
  })

  it('переживает round-trip', () => {
    const store = storage()
    const settings = {
      signalingServer: 'wss://call.example.com/ws',
      locale: 'en' as const,
      quality: '720p' as const,
      cameraId: 'cam-1',
      microphoneId: 'mic-1',
    }
    saveSettings(store, settings)

    expect(loadSettings(store)).toEqual(settings)
  })

  it('не падает на испорченном JSON', () => {
    expect(loadSettings(storage({ 'p2p-call/settings/v1': '{битый' }))).toEqual(DEFAULT_SETTINGS)
  })

  it('не падает на JSON неверной формы', () => {
    for (const raw of ['null', '[]', '42', '"строка"']) {
      expect(loadSettings(storage({ 'p2p-call/settings/v1': raw })), raw).toEqual(DEFAULT_SETTINGS)
    }
  })

  it('выбрасывает недопустимый адрес сервера вместо того, чтобы им пользоваться', () => {
    // Иначе подложенный в localStorage ws:// увёл бы сигналинг мимо TLS.
    const store = storage({
      'p2p-call/settings/v1': JSON.stringify({ signalingServer: 'ws://evil.example.com' }),
    })
    expect(loadSettings(store).signalingServer).toBeNull()
  })

  it('выбрасывает неизвестный пресет качества', () => {
    const store = storage({ 'p2p-call/settings/v1': JSON.stringify({ quality: '4k' }) })
    expect(loadSettings(store).quality).toBe(DEFAULT_SETTINGS.quality)
  })

  it('не принимает нестроковые идентификаторы устройств', () => {
    const store = storage({
      'p2p-call/settings/v1': JSON.stringify({ cameraId: 42, microphoneId: {} }),
    })
    const settings = loadSettings(store)

    expect(settings.cameraId).toBeNull()
    expect(settings.microphoneId).toBeNull()
  })
})

describe('saveSettings', () => {
  it('не падает, когда хранилище запрещает запись', () => {
    // Приватный режим Safari именно так себя и ведёт; звонить это не мешает.
    expect(() => saveSettings(readOnlyStorage(), DEFAULT_SETTINGS)).not.toThrow()
  })
})

describe('qualityOptions', () => {
  it('покрывает все пресеты и даёт каждому ключ подписи', () => {
    const options = qualityOptions()
    expect(options.map((option) => option.value)).toEqual([...QUALITY_PRESETS])

    for (const option of options) {
      expect(option.labelKey, option.value).toBe(`quality.${option.value}`)
    }
  })
})

describe('язык', () => {
  it('по умолчанию язык не выбран — значит берём его у браузера', () => {
    expect(loadSettings(storage()).locale).toBeNull()
  })

  it('переживает round-trip', () => {
    const store = storage()
    saveSettings(store, { ...DEFAULT_SETTINGS, locale: 'en' })
    expect(loadSettings(store).locale).toBe('en')
  })

  it('выбрасывает неизвестный язык вместо того, чтобы им пользоваться', () => {
    const store = storage({ 'p2p-call/settings/v1': JSON.stringify({ locale: 'klingon' }) })
    expect(loadSettings(store).locale).toBeNull()
  })
})
