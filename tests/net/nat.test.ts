import { describe, expect, it } from 'vitest'
import {
  classifyConnection,
  classifyNat,
  hasGlobalIpv6,
  isIpv6,
  isMdnsAddress,
} from '../../src/net/nat.js'
import type { StunProbe } from '../../src/net/nat.js'
import { candidate } from '../fixtures/sdp.js'

/** Проба к STUN: локальный порт один и тот же, внешний — как решит NAT. */
function probe(server: string, externalPort: number, localPort = 54321): StunProbe {
  return {
    server,
    candidates: [
      candidate({ type: 'host', address: '192.168.1.5', port: localPort }),
      candidate({
        type: 'srflx',
        address: '203.0.113.7',
        port: externalPort,
        relatedAddress: '192.168.1.5',
        relatedPort: localPort,
      }),
    ],
  }
}

describe('classifyNat', () => {
  it('видит cone NAT, когда оба сервера отчитались об одном внешнем порте', () => {
    const diagnosis = classifyNat([probe('stun:a', 41234), probe('stun:b', 41234)])
    expect(diagnosis.verdict).toBe('cone')
    expect(diagnosis.directLikely).toBe(true)
  })

  it('ловит symmetric NAT по разным внешним портам с одного локального', () => {
    const diagnosis = classifyNat([probe('stun:a', 41234), probe('stun:b', 41999)])
    expect(diagnosis.verdict).toBe('symmetric')
    expect(diagnosis.directLikely).toBe(false)
    expect(diagnosis.reason).toBeTruthy()
  })

  it('не путает разные локальные порты с symmetric NAT', () => {
    // Два разных локальных сокета законно получают разные внешние порты даже
    // на cone NAT — сравнивать можно только пробы с общим базовым адресом.
    const diagnosis = classifyNat([probe('stun:a', 41234, 54321), probe('stun:b', 41999, 54999)])
    expect(diagnosis.verdict).not.toBe('symmetric')
  })

  it('видит отсутствие NAT, когда внешний адрес совпал с локальным', () => {
    const open: StunProbe = {
      server: 'stun:a',
      candidates: [
        candidate({ type: 'host', address: '203.0.113.7', port: 54321 }),
        candidate({
          type: 'srflx',
          address: '203.0.113.7',
          port: 54321,
          relatedAddress: '203.0.113.7',
          relatedPort: 54321,
        }),
      ],
    }
    expect(classifyNat([open, { ...open, server: 'stun:b' }]).verdict).toBe('open')
  })

  it('сообщает про заблокированный UDP, когда ни один STUN не ответил', () => {
    const blocked: StunProbe = {
      server: 'stun:a',
      candidates: [candidate({ type: 'host' })],
    }
    const diagnosis = classifyNat([blocked, { ...blocked, server: 'stun:b' }])
    expect(diagnosis.verdict).toBe('blocked')
    expect(diagnosis.directLikely).toBe(false)
  })

  it('честно говорит unknown, когда проба всего одна', () => {
    // По одному серверу отличить cone от symmetric невозможно — врать нельзя.
    expect(classifyNat([probe('stun:a', 41234)]).verdict).toBe('unknown')
  })

  it('честно говорит unknown на пустом вводе', () => {
    expect(classifyNat([]).verdict).toBe('unknown')
  })

  it('не обещает успех по своей стороне: исход решает пара роутеров', () => {
    // Даже с идеальным NAT у нас собеседник может оказаться за symmetric,
    // а фильтрацию (RFC 5780) браузер померить не даёт вовсе.
    const cone = classifyNat([probe('stun:a', 41234), probe('stun:b', 41234)])
    expect(cone.conclusive).toBe(false)
    expect(cone.reason).toMatch(/собеседник/i)

    const symmetric = classifyNat([probe('stun:a', 41234), probe('stun:b', 41999)])
    expect(symmetric.conclusive).toBe(false)
  })

  it('считает окончательными только выводы, не зависящие от второй стороны', () => {
    const blocked: StunProbe = { server: 'stun:a', candidates: [candidate({ type: 'host' })] }
    expect(classifyNat([blocked, { ...blocked, server: 'stun:b' }]).conclusive).toBe(true)

    const open: StunProbe = {
      server: 'stun:a',
      candidates: [
        candidate({
          type: 'srflx',
          address: '203.0.113.7',
          port: 54321,
          relatedAddress: '203.0.113.7',
          relatedPort: 54321,
        }),
      ],
    }
    expect(classifyNat([open, { ...open, server: 'stun:b' }]).conclusive).toBe(true)
  })

  it('всегда объясняет вывод текстом для интерфейса', () => {
    for (const probes of [[], [probe('stun:a', 1)], [probe('stun:a', 1), probe('stun:b', 2)]]) {
      expect(classifyNat(probes).reason.length).toBeGreaterThan(0)
    }
  })
})

describe('isIpv6', () => {
  it('различает IPv4 и IPv6', () => {
    expect(isIpv6('192.168.1.5')).toBe(false)
    expect(isIpv6('2a00:1450:4010:c0f::5e')).toBe(true)
    expect(isIpv6('::1')).toBe(true)
  })

  it('понимает адрес в квадратных скобках', () => {
    expect(isIpv6('[2a00:1450:4010:c0f::5e]')).toBe(true)
  })

  it('не считает mDNS-имя адресом IPv6', () => {
    expect(isIpv6('f7a3b1c2-0d4e-4f60-9a1b-2c3d4e5f6071.local')).toBe(false)
  })
})

describe('hasGlobalIpv6', () => {
  it('находит глобальный IPv6', () => {
    expect(hasGlobalIpv6([candidate({ address: '2a00:1450:4010:c0f::5e' })])).toBe(true)
  })

  it('не считает link-local пригодным для связи', () => {
    expect(hasGlobalIpv6([candidate({ address: 'fe80::1c2d:3e4f:5a6b:7c8d' })])).toBe(false)
  })

  it('не считает loopback пригодным для связи', () => {
    expect(hasGlobalIpv6([candidate({ address: '::1' })])).toBe(false)
  })

  it('на одних IPv4-кандидатах отвечает false', () => {
    expect(hasGlobalIpv6([candidate({ address: '192.168.1.5' })])).toBe(false)
  })
})

describe('isMdnsAddress', () => {
  it('узнаёт mDNS-имя', () => {
    expect(isMdnsAddress('f7a3b1c2-0d4e-4f60-9a1b-2c3d4e5f6071.local')).toBe(true)
  })

  it('не срабатывает на обычных адресах', () => {
    expect(isMdnsAddress('192.168.1.5')).toBe(false)
    expect(isMdnsAddress('2a00:1450:4010:c0f::5e')).toBe(false)
  })
})

describe('classifyConnection', () => {
  it('считает соединение ретранслируемым, если relay с любой стороны', () => {
    expect(classifyConnection('relay', 'srflx', '198.51.100.20')).toBe('relay')
    expect(classifyConnection('host', 'relay', '192.168.1.5')).toBe('relay')
  })

  it('считает host-host в приватной сети локальным соединением', () => {
    expect(classifyConnection('host', 'host', '192.168.1.5')).toBe('local')
  })

  it('считает host-host через mDNS локальным соединением', () => {
    expect(classifyConnection('host', 'host', 'f7a3b1c2-0d4e-4f60-9a1b-2c3d4e5f6071.local')).toBe(
      'local',
    )
  })

  it('считает пробитое через STUN соединение прямым', () => {
    expect(classifyConnection('srflx', 'srflx', '203.0.113.7')).toBe('direct')
    expect(classifyConnection('prflx', 'srflx', '203.0.113.7')).toBe('direct')
  })

  it('считает host-host по публичным IPv6 прямым, а не локальным', () => {
    expect(classifyConnection('host', 'host', '2a00:1450:4010:c0f::5e')).toBe('direct')
  })
})
