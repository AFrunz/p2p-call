import { describe, expect, it } from 'vitest'
import { MediaError, describeMissing, listDevices, requestMedia } from '../../src/call/media.js'
import type { MediaKind, MediaProvider } from '../../src/call/media.js'
import { LOCALES, dictionary } from '../../src/i18n/index.js'
import type { Message } from '../../src/i18n/message.js'

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
    // Перепись устройств отличает «нет железа» от «не дали разрешение», поэтому
    // она обязана доехать до интерфейса — отдельным сообщением с подстановками.
    const devices = [{ kind: 'audioinput' } as MediaDeviceInfo]
    const result = await requestMedia({ preset: 'auto' }, provider({ available: [], devices }))

    expect(result.problem?.details).toEqual({
      key: 'media.deviceCount',
      params: { cameras: 0, microphones: 1 },
    })
  })

  it('не теряет причину, добавляя перепись устройств', async () => {
    const devices = [{ kind: 'audioinput' } as MediaDeviceInfo]
    const result = await requestMedia({ preset: 'auto' }, provider({ available: [], devices }))

    expect(result.problem?.text.key).toBe('media.absent')
    expect(result.problem?.kind).toBe('absent')
  })

  it('переживает провал перечисления устройств и всё равно объясняет причину', async () => {
    const fake = provider({ available: [] })
    fake.enumerateDevices = () => Promise.reject(new Error('нет'))
    const result = await requestMedia({ preset: 'auto' }, fake)

    expect(result.problem?.text.key).toBe('media.absent')
    expect(result.problem?.details).toBeNull()
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

  it('объясняет отказ отдельным сообщением про разрешения', async () => {
    // Текст живёт в словаре: тесту важно, что взят ключ именно про отказ,
    // а не про «устройств не нашлось».
    const result = await requestMedia({ preset: 'auto' }, provider({ always: 'NotAllowedError' }))
    expect(result.problem?.text.key).toBe('media.denied')
  })

  it('отдельно объясняет занятое устройство', async () => {
    const result = await requestMedia({ preset: 'auto' }, provider({ always: 'NotReadableError' }))

    expect(result.problem?.kind).toBe('busy')
    expect(result.problem?.text.key).toBe('media.busy')
  })

  it('устройство, пропавшее из системы, объясняет по-своему', async () => {
    const result = await requestMedia(
      { preset: 'auto' },
      provider({ always: 'OverconstrainedError' }),
    )

    expect(result.problem?.kind).toBe('overconstrained')
    expect(result.problem?.text.key).toBe('media.overconstrained')
  })

  it('на незащищённой странице не падает, а объясняет и пускает смотреть', async () => {
    const result = await requestMedia({ preset: 'auto' }, provider({ secure: false }))

    expect(result.problem?.kind).toBe('insecure')
    expect(result.problem?.text.key).toBe('media.insecure')
    expect(result.stream.getTracks()).toHaveLength(0)
  })

  it('оставляет в самой ошибке осмысленную строку для логов', async () => {
    const result = await requestMedia({ preset: 'auto' }, provider({ always: 'NotAllowedError' }))

    expect(result.problem).toBeInstanceOf(Error)
    expect(result.problem?.message).toBe('media.denied')
  })
})

describe('listDevices', () => {
  it('подставляет подпись, пока браузер не отдал название', () => {
    const devices = [
      { kind: 'videoinput', deviceId: 'cam-1', label: '' },
      { kind: 'audioinput', deviceId: 'mic-1', label: 'Гарнитура' },
    ] as MediaDeviceInfo[]

    return listDevices(provider({ devices })).then((list) => {
      // Своё имя устройства переводить нечего — оно уходит строкой как есть,
      // а безымянному достаётся ключ с номером.
      expect(list.cameras[0]?.label).toEqual({
        key: 'devices.cameraFallback',
        params: { index: 1 },
      })
      expect(list.microphones[0]?.label).toBe('Гарнитура')
    })
  })

  it('нумерует безымянные устройства внутри своего вида', async () => {
    const devices = [
      { kind: 'videoinput', deviceId: 'cam-1', label: '' },
      { kind: 'audioinput', deviceId: 'mic-1', label: '' },
      { kind: 'videoinput', deviceId: 'cam-2', label: '' },
    ] as MediaDeviceInfo[]

    const list = await listDevices(provider({ devices }))

    expect(list.cameras.map((option) => option.label)).toEqual([
      { key: 'devices.cameraFallback', params: { index: 1 } },
      { key: 'devices.cameraFallback', params: { index: 2 } },
    ])
    expect(list.microphones[0]?.label).toEqual({
      key: 'devices.microphoneFallback',
      params: { index: 1 },
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

  it('различает пропавшую камеру и пропавший микрофон', () => {
    expect(describeMissing(['video'])).toEqual({ key: 'media.missing.video' })
    expect(describeMissing(['audio'])).toEqual({ key: 'media.missing.audio' })
  })

  it('про полное отсутствие устройств говорит отдельным сообщением', () => {
    // Отдельный ключ, а не два подряд: это не две поломки, а режим просмотра.
    expect(describeMissing(['video', 'audio'])).toEqual({ key: 'media.missing.both' })
    expect(describeMissing(['audio', 'video'])).toEqual({ key: 'media.missing.both' })
  })
})

/**
 * Ключи собираются прогоном самого модуля, а не переписываются в тест руками:
 * список, набранный вручную, протухает на первом же новом сообщении.
 */
async function usedMessages(): Promise<Message[]> {
  const problems: (MediaError | null)[] = []
  for (const always of [
    'NotAllowedError',
    'SecurityError',
    'NotFoundError',
    'OverconstrainedError',
    'NotReadableError',
    'AbortError',
    'ЧтоТоНовое',
  ]) {
    problems.push((await requestMedia({ preset: 'auto' }, provider({ always }))).problem)
  }
  problems.push((await requestMedia({ preset: 'auto' }, provider({ secure: false }))).problem)
  problems.push(
    (await requestMedia({ preset: 'auto' }, provider({ available: [], devices: [] }))).problem,
  )

  // Браузер без mediaDevices: единственный путь к 'media.unsupported'.
  const ancient = { ...provider({ always: 'ЧтоТоНовое' }), enumerateDevices: undefined }
  problems.push(
    (await requestMedia({ preset: 'auto' }, ancient as unknown as MediaProvider)).problem,
  )

  const devices = [
    { kind: 'videoinput', deviceId: 'cam-1', label: '' },
    { kind: 'audioinput', deviceId: 'mic-1', label: '' },
  ] as MediaDeviceInfo[]
  const list = await listDevices(provider({ devices }))

  const missing: MediaKind[][] = [['video'], ['audio'], ['video', 'audio']]

  return [
    ...problems.flatMap((problem) =>
      problem === null ? [] : [problem.text, ...(problem.details === null ? [] : [problem.details])],
    ),
    ...missing.flatMap((kinds) => describeMissing(kinds) ?? []),
    ...[...list.cameras, ...list.microphones].flatMap((option) =>
      typeof option.label === 'string' ? [] : [option.label],
    ),
  ]
}

describe('сообщения модуля', () => {
  it('ссылаются только на ключи, которые есть во всех словарях', async () => {
    const keys = [...new Set((await usedMessages()).map((item) => item.key))]
    expect(keys.length).toBeGreaterThan(0)

    for (const locale of LOCALES) {
      const dict = dictionary(locale)
      expect(
        keys.filter((key) => dict[key] === undefined),
        `нет в ${locale}`,
      ).toEqual([])
    }
  })

  it('передают подстановки, которые словарь ожидает', async () => {
    // Незаполненный плейсхолдер видно в интерфейсе как «{index}» — проверяем,
    // что модуль отдаёт ровно те имена, что стоят в тексте.
    const dict = dictionary('ru')

    for (const item of await usedMessages()) {
      const template = dict[item.key] ?? ''
      const expected = [...template.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((match) => match[1])
      expect(Object.keys(item.params ?? {}).sort(), item.key).toEqual(expected.sort())
    }
  })

  it('просит только нужный вид устройства, когда дорожку досдают в живой звонок', async () => {
    // Включая микрофон, незачем зажигать камеру: индикатор загорится, батарея
    // сядет, а на машине без камеры запрос ещё и споткнётся о её отсутствие.
    const fake = provider()
    await requestMedia({ preset: 'auto', kinds: ['audio'] }, fake)

    expect(fake.calls.length).toBeGreaterThan(0)
    for (const constraints of fake.calls) {
      expect(constraints.video).toBe(false)
    }
  })

  it('на запрос одного вида не отдаёт дорожки другого', async () => {
    const media = await requestMedia({ preset: 'auto', kinds: ['video'] }, provider())

    expect(media.stream.getVideoTracks()).toHaveLength(1)
    expect(media.stream.getAudioTracks()).toHaveLength(0)
  })
})
