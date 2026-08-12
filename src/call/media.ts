import { presetToConstraints, presetToEncodings } from '../media/quality.js'
import type { QualityPreset } from '../media/quality.js'

export interface DeviceOption {
  deviceId: string
  label: string
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

export class MediaError extends Error {
  constructor(
    message: string,
    readonly kind: MediaFailure,
  ) {
    super(message)
    this.name = 'MediaError'
  }
}

export interface MediaRequest {
  preset: QualityPreset
  cameraId?: string | null
  microphoneId?: string | null
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

/**
 * Обёртка над браузерным API: подменяется в тестах.
 *
 * Создание потока тоже здесь — MediaStream существует только в браузере, и без
 * этого лестницу деградации было бы не проверить вне него.
 */
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
 * Запрашивает камеру и микрофон.
 *
 * Никогда не бросает исключений: отсутствие устройств не повод не пустить
 * человека в звонок. Без камеры и микрофона он подключится на просмотр — это
 * рабочий сценарий, а не ошибка.
 *
 * getUserMedia атомарен: если попросить видео и звук сразу, а на машине есть
 * только одно из двух, упадёт весь запрос — с NotFoundError, будто нет ничего.
 * Поэтому при неудаче спускаемся по лестнице: снимаем привязку к сохранённому
 * устройству, затем пробуем каждый вид отдельно.
 */
export async function requestMedia(
  request: MediaRequest,
  provider: MediaProvider = browserProvider(),
): Promise<MediaResult> {
  if (!provider.isSecureContext) {
    return viewerOnly(
      provider,
      new MediaError(
        'Браузер выдаёт камеру только на HTTPS или localhost. Сейчас вы сможете только смотреть и слушать.',
        'insecure',
      ),
    )
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
  const [videoStream, audioStream] = await Promise.all([
    attempt(provider, { video: videoConstraints(relaxed), audio: false }),
    attempt(provider, { video: false, audio: audioConstraints(relaxed) }),
  ])

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
  } catch {
    return null
  }
}

function videoConstraints(request: MediaRequest): MediaTrackConstraints {
  const constraints: MediaTrackConstraints = { ...presetToConstraints(request.preset) }
  if (request.cameraId != null) constraints.deviceId = { exact: request.cameraId }
  return constraints
}

function audioConstraints(request: MediaRequest): MediaTrackConstraints {
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
 * Добавляет к сообщению перепись устройств.
 *
 * «Камер не найдено, микрофонов 1» снимает почти все вопросы: сразу видно, дело
 * в железе или в разрешениях.
 */
async function translateAsync(error: unknown, provider: MediaProvider): Promise<MediaError> {
  const base = translate(error, provider)

  try {
    const devices = await provider.enumerateDevices()
    const cameras = devices.filter((device) => device.kind === 'videoinput').length
    const microphones = devices.filter((device) => device.kind === 'audioinput').length

    return new MediaError(`${base.message} Браузер видит камер: ${cameras}, микрофонов: ${microphones}.`, base.kind)
  } catch {
    return base
  }
}

function translate(error: unknown, provider: MediaProvider): MediaError {
  const name = error instanceof Error ? error.name : ''

  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new MediaError(
        'Браузер не пустил к камере и микрофону. Проверьте разрешение в адресной строке, ' +
          'а на macOS ещё и доступ браузера к камере в настройках системы.',
        'denied',
      )

    case 'NotFoundError':
      return new MediaError(
        'Ни камеры, ни микрофона не нашлось. Проверьте, что устройство подключено и не отключено в системе.',
        'absent',
      )

    case 'OverconstrainedError':
      return new MediaError(
        'Выбранное устройство больше недоступно. Откройте настройки и выберите камеру и микрофон заново.',
        'overconstrained',
      )

    case 'NotReadableError':
    case 'AbortError':
      return new MediaError(
        'Камера или микрофон заняты другой программой. Закройте её — на Windows это чаще всего Zoom или Teams — и попробуйте снова.',
        'busy',
      )

    default:
      return provider.enumerateDevices === undefined
        ? new MediaError('Этот браузер не умеет отдавать камеру и микрофон.', 'unsupported')
        : new MediaError('Не удалось получить камеру и микрофон.', 'unknown')
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

  const pick = (kind: MediaDeviceKind, fallback: string): DeviceOption[] =>
    devices
      .filter((device) => device.kind === kind)
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label.length > 0 ? device.label : `${fallback} ${index + 1}`,
      }))

  return {
    cameras: pick('videoinput', 'Камера'),
    microphones: pick('audioinput', 'Микрофон'),
  }
}

/** Что показать пользователю, если часть устройств не досталась. */
export function describeMissing(missing: MediaKind[]): string | null {
  if (missing.length === 0) return null
  if (missing.includes('video') && missing.includes('audio')) {
    return 'Ни камеры, ни микрофона нет — вы подключитесь только на просмотр.'
  }

  return missing[0] === 'video'
    ? 'Камера недоступна — собеседник будет только слышать вас.'
    : 'Микрофон недоступен — собеседник будет только видеть вас.'
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
    } catch {
      // Камера может не уметь запрошенный режим: это не повод рвать звонок,
      // ограничения на отправителе всё равно применятся.
    }
  }

  const sender = connection.getSenders().find((candidate) => candidate.track?.kind === 'video')
  if (sender === undefined) return

  const parameters = sender.getParameters()
  const [wanted] = presetToEncodings(preset)

  parameters.encodings = (parameters.encodings ?? [{}]).map((encoding) => ({
    ...encoding,
    ...wanted,
  }))
  await sender.setParameters(parameters)
}

/** Останавливает все дорожки — иначе индикатор камеры останется гореть. */
export function stopStream(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) track.stop()
}
