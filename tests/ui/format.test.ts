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
    expect(formatBitrate(350_000)).toBe('350 кбит/с')
  })

  it('переходит на мегабиты от миллиона', () => {
    expect(formatBitrate(2_400_000)).toBe('2.4 Мбит/с')
  })

  it('не рисует цифры там, где данных ещё нет', () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatBitrate(value), String(value)).toBe('—')
    }
  })
})

describe('formatRoundTrip', () => {
  it('показывает миллисекунды', () => {
    expect(formatRoundTrip(42)).toBe('42 мс')
  })

  it('честно молчит, пока задержка не измерена', () => {
    expect(formatRoundTrip(null)).toBe('—')
  })
})

describe('formatLoss', () => {
  it('показывает нулевые потери как нуль, а не как прочерк', () => {
    expect(formatLoss(0)).toBe('0%')
  })

  it('даёт больше знаков на малых потерях, чтобы они не схлопывались в нуль', () => {
    expect(formatLoss(0.003)).toBe('0.30%')
    expect(formatLoss(0.125)).toBe('12.5%')
  })
})

describe('formatResolution', () => {
  it('склеивает ширину и высоту', () => {
    expect(formatResolution(1280, 720)).toBe('1280×720')
  })

  it('молчит, если размер неизвестен', () => {
    expect(formatResolution(null, 720)).toBe('—')
    expect(formatResolution(1280, null)).toBe('—')
  })
})

describe('describeConnection', () => {
  it('различает локальное, прямое и ретранслируемое соединение', () => {
    expect(describeConnection('local')).toContain('локальная')
    expect(describeConnection('direct')).toContain('прямое')
    expect(describeConnection('relay')).toContain('ретранслятор')
  })

  it('пока тип неизвестен, не утверждает, что соединение прямое', () => {
    expect(describeConnection(null)).not.toContain('прямое')
  })
})

describe('describeEncryption', () => {
  it('называет сквозное шифрование сквозным', () => {
    expect(describeEncryption(true)).toEqual({ text: 'сквозное шифрование', ok: true })
  })

  it('без слоя кадров говорит «только транспортное», а не «выключено»', () => {
    // Транспортное шифрование в WebRTC отключить нельзя, и врать про это нельзя тоже.
    const state = describeEncryption(false)
    expect(state.ok).toBe(false)
    expect(state.text).toContain('транспортное')
    expect(state.text).not.toContain('выключ')
  })
})
