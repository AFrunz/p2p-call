import { afterEach, describe, expect, it, vi } from 'vitest'
import { preferFrameSafeVideo } from '../../src/call/peer.js'

interface CodecCapability {
  mimeType: string
  clockRate: number
}

interface FakeTransceiver {
  receiver: { track: { kind: string } | null }
  preferences?: CodecCapability[]
  setCodecPreferences?: (codecs: CodecCapability[]) => void
}

function transceiver(kind: string | null, broken = false): FakeTransceiver {
  const item: FakeTransceiver = { receiver: { track: kind === null ? null : { kind } } }
  item.setCodecPreferences = (codecs) => {
    if (broken) throw new Error('InvalidAccessError')
    item.preferences = codecs
  }
  return item
}

function connectionOf(transceivers: FakeTransceiver[]): RTCPeerConnection {
  return { getTransceivers: () => transceivers } as unknown as RTCPeerConnection
}

function capabilities(mimeTypes: string[]): void {
  vi.stubGlobal('RTCRtpReceiver', {
    getCapabilities: () => ({ codecs: mimeTypes.map((mimeType) => ({ mimeType, clockRate: 90000 })) }),
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('preferFrameSafeVideo', () => {
  it('ставит вперёд VP8 и служебные кодеки', () => {
    // H.264 несёт NAL-юниты: зашифровав их, мы отдаём пакетизатору мусор, кадр
    // приезжает другой длины, и GCM отвергает подряд всё.
    capabilities(['video/H264', 'video/VP8', 'video/VP9', 'video/rtx', 'video/AV1'])
    const video = transceiver('video')

    expect(preferFrameSafeVideo(connectionOf([video]))).toBe(true)
    expect(video.preferences?.map((codec) => codec.mimeType)).toEqual([
      'video/VP8',
      'video/rtx',
      'video/H264',
      'video/VP9',
      'video/AV1',
    ])
  })

  it('не вычёркивает остальные: без общего кодека звонок не состоится вовсе', () => {
    capabilities(['video/H264', 'video/VP8'])
    const video = transceiver('video')

    preferFrameSafeVideo(connectionOf([video]))
    expect(video.preferences).toHaveLength(2)
  })

  it('не трогает аудио: у opus разметка своя и она нам подходит', () => {
    capabilities(['video/VP8'])
    const audio = transceiver('audio')

    preferFrameSafeVideo(connectionOf([audio]))
    expect(audio.preferences).toBeUndefined()
  })

  it('сообщает о неудаче, когда VP8 в списке нет вовсе', () => {
    capabilities(['video/H264'])
    expect(preferFrameSafeVideo(connectionOf([transceiver('video')]))).toBe(false)
  })

  it('переживает браузер без выбора кодеков', () => {
    vi.stubGlobal('RTCRtpReceiver', {})
    expect(preferFrameSafeVideo(connectionOf([transceiver('video')]))).toBe(false)
  })

  it('не падает, когда браузер отверг предпочтение', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    capabilities(['video/VP8'])

    expect(preferFrameSafeVideo(connectionOf([transceiver('video', true)]))).toBe(false)
  })
})
