export type QualityPreset = 'auto' | '360p' | '720p' | '1080p'

export const QUALITY_PRESETS: readonly QualityPreset[] = ['auto', '360p', '720p', '1080p']

export interface PresetSpec {
  width: number
  height: number
  frameRate: number
  /** Верхний предел битрейта в бит/с. */
  maxBitrate: number
}

const SPECS: Record<Exclude<QualityPreset, 'auto'>, PresetSpec> = {
  '360p': { width: 640, height: 360, frameRate: 30, maxBitrate: 800_000 },
  '720p': { width: 1280, height: 720, frameRate: 30, maxBitrate: 2_000_000 },
  '1080p': { width: 1920, height: 1080, frameRate: 30, maxBitrate: 4_000_000 },
}

/** Числовые параметры пресета. Для `auto` возвращает null — потолок не задаём. */
export function presetSpec(preset: QualityPreset): PresetSpec | null {
  return preset === 'auto' ? null : SPECS[preset]
}

/** Ограничения для getUserMedia: ideal, не exact — иначе камера без нужного режима откажет. */
export function presetToConstraints(preset: QualityPreset): MediaTrackConstraints {
  const spec = presetSpec(preset)
  if (spec === null) return {}

  return {
    width: { ideal: spec.width },
    height: { ideal: spec.height },
    frameRate: { ideal: spec.frameRate },
  }
}

/** Параметры для sender.setParameters — меняются на лету без ренеготиации. */
export function presetToEncodings(preset: QualityPreset): RTCRtpEncodingParameters[] {
  const spec = presetSpec(preset)
  // Ровно один слой: симулкаст нужен для SFU, а в p2p получатель всегда один.
  if (spec === null) return [{}]

  return [
    {
      maxBitrate: spec.maxBitrate,
      maxFramerate: spec.frameRate,
      scaleResolutionDownBy: 1,
    },
  ]
}

export function isQualityPreset(value: unknown): value is QualityPreset {
  return typeof value === 'string' && (QUALITY_PRESETS as readonly string[]).includes(value)
}
