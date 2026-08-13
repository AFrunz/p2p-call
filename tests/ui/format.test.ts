import { describe, expect, it } from 'vitest'
import {
  describeConnection,
  describeEncryption,
  formatBitrate,
  formatLoss,
  formatResolution,
  formatRoundTrip,
} from '../../src/ui/format.js'

describe('formatBitrate', () => {
  it('показывает килобиты на малых скоростях', () => {
    expect(formatBitrate(350_000)).toEqual({ key: 'format.kbps', params: { value: 350 } })
  })

  it('переходит на мегабиты от миллиона', () => {
    expect(formatBitrate(2_400_000)).toEqual({ key: 'format.mbps', params: { value: '2.4' } })
  })

  it('сохраняет знак после запятой у круглых мегабит', () => {
    // «2 Мбит/с» и «2.0 Мбит/с» — разная заявленная точность измерения.
    expect(formatBitrate(2_000_000)).toEqual({ key: 'format.mbps', params: { value: '2.0' } })
  })

  it('не рисует цифры там, где данных ещё нет', () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatBitrate(value), String(value)).toEqual({ key: 'format.none' })
    }
  })
})

describe('formatRoundTrip', () => {
  it('показывает миллисекунды', () => {
    expect(formatRoundTrip(42)).toEqual({ key: 'format.ms', params: { value: 42 } })
  })

  it('честно молчит, пока задержка не измерена', () => {
    expect(formatRoundTrip(null)).toEqual({ key: 'format.none' })
  })
})

describe('formatLoss', () => {
  it('показывает нулевые потери как нуль, а не как прочерк', () => {
    // Ноль — это измеренный результат; прочерк читался бы как «не измеряли».
    expect(formatLoss(0)).toBe('0%')
  })

  it('даёт больше знаков на малых потерях, чтобы они не схлопывались в нуль', () => {
    expect(formatLoss(0.003)).toBe('0.30%')
    expect(formatLoss(0.125)).toBe('12.5%')
  })
})

describe('formatResolution', () => {
  it('склеивает ширину и высоту', () => {
    expect(formatResolution(1280, 720)).toEqual({
      key: 'format.resolution',
      params: { width: 1280, height: 720 },
    })
  })

  it('молчит, если размер неизвестен', () => {
    expect(formatResolution(null, 720)).toEqual({ key: 'format.none' })
    expect(formatResolution(1280, null)).toEqual({ key: 'format.none' })
  })
})

describe('describeConnection', () => {
  it('различает все четыре пути соединения', () => {
    expect(describeConnection('local')).toEqual({ key: 'route.local' })
    expect(describeConnection('ipv6')).toEqual({ key: 'route.ipv6' })
    expect(describeConnection('nat')).toEqual({ key: 'route.nat' })
    expect(describeConnection('relay')).toEqual({ key: 'route.relay' })
  })

  it('пока путь неизвестен, не утверждает, что соединение прямое', () => {
    // Соединение вполне может оказаться ретранслируемым — до выбора пары
    // кандидатов мы просто молчим.
    expect(describeConnection(null)).toEqual({ key: 'route.pending' })
    expect(describeConnection(null).key).not.toBe(describeConnection('nat').key)
    expect(describeConnection(null).key).not.toBe(describeConnection('local').key)
  })
})

describe('describeEncryption', () => {
  it('называет сквозное шифрование сквозным', () => {
    expect(describeEncryption(true)).toEqual({ text: { key: 'encryption.e2ee' }, ok: true })
  })

  it('без слоя кадров говорит «только транспортное», а не «выключено»', () => {
    // Транспортное шифрование в WebRTC отключить нельзя, и врать про это нельзя
    // тоже: здесь проверяем выбор ключа, а честность формулировки в каждом
    // языке — тесты словаря в tests/i18n.
    const state = describeEncryption(false)
    expect(state.ok).toBe(false)
    expect(state.text).toEqual({ key: 'encryption.transportOnly' })
    expect(state.text.key).not.toBe('encryption.e2ee')
  })
})
