import { beforeEach, describe, expect, it, vi } from 'vitest'
import { attachAll, detachAll } from '../../src/call/transform.js'
import type { MediaKeys } from '../../src/crypto/kdf.js'

/** Ключи здесь не используются по назначению — важно лишь, что они различимы. */
const KEYS = {
  audio: { send: 'audio-send', recv: 'audio-recv' },
  video: { send: 'video-send', recv: 'video-recv' },
} as unknown as MediaKeys

interface FakeEndpoint {
  transform?: unknown
  track: { kind: string } | null
  getParameters(): { codecs: { mimeType: string }[] }
}

function endpoint(kind: string | null): FakeEndpoint {
  return {
    track: kind === null ? null : { kind },
    getParameters: () => ({ codecs: [{ mimeType: 'video/VP8' }] }),
  }
}

/** Трансивер знает тип дорожки всегда, даже когда отправлять пока нечего. */
function transceiver(kind: string, sendTrack: string | null = kind) {
  return { sender: endpoint(sendTrack), receiver: endpoint(kind) }
}

function connectionOf(transceivers: ReturnType<typeof transceiver>[]): RTCPeerConnection {
  return {
    getTransceivers: () => transceivers,
    getSenders: () => transceivers.map((item) => item.sender),
    getReceivers: () => transceivers.map((item) => item.receiver),
  } as unknown as RTCPeerConnection
}

const worker = {} as Worker

beforeEach(() => {
  class ScriptTransform {
    constructor(
      readonly worker: Worker,
      readonly options: unknown,
    ) {}
  }
  vi.stubGlobal('window', { RTCRtpScriptTransform: ScriptTransform })
  vi.stubGlobal('RTCRtpScriptTransform', ScriptTransform)
})

function optionsOf(endpoint: FakeEndpoint): Record<string, unknown> {
  return (endpoint.transform as { options: Record<string, unknown> }).options
}

describe('attachAll', () => {
  it('шифрует и отправку, и приём каждой дорожки', () => {
    const audio = transceiver('audio')
    const video = transceiver('video')
    expect(attachAll(worker, connectionOf([audio, video]), KEYS)).toBe(true)

    expect(optionsOf(audio.sender)).toMatchObject({ kind: 'audio', direction: 'send' })
    expect(optionsOf(audio.receiver)).toMatchObject({ kind: 'audio', direction: 'recv' })
    expect(optionsOf(video.sender)).toMatchObject({ kind: 'video', direction: 'send' })
    expect(optionsOf(video.receiver)).toMatchObject({ kind: 'video', direction: 'recv' })
  })

  it('берёт для каждого конца свой ключ: send одной стороны идёт в recv другой', () => {
    const audio = transceiver('audio')
    attachAll(worker, connectionOf([audio]), KEYS)

    expect(optionsOf(audio.sender)['keys']).toBe('audio-send')
    expect(optionsOf(audio.receiver)['keys']).toBe('audio-recv')
  })

  it('шифрует отправителя без дорожки: её подставят позже, и она не должна уйти открытой', () => {
    // Обычное начало звонка: камеры нет вовсе, микрофон включат через минуту.
    // Пока отправитель пуст, тип известен только по трансиверу.
    const video = transceiver('video', null)
    expect(attachAll(worker, connectionOf([video]), KEYS)).toBe(true)

    expect(optionsOf(video.sender)).toMatchObject({ kind: 'video', direction: 'send' })
  })

  it('разводит аудио и видео по разным потокам, иначе счётчики nonce столкнутся', () => {
    const audio = transceiver('audio')
    const video = transceiver('video')
    attachAll(worker, connectionOf([audio, video]), KEYS)

    expect(optionsOf(audio.sender)['streamId']).not.toBe(optionsOf(video.sender)['streamId'])
  })

  it('сообщает о неудаче, а не молчит: молчание здесь равно открытому тексту', () => {
    vi.stubGlobal('window', {})
    vi.stubGlobal('RTCRtpSender', { prototype: {} })
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(attachAll(worker, connectionOf([transceiver('audio')]), KEYS)).toBe(false)
  })

  it('не падает, когда браузер отказал одному концу, и продолжает с остальными', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const audio = transceiver('audio')
    const video = transceiver('video')
    Object.defineProperty(audio.sender, 'transform', {
      set() {
        throw new Error('endpoint is closed')
      },
      get() {
        return undefined
      },
    })

    expect(attachAll(worker, connectionOf([audio, video]), KEYS)).toBe(false)
    expect(optionsOf(video.sender)).toMatchObject({ kind: 'video' })
  })

  it('пропускает трансиверы без дорожки на приёме — тип там взять неоткуда', () => {
    const unknown = { sender: endpoint(null), receiver: endpoint(null) }
    expect(attachAll(worker, connectionOf([unknown]), KEYS)).toBe(true)
    expect(unknown.sender.transform).toBeUndefined()
  })
})

describe('detachAll', () => {
  it('снимает трансформ с обоих концов', () => {
    const audio = transceiver('audio')
    const connection = connectionOf([audio])
    attachAll(worker, connection, KEYS)
    detachAll(connection)

    expect(audio.sender.transform).toBeNull()
    expect(audio.receiver.transform).toBeNull()
  })
})
