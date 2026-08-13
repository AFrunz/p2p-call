import { message } from '../i18n/message.js'
import type { Message } from '../i18n/message.js'
import { presetToConstraints, presetToEncodings } from '../media/quality.js'
import type { QualityPreset } from '../media/quality.js'

export interface DeviceOption {
  deviceId: string
  /**
   * Название устройства.
   *
   * Строка — это имя от браузера, его переводить нечего и незачем. Message —
   * подпись для безымянного устройства (браузер молчит, пока не выдано
   * разрешение): её собирает интерфейс на своём языке. Отдавать всё Message
   * не выйдет — под живое имя пришлось бы заводить ключ в словаре, а отдавать
   * всё строкой значит снова зашить сюда язык. Разбор у потребителя простой:
   * `typeof label === 'string' ? label : translate(label.key, label.params)`.
   */
  label: string | Message
}

export interface DeviceList {
  cameras: DeviceOption[]
  microphones: DeviceOption[]
}

export type MediaKind = 'audio' | 'video'

export type MediaFailure =
  | 'denied'
  | 'absent'
  | 'busy'
  | 'insecure'
  | 'unsupported'
  | 'overconstrained'
  | 'unknown'

/**
 * Почему устройства не достались.
 *
 * Остаётся наследником Error: ошибка всплывает в логах и в стеках, и терять
 * это из-за локализации незачем. Но текст для человека несёт ключом — модуль
 * ядра не знает языка интерфейса. В `super` уходит ключ: для отладки это
 * осмысленная строка, а показывать её пользователю никто и не собирается.
 */
export class MediaError extends Error {
  constructor(
    readonly text: Message,
    readonly kind: MediaFailure,
    /**
     * Уточнение к основному тексту, если оно есть. Отдельным сообщением, а не
     * припиской к `text`: склеивать переводы в ядре нельзя — порядок и пробелы
     * между фразами решает язык, а не мы.
     */
    readonly details: Message | null = null,
  ) {
    super(text.key)
    this.name = 'MediaError'
  }
}

export interface MediaRequest {
  preset: QualityPreset
  cameraId?: string | null
  microphoneId?: string | null
  /**
   * Какие устройства нужны. По умолчанию оба вида.
   *
   * Досдача одной дорожки во время звонка должна трогать только её: включая
   * микрофон, незачем зажигать камеру, а на машине без камеры незачем и
   * спотыкаться о её отсутствие.
   */
  kinds?: readonly MediaKind[]
}

export interface MediaResult {
  /** Может не содержать ни одной дорожки: звонок «только смотреть» тоже звонок. */
  stream: MediaStream
  /** Что получить не удалось. */
  missing: MediaKind[]
  /** Пришлось отказаться от сохранённого устройства — оно больше не подключено. */
  ignoredSavedDevice: boolean
  /** Почему устройства не достались. null — всё на месте. */
  problem: MediaError | null
}

/** Обёртка над браузерным API: подменяется в тестах. MediaStream тоже здесь —
 * иначе лестницу деградации не проверить вне браузера. */
export interface MediaProvider {
  isSecureContext: boolean
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>
  enumerateDevices(): Promise<MediaDeviceInfo[]>
  createStream(tracks: MediaStreamTrack[]): MediaStream
}

export function browserProvider(): MediaProvider {
  return {
    isSecureContext: globalThis.isSecureContext,
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    enumerateDevices: () => navigator.mediaDevices.enumerateDevices(),
    createStream: (tracks) => new MediaStream(tracks),
  }
}

/**
 * Запрашивает камеру и микрофон. Исключений не бросает: без устройств человек
 * подключится на просмотр.
 *
 * getUserMedia атомарен — нет одного вида, падает весь запрос. Поэтому при
 * неудаче спускаемся по лестнице: без сохранённого устройства, затем по видам.
 */
export async function requestMedia(
  request: MediaRequest,
  provider: MediaProvider = browserProvider(),
): Promise<MediaResult> {
  if (!provider.isSecureContext) {
    return viewerOnly(provider, new MediaError(message('media.insecure'), 'insecure'))
  }

  const video = videoConstraints(request)
  const audio = audioConstraints(request)
  const hasSavedDevice = request.cameraId != null || request.microphoneId != null

  let lastError: unknown
  try {
    return result(await provider.getUserMedia({ video, audio }), [], false, null)
  } catch (error) {
    lastError = error
    if (isFatal(error)) return viewerOnly(provider, translate(error, provider))
  }

  // Сохранённое устройство могли отключить: его id указан как exact, и это
  // единственная причина, по которой запрос падает на исправной машине.
  if (hasSavedDevice) {
    const plain = { preset: request.preset }
    try {
      return result(
        await provider.getUserMedia({
          video: videoConstraints(plain),
          audio: audioConstraints(plain),
        }),
        [],
        true,
        null,
      )
    } catch (error) {
      lastError = error
      if (isFatal(error)) return viewerOnly(provider, translate(error, provider))
    }
  }

  // Пробуем по отдельности: возможно, доступен только один вид устройств.
  const relaxed = hasSavedDevice ? { preset: request.preset } : request
  // Строго по очереди. Два одновременных getUserMedia — это два одновременных
  // запроса разрешения: браузер показывает их по одному, и второй вызов может
  // не завершиться никогда. Заметно это только на свежем профиле, когда
  // разрешения ещё не выданы, — то есть ровно у нового пользователя.
  const wantsVideo = videoConstraints(relaxed) !== false
  const wantsAudio = audioConstraints(relaxed) !== false
  const videoStream = wantsVideo
    ? await attempt(provider, { video: videoConstraints(relaxed), audio: false })
    : null
  const audioStream = wantsAudio
    ? await attempt(provider, { video: false, audio: audioConstraints(relaxed) })
    : null

  if (videoStream === null && audioStream === null) {
    return {
      ...viewerOnly(provider, await translateAsync(lastError, provider)),
      ignoredSavedDevice: hasSavedDevice,
    }
  }

  const tracks = [
    ...(videoStream?.getVideoTracks() ?? []),
    ...(audioStream?.getAudioTracks() ?? []),
  ]
  const missing: MediaKind[] = []
  if (videoStream === null) missing.push('video')
  if (audioStream === null) missing.push('audio')

  return result(provider.createStream(tracks), missing, hasSavedDevice, null)
}

function result(
  stream: MediaStream,
  missing: MediaKind[],
  ignoredSavedDevice: boolean,
  problem: MediaError | null,
): MediaResult {
  return { stream, missing, ignoredSavedDevice, problem }
}

/** Подключение без своих устройств: слушаем и смотрим, сами не передаём. */
function viewerOnly(provider: MediaProvider, problem: MediaError): MediaResult {
  return {
    stream: provider.createStream([]),
    missing: ['video', 'audio'],
    ignoredSavedDevice: false,
    problem,
  }
}

async function attempt(
  provider: MediaProvider,
  constraints: MediaStreamConstraints,
): Promise<MediaStream | null> {
  try {
    return await provider.getUserMedia(constraints)
  } catch (error) {
    const kind = constraints.video === false ? 'микрофон' : 'камера'
    console.debug(`[p2p] ${kind} недоступна:`, error instanceof Error ? error.name : error)
    return null
  }
}

function videoConstraints(request: MediaRequest): MediaTrackConstraints | false {
  if (request.kinds !== undefined && !request.kinds.includes('video')) return false

  const constraints: MediaTrackConstraints = { ...presetToConstraints(request.preset) }
  if (request.cameraId != null) constraints.deviceId = { exact: request.cameraId }
  return constraints
}

function audioConstraints(request: MediaRequest): MediaTrackConstraints | false {
  if (request.kinds !== undefined && !request.kinds.includes('audio')) return false

  const constraints: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true }
  if (request.microphoneId != null) constraints.deviceId = { exact: request.microphoneId }
  return constraints
}

/** Отказ в доступе повторять бессмысленно: пользователь уже сказал «нет». */
function isFatal(error: unknown): boolean {
  const name = error instanceof Error ? error.name : ''
  return name === 'NotAllowedError' || name === 'SecurityError'
}

/**
 * Добавляет к объяснению перепись устройств.
 *
 * «Камер не найдено, микрофонов 1» снимает почти все вопросы: сразу видно, дело
 * в железе или в разрешениях. Перепись едет в `details` отдельным сообщением —
 * интерфейс покажет её следом за основным текстом.
 */
async function translateAsync(error: unknown, provider: MediaProvider): Promise<MediaError> {
  const base = translate(error, provider)

  try {
    const devices = await provider.enumerateDevices()
    const cameras = devices.filter((device) => device.kind === 'videoinput').length
    const microphones = devices.filter((device) => device.kind === 'audioinput').length

    return new MediaError(
      base.text,
      base.kind,
      message('media.deviceCount', { cameras, microphones }),
    )
  } catch {
    return base
  }
}

function translate(error: unknown, provider: MediaProvider): MediaError {
  const name = error instanceof Error ? error.name : ''

  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new MediaError(message('media.denied'), 'denied')

    case 'NotFoundError':
      return new MediaError(message('media.absent'), 'absent')

    case 'OverconstrainedError':
      return new MediaError(message('media.overconstrained'), 'overconstrained')

    case 'NotReadableError':
    case 'AbortError':
      return new MediaError(message('media.busy'), 'busy')

    default:
      return provider.enumerateDevices === undefined
        ? new MediaError(message('media.unsupported'), 'unsupported')
        : new MediaError(message('media.unknown'), 'unknown')
  }
}

/**
 * Список устройств. Ярлыки браузер отдаёт только после выданного разрешения,
 * поэтому вызывать имеет смысл уже после requestMedia.
 */
export async function listDevices(provider: MediaProvider = browserProvider()): Promise<DeviceList> {
  let devices: MediaDeviceInfo[]
  try {
    devices = await provider.enumerateDevices()
  } catch {
    return { cameras: [], microphones: [] }
  }

  // Нумерация идёт внутри своего вида: «Камера 2» должна быть второй камерой,
  // а не вторым устройством вообще.
  const pick = (kind: MediaDeviceKind, fallbackKey: string): DeviceOption[] =>
    devices
      .filter((device) => device.kind === kind)
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label.length > 0 ? device.label : message(fallbackKey, { index: index + 1 }),
      }))

  return {
    cameras: pick('videoinput', 'devices.cameraFallback'),
    microphones: pick('audioinput', 'devices.microphoneFallback'),
  }
}

/** Что показать пользователю, если часть устройств не досталась. */
export function describeMissing(missing: MediaKind[]): Message | null {
  if (missing.length === 0) return null
  if (missing.includes('video') && missing.includes('audio')) {
    return message('media.missing.both')
  }

  return missing[0] === 'video' ? message('media.missing.video') : message('media.missing.audio')
}

/** Применяет пресет качества на лету — ренеготиация не требуется. */
export async function applyQuality(
  connection: RTCPeerConnection,
  stream: MediaStream,
  preset: QualityPreset,
): Promise<void> {
  const [track] = stream.getVideoTracks()
  if (track !== undefined) {
    try {
      await track.applyConstraints(presetToConstraints(preset))
    } catch (error) {
      // Камера может не уметь запрошенный режим — звонок из-за этого рвать
      // незачем, но молчать нельзя: именно здесь теряется разрешение.
      console.debug('[p2p] камера отказала в режиме:', error instanceof Error ? error.name : error)
    }

    const settings = track.getSettings()
    console.debug(
      `[p2p] камера отдаёт ${settings.width}x${settings.height}@${settings.frameRate}` +
        ` (просили ${preset})`,
    )
  }

  const sender = connection.getSenders().find((candidate) => candidate.track?.kind === 'video')
  if (sender === undefined) return

  const parameters = sender.getParameters()
  const [wanted] = presetToEncodings(preset)

  parameters.encodings = (parameters.encodings ?? [{}]).map((encoding) => ({
    ...encoding,
    ...wanted,
  }))
  // degradationPreference намеренно не трогаем: «держать разрешение» лечит
  // мыло ценой рывков, а «держать плавность» — наоборот. Что именно жертвовать,
  // видно только по статистике, поэтому сначала измеряем.
  try {
    await sender.setParameters(parameters)
  } catch (error) {
    console.debug('[p2p] параметры отправителя не приняты:', error instanceof Error ? error.name : error)
  }
}

/** Останавливает все дорожки — иначе индикатор камеры останется гореть. */
export function stopStream(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) track.stop()
}
