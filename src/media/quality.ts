export type QualityPreset = 'auto' | '360p' | '720p' | '1080p'

export const QUALITY_PRESETS: readonly QualityPreset[] = ['auto', '360p', '720p', '1080p']

/**
 * Частота кадров задаётся отдельно от разрешения: 1080p30 и 720p60 нужны
 * разным людям, и сводить это в один список из шести строк незачем.
 */
export type FrameRate = 30 | 60

export const FRAME_RATES: readonly FrameRate[] = [30, 60]

/** Базовая частота: от неё считаются и спецификации, и надбавка к битрейту. */
export const BASE_FRAME_RATE: FrameRate = 30

/**
 * Надбавка к полосе при удвоении частоты кадров.
 *
 * Не два, а полтора: кодек кодирует не каждый кадр целиком, а разницу с
 * предыдущим. Чем чаще снимаем, тем сильнее соседние кадры похожи и тем меньше
 * этой разницы приходится на кадр. Удвоение битрейта было бы платой за то, чего
 * в потоке нет.
 */
const FPS_BITRATE_FACTOR = 1.5

export interface PresetSpec {
  width: number
  height: number
  frameRate: number
  /** Верхний предел битрейта в бит/с. */
  maxBitrate: number
}

/** Что просим у камеры в режиме «автоматически»: потолок задаёт уже сеть. */
const AUTO_CAPTURE: PresetSpec = {
  width: 1280,
  height: 720,
  frameRate: BASE_FRAME_RATE,
  maxBitrate: 0,
}

/** Битрейты здесь — для базовой частоты; за 60 кадров начисляется надбавка. */
const SPECS: Record<Exclude<QualityPreset, 'auto'>, PresetSpec> = {
  '360p': { width: 640, height: 360, frameRate: BASE_FRAME_RATE, maxBitrate: 1_000_000 },
  '720p': { width: 1280, height: 720, frameRate: BASE_FRAME_RATE, maxBitrate: 3_000_000 },
  // Для 1080p30 четырёх мегабит впритык: кодек начинает мылить на движении.
  '1080p': { width: 1920, height: 1080, frameRate: BASE_FRAME_RATE, maxBitrate: 6_000_000 },
}

/** Числовые параметры пресета. Для `auto` возвращает null — потолок не задаём. */
export function presetSpec(preset: QualityPreset, frameRate: FrameRate): PresetSpec | null {
  if (preset === 'auto') return null

  const base = SPECS[preset]
  return { ...base, frameRate, maxBitrate: Math.round(base.maxBitrate * bitrateFactor(frameRate)) }
}

/** Во сколько раз частота дороже базовой по полосе. */
function bitrateFactor(frameRate: FrameRate): number {
  return frameRate > BASE_FRAME_RATE ? FPS_BITRATE_FACTOR : 1
}

/**
 * Ограничения для getUserMedia: ideal, не exact — иначе камера без нужного
 * режима откажет.
 *
 * У `auto` тоже есть разрешение, и это принципиально: без подсказки браузер
 * берёт свой минимум (обычно 640×480), и картинка выглядит плохо независимо от
 * канала. Просим 720p и даём WebRTC самому опускаться при нехватке полосы —
 * это и есть «автоматически».
 */
export function presetToConstraints(
  preset: QualityPreset,
  frameRate: FrameRate,
): MediaTrackConstraints {
  const spec = presetSpec(preset, frameRate) ?? AUTO_CAPTURE

  return {
    width: { ideal: spec.width },
    height: { ideal: spec.height },
    // Частота тоже ideal: 60 кадров умеет не всякая камера, и отказ в захвате
    // вместо тридцати кадров — худший из возможных исходов.
    frameRate: { ideal: frameRate },
  }
}

/** Параметры для sender.setParameters — меняются на лету без ренеготиации. */
export function presetToEncodings(
  preset: QualityPreset,
  frameRate: FrameRate,
): RTCRtpEncodingParameters[] {
  const spec = presetSpec(preset, frameRate)
  // Ровно один слой: симулкаст нужен для SFU, а в p2p получатель всегда один.
  // Потолок частоты ставим и в авто: разрешение там выбирает сеть, а частота —
  // человек, и молча отдавать её на откуп кодеку незачем.
  if (spec === null) return [{ maxFramerate: frameRate }]

  return [
    {
      maxBitrate: spec.maxBitrate,
      maxFramerate: frameRate,
      scaleResolutionDownBy: 1,
    },
  ]
}

export function isQualityPreset(value: unknown): value is QualityPreset {
  return typeof value === 'string' && (QUALITY_PRESETS as readonly string[]).includes(value)
}

/** Частота приходит и от собеседника, и из хранилища — верить ей нельзя. */
export function isFrameRate(value: unknown): value is FrameRate {
  return typeof value === 'number' && (FRAME_RATES as readonly number[]).includes(value)
}
