import { afterEach, describe, expect, it, vi } from 'vitest'
import { restrictVideoCodecs } from '../../src/call/peer.js'

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

describe('restrictVideoCodecs', () => {
  it('оставляет VP8 и служебные кодеки, убирая те, чью разметку мы не разбираем', () => {
    // H.264 несёт NAL-юниты: зашифровав их, мы отдаём пакетизатору мусор, кадр
    // приезжает другой длины, и GCM отвергает подряд всё.
    capabilities(['video/H264', 'video/VP8', 'video/VP9', 'video/rtx', 'video/AV1'])
    const video = transceiver('video')

    expect(restrictVideoCodecs(connectionOf([video]))).toBe(true)
    expect(video.preferences?.map((codec) => codec.mimeType)).toEqual(['video/VP8', 'video/rtx'])
  })

  it('не трогает аудио: у opus разметка своя и она нам подходит', () => {
    capabilities(['video/VP8'])
    const audio = transceiver('audio')

    restrictVideoCodecs(connectionOf([audio]))
    expect(audio.preferences).toBeUndefined()
  })

  it('сообщает о неудаче, когда VP8 в списке нет вовсе', () => {
    capabilities(['video/H264'])
    expect(restrictVideoCodecs(connectionOf([transceiver('video')]))).toBe(false)
  })

  it('переживает браузер без выбора кодеков', () => {
    vi.stubGlobal('RTCRtpReceiver', {})
    expect(restrictVideoCodecs(connectionOf([transceiver('video')]))).toBe(false)
  })

  it('не падает, когда браузер отверг предпочтение', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    capabilities(['video/VP8'])

    expect(restrictVideoCodecs(connectionOf([transceiver('video', true)]))).toBe(false)
  })
})
