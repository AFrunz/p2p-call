import { describe, expect, it } from 'vitest'
import {
  QUALITY_PRESETS,
  isQualityPreset,
  presetSpec,
  presetToConstraints,
  presetToEncodings,
} from '../../src/media/quality.js'
import type { QualityPreset } from '../../src/media/quality.js'

const FIXED: QualityPreset[] = ['360p', '720p', '1080p']

describe('presetSpec', () => {
  it('описывает каждый фиксированный пресет', () => {
    expect(presetSpec('360p')).toMatchObject({ width: 640, height: 360 })
    expect(presetSpec('720p')).toMatchObject({ width: 1280, height: 720 })
    expect(presetSpec('1080p')).toMatchObject({ width: 1920, height: 1080 })
  })

  it('не задаёт потолок для авто — там решает сам WebRTC', () => {
    expect(presetSpec('auto')).toBeNull()
  })

  it('повышает битрейт вместе с разрешением', () => {
    const bitrates = FIXED.map((preset) => presetSpec(preset)!.maxBitrate)
    expect(bitrates).toEqual([...bitrates].sort((a, b) => a - b))
    expect(new Set(bitrates).size).toBe(bitrates.length)
  })

  it('держит частоту кадров в разумных пределах', () => {
    for (const preset of FIXED) {
      const spec = presetSpec(preset)!
      expect(spec.frameRate, preset).toBeGreaterThanOrEqual(15)
      expect(spec.frameRate, preset).toBeLessThanOrEqual(60)
    }
  })
})

describe('presetToConstraints', () => {
  it('просит разрешение как ideal: exact заставит камеру без такого режима отказать', () => {
    const constraints = presetToConstraints('720p') as Record<string, unknown>
    expect(constraints['width']).toMatchObject({ ideal: 1280 })
    expect(constraints['height']).toMatchObject({ ideal: 720 })
    expect(JSON.stringify(constraints)).not.toContain('exact')
  })

  it('для авто просит достойное разрешение, а не отдаёт выбор браузеру', () => {
    // Без подсказки браузер берёт свой минимум — обычно 640×480, и картинка
    // выглядит плохо при любом канале. Опускаться при нехватке полосы WebRTC
    // умеет сам, а вот поднимать выше захваченного — нет.
    const constraints = presetToConstraints('auto') as Record<string, unknown>
    expect(constraints['width']).toMatchObject({ ideal: 1280 })
    expect(constraints['height']).toMatchObject({ ideal: 720 })
  })
})

describe('presetToEncodings', () => {
  it('ставит потолок битрейта из спецификации пресета', () => {
    for (const preset of FIXED) {
      const [encoding] = presetToEncodings(preset)
      expect(encoding?.maxBitrate, preset).toBe(presetSpec(preset)!.maxBitrate)
    }
  })

  it('для авто потолок не ставит', () => {
    const [encoding] = presetToEncodings('auto')
    expect(encoding?.maxBitrate).toBeUndefined()
  })

  it('всегда отдаёт ровно один слой: симулкаст в p2p не нужен', () => {
    for (const preset of QUALITY_PRESETS) {
      expect(presetToEncodings(preset), preset).toHaveLength(1)
    }
  })

  it('не выключает поток нулевым битрейтом', () => {
    for (const preset of QUALITY_PRESETS) {
      const max = presetToEncodings(preset)[0]?.maxBitrate
      if (max !== undefined) expect(max, preset).toBeGreaterThan(0)
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
