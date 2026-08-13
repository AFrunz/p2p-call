import { describe, expect, it } from 'vitest'
import {
  FRAME_RATES,
  QUALITY_PRESETS,
  isFrameRate,
  isQualityPreset,
  presetSpec,
  presetToConstraints,
  presetToEncodings,
} from '../../src/media/quality.js'
import type { FrameRate, QualityPreset } from '../../src/media/quality.js'

const FIXED: QualityPreset[] = ['360p', '720p', '1080p']

describe('presetSpec', () => {
  it('описывает каждый фиксированный пресет', () => {
    expect(presetSpec('360p', 30)).toMatchObject({ width: 640, height: 360 })
    expect(presetSpec('720p', 30)).toMatchObject({ width: 1280, height: 720 })
    expect(presetSpec('1080p', 30)).toMatchObject({ width: 1920, height: 1080 })
  })

  it('не задаёт потолок для авто — там решает сам WebRTC', () => {
    expect(presetSpec('auto', 30)).toBeNull()
    expect(presetSpec('auto', 60)).toBeNull()
  })

  it('повышает битрейт вместе с разрешением', () => {
    for (const fps of FRAME_RATES) {
      const bitrates = FIXED.map((preset) => presetSpec(preset, fps)!.maxBitrate)
      expect(bitrates, String(fps)).toEqual([...bitrates].sort((a, b) => a - b))
      expect(new Set(bitrates).size, String(fps)).toBe(bitrates.length)
    }
  })

  it('отдаёт запрошенную частоту, а не зашитую в пресет', () => {
    for (const preset of FIXED) {
      for (const fps of FRAME_RATES) {
        expect(presetSpec(preset, fps)!.frameRate, `${preset}@${fps}`).toBe(fps)
      }
    }
  })

  it('не меняет разрешение от частоты: это независимые оси', () => {
    for (const preset of FIXED) {
      const thirty = presetSpec(preset, 30)!
      const sixty = presetSpec(preset, 60)!
      expect([sixty.width, sixty.height], preset).toEqual([thirty.width, thirty.height])
    }
  })
})

describe('битрейт и частота кадров', () => {
  it('за 60 кадров просит больше полосы, но меньше двойной', () => {
    // Удвоение частоты не удваивает поток: соседние кадры похожи, и кодер
    // тратит на разницу между ними меньше, чем на самостоятельный кадр.
    for (const preset of FIXED) {
      const thirty = presetSpec(preset, 30)!.maxBitrate
      const sixty = presetSpec(preset, 60)!.maxBitrate

      expect(sixty, preset).toBeGreaterThan(thirty)
      expect(sixty, preset).toBeLessThan(thirty * 2)
    }
  })

  it('тот же коэффициент виден и в параметрах отправителя', () => {
    for (const preset of FIXED) {
      const thirty = presetToEncodings(preset, 30)[0]!.maxBitrate!
      const sixty = presetToEncodings(preset, 60)[0]!.maxBitrate!

      expect(sixty, preset).toBeGreaterThan(thirty)
      expect(sixty, preset).toBeLessThan(thirty * 2)
    }
  })

  it('даёт целое число бит в секунду — дробей WebRTC не ждёт', () => {
    for (const preset of FIXED) {
      for (const fps of FRAME_RATES) {
        expect(Number.isInteger(presetSpec(preset, fps)!.maxBitrate), `${preset}@${fps}`).toBe(true)
      }
    }
  })
})

describe('presetToConstraints', () => {
  it('просит разрешение как ideal: exact заставит камеру без такого режима отказать', () => {
    const constraints = presetToConstraints('720p', 30) as Record<string, unknown>
    expect(constraints['width']).toMatchObject({ ideal: 1280 })
    expect(constraints['height']).toMatchObject({ ideal: 720 })
    expect(JSON.stringify(constraints)).not.toContain('exact')
  })

  it('просит частоту как ideal — иначе камера без 60 кадров откажет вовсе', () => {
    for (const preset of QUALITY_PRESETS) {
      for (const fps of FRAME_RATES) {
        const constraints = presetToConstraints(preset, fps) as Record<string, unknown>
        expect(constraints['frameRate'], `${preset}@${fps}`).toEqual({ ideal: fps })
        expect(JSON.stringify(constraints), `${preset}@${fps}`).not.toContain('exact')
      }
    }
  })

  it('для авто просит достойное разрешение, а не отдаёт выбор браузеру', () => {
    // Без подсказки браузер берёт свой минимум — обычно 640×480, и картинка
    // выглядит плохо при любом канале. Опускаться при нехватке полосы WebRTC
    // умеет сам, а вот поднимать выше захваченного — нет.
    const constraints = presetToConstraints('auto', 30) as Record<string, unknown>
    expect(constraints['width']).toMatchObject({ ideal: 1280 })
    expect(constraints['height']).toMatchObject({ ideal: 720 })
  })

  it('в авто частота всё равно наша: сеть выбирает разрешение, а не плавность', () => {
    const constraints = presetToConstraints('auto', 60) as Record<string, unknown>
    expect(constraints['frameRate']).toEqual({ ideal: 60 })
  })
})

describe('presetToEncodings', () => {
  it('ставит потолок битрейта из спецификации пресета', () => {
    for (const preset of FIXED) {
      for (const fps of FRAME_RATES) {
        const [encoding] = presetToEncodings(preset, fps)
        expect(encoding?.maxBitrate, `${preset}@${fps}`).toBe(presetSpec(preset, fps)!.maxBitrate)
      }
    }
  })

  it('для авто потолок не ставит', () => {
    const [encoding] = presetToEncodings('auto', 30)
    expect(encoding?.maxBitrate).toBeUndefined()
  })

  it('ограничивает частоту тем, что попросили', () => {
    for (const preset of QUALITY_PRESETS) {
      for (const fps of FRAME_RATES) {
        expect(presetToEncodings(preset, fps)[0]?.maxFramerate, `${preset}@${fps}`).toBe(fps)
      }
    }
  })

  it('всегда отдаёт ровно один слой: симулкаст в p2p не нужен', () => {
    for (const preset of QUALITY_PRESETS) {
      for (const fps of FRAME_RATES) {
        expect(presetToEncodings(preset, fps), `${preset}@${fps}`).toHaveLength(1)
      }
    }
  })

  it('не выключает поток нулевым битрейтом', () => {
    for (const preset of QUALITY_PRESETS) {
      for (const fps of FRAME_RATES) {
        const max = presetToEncodings(preset, fps)[0]?.maxBitrate
        if (max !== undefined) expect(max, `${preset}@${fps}`).toBeGreaterThan(0)
      }
    }
  })
})

describe('isQualityPreset', () => {
  it('принимает все объявленные пресеты', () => {
    for (const preset of QUALITY_PRESETS) expect(isQualityPreset(preset)).toBe(true)
  })

  it('отвергает всё остальное — значение приходит от собеседника', () => {
    for (const value of ['4k', '', null, undefined, 720, {}, ['720p']]) {
      expect(isQualityPreset(value)).toBe(false)
    }
  })
})

describe('isFrameRate', () => {
  it('принимает объявленные частоты', () => {
    for (const fps of FRAME_RATES) expect(isFrameRate(fps)).toBe(true)
  })

  it('отвергает всё остальное — значение приходит от собеседника', () => {
    // Ноль остановил бы картинку, тысяча — попросила бы у камеры невозможное,
    // а строка «30» молча уехала бы в ограничения и сломала бы захват.
    for (const value of [0, -30, 24, 29, 59.94, 120, 1000, '30', null, undefined, {}, [30], NaN]) {
      expect(isFrameRate(value), JSON.stringify(value) ?? String(value)).toBe(false)
    }
  })

  it('сужает тип до объявленного набора', () => {
    const value: unknown = 60
    if (isFrameRate(value)) {
      const fps: FrameRate = value
      expect(fps).toBe(60)
    }
  })
})
