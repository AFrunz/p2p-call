import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  LOCALES,
  createTranslator,
  detectLocale,
  dictionary,
  isLocale,
  localeName,
} from '../../src/i18n/index.js'
import type { Locale } from '../../src/i18n/index.js'
import { buildChecks } from '../../src/net/checks.js'
import { classifyNat } from '../../src/net/nat.js'
import type { StunProbe } from '../../src/net/nat.js'
import type { NetworkReport } from '../../src/net/probe.js'
import { candidate } from '../fixtures/sdp.js'

const MARKUP = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8')

/**
 * Ключи вытаскиваются из разметки, а не переписываются в тест руками: иначе
 * список протухнет на первом же добавленном атрибуте, и тест перестанет ловить
 * ровно то, ради чего написан.
 */
function markupKeys(): string[] {
  const pattern = /data-i18n(?:-aria|-placeholder)?="([^"]+)"/g
  return [...new Set([...MARKUP.matchAll(pattern)].map((match) => match[1] as string))]
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((match) => match[1] as string).sort()
}

/** Проба: один сокет опрашивает несколько серверов и получает внешние порты. */
function probe(externalPorts: number[], servers = externalPorts.length): StunProbe {
  return {
    servers,
    candidates: [...new Set(externalPorts)].map((port) =>
      candidate({
        type: 'srflx',
        address: '203.0.113.7',
        port,
        relatedAddress: '192.168.1.5',
        relatedPort: 54321,
      }),
    ),
  }
}

function report(probe: StunProbe, ipv6 = false): NetworkReport {
  return { ...classifyNat(probe), probe, ipv6 }
}

/** Ключи, которые таблица проверок способна попросить у словаря. */
function checksKeys(): string[] {
  const publicAddress = probe([54321])
  publicAddress.candidates = publicAddress.candidates.map((info) => ({
    ...info,
    relatedAddress: info.address,
    relatedPort: info.port,
  }))

  const views = [
    buildChecks(null),
    buildChecks(report(probe([41234, 41234]), true)),
    buildChecks(report(probe([41234, 41999]))),
    buildChecks(report({ servers: 2, candidates: [] })),
    buildChecks(report(probe([41234], 1))),
    buildChecks(report(publicAddress)),
  ]

  return [
    ...new Set(
      views.flatMap((view) => [
        ...view.checks.flatMap((check) => [check.titleKey, check.noteKey]),
        view.verdict.titleKey,
        view.verdict.noteKey,
      ]),
    ),
  ]
}

describe('словари', () => {
  it('содержат один и тот же набор ключей во всех языках', () => {
    const [first = 'ru', ...rest] = LOCALES
    const reference = Object.keys(dictionary(first)).sort()

    for (const locale of rest) {
      const keys = Object.keys(dictionary(locale)).sort()
      expect(keys.filter((key) => !reference.includes(key)), `лишние в ${locale}`).toEqual([])
      expect(reference.filter((key) => !keys.includes(key)), `нет в ${locale}`).toEqual([])
    }
  })

  it('покрывают все ключи из разметки', () => {
    const keys = markupKeys()
    expect(keys.length).toBeGreaterThan(0)

    for (const locale of LOCALES) {
      const dict = dictionary(locale)
      expect(
        keys.filter((key) => dict[key] === undefined),
        `не переведено на ${locale}`,
      ).toEqual([])
    }
  })

  it('не содержат пустых значений', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(dictionary(locale))) {
        expect(value.trim(), `${locale}/${key}`).not.toBe('')
      }
    }
  })

  it('используют одинаковые подстановки в разных языках', () => {
    const [first = 'ru', ...rest] = LOCALES
    const reference = dictionary(first)

    for (const locale of rest) {
      for (const [key, value] of Object.entries(dictionary(locale))) {
        const expected = placeholders(reference[key] ?? '')
        expect(placeholders(value), `${locale}/${key}`).toEqual(expected)
      }
    }
  })

  it('переводят тексты, а не копируют русские строки', () => {
    const ru = dictionary('ru')
    const en = dictionary('en')

    // Часть значений совпадает законно: '—', 'IPv6', '360p — light' и подобное.
    // Важно, что таких немного, а не то, что их нет вовсе.
    const same = Object.keys(ru).filter((key) => ru[key] === en[key])
    expect(same.length).toBeLessThan(Object.keys(ru).length / 10)
  })

  it('покрывают все ключи, которые запрашивает таблица проверок сети', () => {
    const keys = checksKeys()
    expect(keys.length).toBeGreaterThan(0)

    for (const locale of LOCALES) {
      const dict = dictionary(locale)
      expect(
        keys.filter((key) => dict[key] === undefined),
        `нет в ${locale}`,
      ).toEqual([])
    }
  })

  it('на cone NAT не обещают успех: мы измерили только свою сторону', () => {
    for (const locale of LOCALES) {
      const dict = dictionary(locale)
      const cone = dict['checks.verdict.cone.note'] ?? ''
      expect(cone, locale).not.toBe(dict['checks.verdict.open.note'])
      // Про роутер собеседника сказать обязаны — исход решает пара NAT.
      expect(cone.toLowerCase(), locale).toMatch(/собеседник|other person|other side/)
    }
  })

  it('symmetric NAT подают как предупреждение, а не как приговор', () => {
    const hopeless = /не установится ни с кем|will not work with anyone/i

    for (const locale of LOCALES) {
      const dict = dictionary(locale)
      expect(dict['checks.nat.symmetric'] ?? '', locale).not.toMatch(hopeless)
      expect(dict['checks.verdict.symmetric.note'] ?? '', locale).not.toMatch(hopeless)
      // Заблокированный UDP — единственный окончательный вывод, там так можно.
      expect(dict['checks.verdict.blocked.note'] ?? '', locale).toMatch(hopeless)
    }
  })

  it('в состоянии «не проверялось» не выдают неизвестное за успех', () => {
    const success = /проход|ответ|получ|works|passes|responded|available/i

    for (const locale of LOCALES) {
      const dict = dictionary(locale)
      for (const key of ['checks.reachability.pending', 'checks.reflexive.pending']) {
        expect(dict[key] ?? '', `${locale}/${key}`).not.toMatch(success)
      }
    }
  })

  it('честно называют транспортное шифрование, а не «выключенным»', () => {
    for (const locale of LOCALES) {
      const text = dictionary(locale)['encryption.transportOnly'] ?? ''
      expect(text.toLowerCase(), locale).not.toMatch(/выключ|отключ|disabled|no encryption/)
    }
  })
})

describe('createTranslator', () => {
  it('отдаёт текст на выбранном языке', () => {
    expect(createTranslator('ru')('home.settings')).toBe('Настройки')
    expect(createTranslator('en')('home.settings')).toBe('Settings')
  })

  it('подставляет параметры и не оставляет плейсхолдеров', () => {
    for (const locale of LOCALES) {
      const text = createTranslator(locale)('media.deviceCount', { cameras: 0, microphones: 1 })
      expect(text, locale).not.toMatch(/[{}]/)
      expect(text, locale).toContain('1')
    }
  })

  it('подставляет один и тот же параметр во все его вхождения', () => {
    const translate = createTranslator('ru')
    expect(translate('{who} и ещё раз {who}', { who: 'вы' })).toBe('вы и ещё раз вы')
  })

  it('оставляет плейсхолдер видимым, если значение не передали', () => {
    const translate = createTranslator('ru')
    expect(translate('format.kbps')).toBe('{value} кбит/с')
    expect(translate('format.kbps', {})).toBe('{value} кбит/с')
  })

  it('возвращает неизвестный ключ как есть и не бросает исключение', () => {
    for (const locale of LOCALES) {
      const translate = createTranslator(locale)
      expect(() => translate('home.ttile')).not.toThrow()
      expect(translate('home.ttile'), locale).toBe('home.ttile')
      expect(translate(''), locale).toBe('')
    }
  })

  it('не выдаёт унаследованные от Object свойства за перевод', () => {
    const translate = createTranslator('ru')
    expect(translate('toString')).toBe('toString')
    expect(translate('constructor')).toBe('constructor')
  })
})

describe('detectLocale', () => {
  it('берёт первый поддерживаемый язык из списка предпочтений', () => {
    expect(detectLocale(['ru-RU', 'ru', 'en-US'])).toBe('ru')
    expect(detectLocale(['en-GB', 'ru'])).toBe('en')
    expect(detectLocale(['de-DE', 'ru-RU', 'en'])).toBe('ru')
  })

  it('не смотрит на регион и разделитель', () => {
    expect(detectLocale(['RU'])).toBe('ru')
    expect(detectLocale(['ru_RU'])).toBe('ru')
    expect(detectLocale([' en-US '])).toBe('en')
  })

  it('падает в английский, когда язык браузера не поддержан', () => {
    expect(detectLocale(['de-DE', 'fr'])).toBe('en')
    expect(detectLocale([])).toBe('en')
  })

  it('переживает мусор в списке', () => {
    expect(detectLocale(['', '   ', '-', 'x-y-z', 'russian'])).toBe('en')
    expect(detectLocale([null as unknown as string, 'ru'])).toBe('ru')
  })

  it('всегда возвращает поддерживаемый язык', () => {
    for (const languages of [[], ['zz'], ['ru'], ['en'], ['ru-RU', 'en-US']]) {
      expect(isLocale(detectLocale(languages))).toBe(true)
    }
  })
})

describe('isLocale', () => {
  it('принимает объявленные языки', () => {
    for (const locale of LOCALES) expect(isLocale(locale)).toBe(true)
  })

  it('отвергает всё остальное: значение приходит из localStorage и ссылки', () => {
    for (const value of ['ru-RU', 'RU', 'de', '', ' ru', null, undefined, 0, {}, ['ru']]) {
      expect(isLocale(value), String(value)).toBe(false)
    }
  })
})

describe('localeName', () => {
  it('называет язык на нём самом', () => {
    expect(localeName('ru')).toBe('Русский')
    expect(localeName('en')).toBe('English')
  })

  it('даёт непустое и различимое имя каждому языку', () => {
    const names = LOCALES.map((locale: Locale) => localeName(locale))
    for (const name of names) expect(name.trim()).not.toBe('')
    expect(new Set(names).size).toBe(names.length)
  })

  it('объясняют каждое состояние шифрования: «транспортное» без причины читается как поломка', () => {
    const reasons = [
      'pending',
      'active',
      'unsupported',
      'peerUnsupported',
      'attachFailed',
      'peerPlaintext',
      'codecUnsupported',
    ]

    for (const locale of LOCALES) {
      const words = dictionary(locale) as Record<string, string>
      for (const reason of reasons) {
        expect(words[`encryption.reason.${reason}`], `${locale}/${reason}`).toBeTruthy()
      }
      expect(words['encryption.kinds'], locale).toBeTruthy()
    }
  })
})
