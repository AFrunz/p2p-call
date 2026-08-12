import { describe, expect, it } from 'vitest'
import { countCandidates, insertCandidates } from '../../src/signaling/sdp.js'
import { OFFER_SDP } from '../fixtures/sdp.js'

const BARE = [
  'v=0',
  'o=- 1 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'c=IN IP4 0.0.0.0',
  'a=ice-ufrag:4ZcD',
  'a=ice-pwd:2/1muCWoOi3uLifh0NuRHlgh',
  'a=rtpmap:111 opus/48000/2',
].join('\r\n')

const LINES = [
  'candidate:1 1 udp 2113937151 192.168.1.5 54321 typ host',
  'a=candidate:2 1 udp 1677729535 203.0.113.7 41234 typ srflx raddr 192.168.1.5 rport 54321',
]

describe('countCandidates', () => {
  it('считает кандидатов в готовом SDP', () => {
    expect(countCandidates(OFFER_SDP)).toBe(3)
  })

  it('на SDP без кандидатов отдаёт ноль', () => {
    expect(countCandidates(BARE)).toBe(0)
  })
})

describe('insertCandidates', () => {
  it('дописывает кандидатов, когда SDP пришёл без них', () => {
    // Пустой от кандидатов код выглядит рабочим и молча роняет ICE через
    // секунду после обмена — это ровно тот отказ, который нечем диагностировать.
    const result = insertCandidates(BARE, LINES)
    expect(countCandidates(result)).toBe(2)
  })

  it('приводит строки к виду a=candidate независимо от того, как их отдал браузер', () => {
    const result = insertCandidates(BARE, LINES)
    for (const line of result.split('\r\n')) {
      if (line.includes('candidate:')) expect(line.startsWith('a=candidate:')).toBe(true)
    }
  })

  it('кладёт кандидатов внутрь медиасекции, а не в заголовок сессии', () => {
    const lines = insertCandidates(BARE, LINES).split('\r\n')
    const media = lines.findIndex((line) => line.startsWith('m='))
    const first = lines.findIndex((line) => line.startsWith('a=candidate:'))

    expect(media).toBeGreaterThanOrEqual(0)
    expect(first).toBeGreaterThan(media)
  })

  it('не трогает SDP, в котором кандидаты уже есть', () => {
    expect(insertCandidates(OFFER_SDP, LINES)).toBe(OFFER_SDP)
  })

  it('не дублирует кандидатов: события приходят на каждую m-строку', () => {
    // При bundle всё идёт одним транспортом, а повторы раздувают код и
    // множат бессмысленные пары.
    const result = insertCandidates(BARE, [...LINES, ...LINES, LINES[0]!])
    expect(countCandidates(result)).toBe(2)
  })

  it('считает одинаковыми строки с префиксом a= и без него', () => {
    const result = insertCandidates(BARE, [LINES[0]!, `a=${LINES[0]!}`])
    expect(countCandidates(result)).toBe(1)
  })

  it('не трогает SDP, когда дописывать нечего', () => {
    expect(insertCandidates(BARE, [])).toBe(BARE)
  })

  it('сохраняет перевод строки исходного SDP', () => {
    expect(insertCandidates(BARE, LINES)).toContain('\r\n')
    expect(insertCandidates(BARE.replace(/\r\n/g, '\n'), LINES)).not.toContain('\r\n')
  })

  it('переживает SDP без медиасекций', () => {
    expect(insertCandidates('v=0\r\ns=-\r\n', LINES)).toBe('v=0\r\ns=-\r\n')
  })
})
