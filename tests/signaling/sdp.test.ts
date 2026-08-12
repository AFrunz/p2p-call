import { describe, expect, it } from 'vitest'
import {
  extractFingerprint,
  extractIceUfrag,
  parseCandidateLine,
  parseCandidates,
} from '../../src/signaling/sdp.js'
import {
  OFFER_FINGERPRINT_HEX,
  OFFER_SDP,
  SDP_WITHOUT_FINGERPRINT,
  SDP_WITH_SHA1_FINGERPRINT,
} from '../fixtures/sdp.js'

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

describe('extractFingerprint', () => {
  it('достаёт 32 байта SHA-256', () => {
    const fingerprint = extractFingerprint(OFFER_SDP)
    expect(fingerprint).not.toBeNull()
    expect(fingerprint!.length).toBe(32)
    expect(toHex(fingerprint!)).toBe(OFFER_FINGERPRINT_HEX)
  })

  it('возвращает null, если отпечатка нет — без него не посчитать SAS', () => {
    expect(extractFingerprint(SDP_WITHOUT_FINGERPRINT)).toBeNull()
  })

  it('не принимает SHA-1: слабый хеш нельзя молча использовать для сверки', () => {
    expect(extractFingerprint(SDP_WITH_SHA1_FINGERPRINT)).toBeNull()
  })

  it('переживает SDP с переводами строк CRLF', () => {
    const crlf = OFFER_SDP.replace(/\n/g, '\r\n')
    expect(toHex(extractFingerprint(crlf)!)).toBe(OFFER_FINGERPRINT_HEX)
  })
})

describe('extractIceUfrag', () => {
  it('достаёт ufrag', () => {
    expect(extractIceUfrag(OFFER_SDP)).toBe('4ZcD')
  })

  it('возвращает null, если строки нет', () => {
    expect(extractIceUfrag('v=0\r\n')).toBeNull()
  })
})

describe('parseCandidateLine', () => {
  it('разбирает host-кандидата', () => {
    const parsed = parseCandidateLine(
      'a=candidate:1510613869 1 udp 2113937151 192.168.1.5 54321 typ host generation 0',
    )
    expect(parsed).toEqual({
      foundation: '1510613869',
      component: 1,
      protocol: 'udp',
      priority: 2113937151,
      address: '192.168.1.5',
      port: 54321,
      type: 'host',
    })
  })

  it('разбирает srflx-кандидата вместе с базовым адресом', () => {
    const parsed = parseCandidateLine(
      'candidate:842163049 1 udp 1677729535 203.0.113.7 41234 typ srflx raddr 192.168.1.5 rport 54321',
    )
    expect(parsed).toMatchObject({
      type: 'srflx',
      address: '203.0.113.7',
      port: 41234,
      relatedAddress: '192.168.1.5',
      relatedPort: 54321,
    })
  })

  it('работает и без префикса a=', () => {
    const withPrefix = parseCandidateLine('a=candidate:1 1 udp 100 10.0.0.1 1234 typ host')
    const without = parseCandidateLine('candidate:1 1 udp 100 10.0.0.1 1234 typ host')
    expect(withPrefix).toEqual(without)
  })

  it('разбирает IPv6-кандидата', () => {
    const parsed = parseCandidateLine(
      'a=candidate:1 1 udp 2113937151 2a00:1450:4010:c0f::5e 49152 typ host',
    )
    expect(parsed).toMatchObject({ address: '2a00:1450:4010:c0f::5e', type: 'host' })
  })

  it('разбирает mDNS-кандидата, которым браузер прячет локальный IP', () => {
    const parsed = parseCandidateLine(
      'a=candidate:1 1 udp 2113937151 f7a3b1c2-0d4e-4f60-9a1b-2c3d4e5f6071.local 54321 typ host',
    )
    expect(parsed?.address).toBe('f7a3b1c2-0d4e-4f60-9a1b-2c3d4e5f6071.local')
  })

  it('разбирает tcptype', () => {
    const parsed = parseCandidateLine(
      'a=candidate:1 1 tcp 1518280447 192.168.1.5 9 typ host tcptype active',
    )
    expect(parsed).toMatchObject({ protocol: 'tcp', tcpType: 'active' })
  })

  it('разбирает relay-кандидата', () => {
    const parsed = parseCandidateLine(
      'a=candidate:1 1 udp 41885439 198.51.100.20 60000 typ relay raddr 203.0.113.7 rport 41234',
    )
    expect(parsed?.type).toBe('relay')
  })

  it('возвращает null на строке не про кандидата', () => {
    expect(parseCandidateLine('a=ice-ufrag:4ZcD')).toBeNull()
  })

  it('возвращает null на обрезанной строке кандидата', () => {
    expect(parseCandidateLine('a=candidate:1 1 udp')).toBeNull()
  })

  it('возвращает null на неизвестном типе кандидата', () => {
    expect(parseCandidateLine('a=candidate:1 1 udp 100 10.0.0.1 1234 typ wormhole')).toBeNull()
  })
})

describe('parseCandidates', () => {
  it('собирает всех кандидатов из обеих m-секций', () => {
    const candidates = parseCandidates(OFFER_SDP)
    expect(candidates).toHaveLength(3)
    expect(candidates.filter((c) => c.type === 'host')).toHaveLength(2)
    expect(candidates.filter((c) => c.type === 'srflx')).toHaveLength(1)
  })

  it('на SDP без кандидатов отдаёт пустой список, а не падает', () => {
    expect(parseCandidates('v=0\r\ns=-\r\n')).toEqual([])
  })

  it('пропускает битые строки, но сохраняет корректные', () => {
    const sdp = [
      'a=candidate:1 1 udp 100 10.0.0.1 1234 typ host',
      'a=candidate:BROKEN',
      'a=candidate:2 1 udp 100 10.0.0.2 1235 typ host',
    ].join('\r\n')
    expect(parseCandidates(sdp)).toHaveLength(2)
  })
})
