import { describe, expect, it } from 'vitest'
import { MediaError, describeMissing, listDevices, requestMedia } from '../../src/call/media.js'
import type { MediaProvider } from '../../src/call/media.js'

/** Заглушка дорожки: настоящий MediaStreamTrack в node недоступен. */
function track(kind: 'audio' | 'video'): MediaStreamTrack {
  return { kind, enabled: true, stop() {} } as unknown as MediaStreamTrack
}

/** Заглушка потока — ровно с теми методами, которыми пользуется код. */
function stream(kinds: ('audio' | 'video')[]): MediaStream {
  const tracks = kinds.map(track)
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((item) => item.kind === 'audio'),
    getVideoTracks: () => tracks.filter((item) => item.kind === 'video'),
  } as unknown as MediaStream
}

function fail(name: string): DOMException {
  return new DOMException(name, name)
}

interface FakeOptions {
  /** Какие виды устройств есть на «машине». */
  available?: ('audio' | 'video')[]
  /** Идентификаторы устройств, которые ещё подключены. */
  knownIds?: string[]
  /** Ошибка, которой падает любой запрос. */
  always?: string
  devices?: MediaDeviceInfo[]
  secure?: boolean
}

/** Провайдер, ведущий себя как getUserMedia: атомарно и с теми же ошибками. */
function provider(options: FakeOptions = {}): MediaProvider & { calls: MediaStreamConstraints[] } {
  const available = options.available ?? ['audio', 'video']
  const calls: MediaStreamConstraints[] = []

  return {
    calls,
    isSecureContext: options.secure ?? true,
    createStream: (tracks) =>
      ({
        getTracks: () => tracks,
        getAudioTracks: () => tracks.filter((item) => item.kind === 'audio'),
        getVideoTracks: () => tracks.filter((item) => item.kind === 'video'),
      }) as unknown as MediaStream,
    async enumerateDevices() {
      return options.devices ?? []
    },
    async getUserMedia(constraints) {
      calls.push(constraints)
      if (options.always !== undefined) throw fail(options.always)

      const wanted: ('audio' | 'video')[] = []
      if (constraints.video !== false && constraints.video !== undefined) wanted.push('video')
      if (constraints.audio !== false && constraints.audio !== undefined) wanted.push('audio')

      for (const kind of wanted) {
        const requested = constraints[kind]
        const exact =
          typeof requested === 'object' && requested !== null
            ? (requested as { deviceId?: { exact?: string } }).deviceId?.exact
            : undefined

        if (exact !== undefined && !(options.knownIds ?? []).includes(exact)) {
          throw fail('OverconstrainedError')
        }
        // getUserMedia атомарен: нет одного вида — падает весь запрос.
        if (!available.includes(kind)) throw fail('NotFoundError')
      }

      return stream(wanted)
    },
  }
}

describe('requestMedia на исправной машине', () => {
  it('берёт камеру и микрофон одним запросом', async () => {
    const fake = provider()
    const result = await requestMedia({ preset: 'auto' }, fake)

    expect(result.missing).toEqual([])
    expect(result.stream.getTracks()).toHaveLength(2)
    expect(fake.calls).toHaveLength(1)
  })
})

describe('requestMedia при неполном наборе устройств', () => {
  it('отдаёт звонок без камеры, когда камеры нет', async () => {
    // Ровно этот случай раньше выглядел как «устройство не подключено»,
    // хотя микрофон был на месте.
    const result = await requestMedia({ preset: 'auto' }, provider({ available: ['audio'] }))

    expect(result.missing).toEqual(['video'])
    expect(result.stream.getAudioTracks()).toHaveLength(1)
    expect(result.stream.getVideoTracks()).toHaveLength(0)
  })

  it('отдаёт звонок без микрофона, когда микрофона нет', async () => {
    const result = await requestMedia({ preset: 'auto' }, provider({ available: ['video'] }))

    expect(result.missing).toEqual(['audio'])
    expect(result.stream.getVideoTracks()).toHaveLength(1)
  })

  it('без устройств вообще пускает в звонок на просмотр, а не отказывает', async () => {
    // Слушатель без камеры и микрофона — законный участник разговора.
    const result = await requestMedia({ preset: 'auto' }, provider({ available: [] }))

    expect(result.stream.getTracks()).toHaveLength(0)
    expect(result.missing).toEqual(['video', 'audio'])
    expect(result.problem).toBeInstanceOf(MediaError)
  })

  it('в объяснении перечисляет, что видит браузер', async () => {
    const devices = [{ kind: 'audioinput' } as MediaDeviceInfo]
    const result = await requestMedia({ preset: 'auto' }, provider({ available: [], devices }))

    expect(result.problem?.message).toContain('камер: 0')
    expect(result.problem?.message).toContain('микрофонов: 1')
  })
})

describe('requestMedia с сохранённым устройством', () => {
  it('использует сохранённое устройство, пока оно подключено', async () => {
    const fake = provider({ knownIds: ['cam-1', 'mic-1'] })
    const result = await requestMedia(
      { preset: 'auto', cameraId: 'cam-1', microphoneId: 'mic-1' },
      fake,
    )

    expect(result.ignoredSavedDevice).toBe(false)
    expect(result.missing).toEqual([])
  })

  it('забывает отключённое устройство вместо того, чтобы сдаться', async () => {
    // Классика: камеру из настроек отключили, exact deviceId больше не
    // существует, и запрос падает на совершенно исправной машине.
    const fake = provider({ knownIds: [] })
    const result = await requestMedia(
      { preset: 'auto', cameraId: 'исчезнувшая-камера', microphoneId: 'исчезнувший-микрофон' },
      fake,
    )

    expect(result.ignoredSavedDevice).toBe(true)
    expect(result.missing).toEqual([])
    expect(result.stream.getTracks()).toHaveLength(2)
  })
})

describe('requestMedia при отказе в доступе', () => {
  it('не долбится повторно, когда пользователь запретил доступ', async () => {
    const fake = provider({ always: 'NotAllowedError' })
    const result = await requestMedia({ preset: 'auto' }, fake)

    expect(result.problem?.kind).toBe('denied')
    expect(fake.calls, 'после отказа переспрашивать бессмысленно').toHaveLength(1)
  })

  it('после отказа всё равно пускает смотреть', async () => {
    const result = await requestMedia({ preset: 'auto' }, provider({ always: 'NotAllowedError' }))
    expect(result.stream.getTracks()).toHaveLength(0)
  })

  it('подсказывает про системные настройки, а не только про адресную строку', async () => {
    const result = await requestMedia({ preset: 'auto' }, provider({ always: 'NotAllowedError' }))
    expect(result.problem?.message).toMatch(/систем/i)
  })

  it('отдельно объясняет занятое устройство', async () => {
    const result = await requestMedia({ preset: 'auto' }, provider({ always: 'NotReadableError' }))

    expect(result.problem?.kind).toBe('busy')
    expect(result.problem?.message).toMatch(/занят/i)
  })

  it('на незащищённой странице не падает, а объясняет и пускает смотреть', async () => {
    const result = await requestMedia({ preset: 'auto' }, provider({ secure: false }))

    expect(result.problem?.kind).toBe('insecure')
    expect(result.stream.getTracks()).toHaveLength(0)
  })
})

describe('listDevices', () => {
  it('подставляет подпись, пока браузер не отдал название', () => {
    const devices = [
      { kind: 'videoinput', deviceId: 'cam-1', label: '' },
      { kind: 'audioinput', deviceId: 'mic-1', label: 'Гарнитура' },
    ] as MediaDeviceInfo[]

    return listDevices(provider({ devices })).then((list) => {
      expect(list.cameras[0]?.label).toBe('Камера 1')
      expect(list.microphones[0]?.label).toBe('Гарнитура')
    })
  })

  it('не падает, если перечислить устройства не вышло', async () => {
    const broken: MediaProvider = {
      isSecureContext: true,
      createStream: () => ({}) as MediaStream,
      getUserMedia: () => Promise.reject(new Error('нет')),
      enumerateDevices: () => Promise.reject(new Error('нет')),
    }
    expect(await listDevices(broken)).toEqual({ cameras: [], microphones: [] })
  })
})

describe('describeMissing', () => {
  it('молчит, когда всё на месте', () => {
    expect(describeMissing([])).toBeNull()
  })

  it('объясняет последствия, а не просто называет пропажу', () => {
    expect(describeMissing(['video'])).toMatch(/слышать/)
    expect(describeMissing(['audio'])).toMatch(/видеть/)
  })

  it('про полное отсутствие устройств говорит как о режиме, а не как об ошибке', () => {
    expect(describeMissing(['video', 'audio'])).toMatch(/просмотр/)
  })
})
