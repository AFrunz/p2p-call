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

/**
 * Проба: один сокет опрашивает несколько серверов, каждый отвечает своим
 * внешним портом. Один порт на все — обычный NAT, разные — symmetric.
 */
function probe(externalPorts: number[], localPort = 54321, servers = externalPorts.length): StunProbe {
  const seen = [...new Set(externalPorts)]
  return {
    servers,
    candidates: [
      candidate({ type: 'host', address: '192.168.1.5', port: localPort }),
      // Одинаковые кандидаты браузер схлопывает — повторяем это поведение.
      ...seen.map((port) =>
        candidate({
          type: 'srflx',
          address: '203.0.113.7',
          port,
          relatedAddress: '192.168.1.5',
          relatedPort: localPort,
        }),
      ),
    ],
  }
}

describe('classifyNat', () => {
  it('видит cone NAT, когда оба сервера отчитались об одном внешнем порте', () => {
    const diagnosis = classifyNat(probe([41234, 41234]))
    expect(diagnosis.verdict).toBe('cone')
    expect(diagnosis.directLikely).toBe(true)
  })

  it('ловит symmetric NAT по разным внешним портам с одного локального', () => {
    const diagnosis = classifyNat(probe([41234, 41999]))
    expect(diagnosis.verdict).toBe('symmetric')
    expect(diagnosis.directLikely).toBe(false)
    expect(diagnosis.reason.key).toBe('nat.symmetric.reason')
  })

  it('не путает разные локальные сокеты с symmetric NAT', () => {
    // Разные сокеты законно получают разные внешние порты и на обычном NAT.
    // Именно поэтому проба обязана опрашивать все серверы одним соединением.
    const mixed: StunProbe = {
      servers: 2,
      candidates: [
        candidate({
          type: 'srflx',
          address: '203.0.113.7',
          port: 41234,
          relatedAddress: '192.168.1.5',
          relatedPort: 54321,
        }),
        candidate({
          type: 'srflx',
          address: '203.0.113.7',
          port: 41999,
          relatedAddress: '192.168.1.5',
          relatedPort: 54999,
        }),
      ],
    }
    expect(classifyNat(mixed).verdict).not.toBe('symmetric')
  })

  it('видит отсутствие NAT, когда внешний адрес совпал с локальным', () => {
    const open: StunProbe = {
      servers: 2,
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
    expect(classifyNat(open).verdict).toBe('open')
  })

  it('сообщает про заблокированный UDP, когда ни один STUN не ответил', () => {
    const blocked: StunProbe = { servers: 2, candidates: [candidate({ type: 'host' })] }
    const diagnosis = classifyNat(blocked)
    expect(diagnosis.verdict).toBe('blocked')
    expect(diagnosis.directLikely).toBe(false)
    expect(diagnosis.reason.key).toBe('nat.blocked.reason')
  })

  it('честно говорит unknown, когда ответил один сервер', () => {
    // По одному серверу отличить обычный NAT от symmetric невозможно.
    expect(classifyNat(probe([41234], 54321, 1)).verdict).toBe('unknown')
  })

  it('честно говорит unknown, когда проверка не проводилась', () => {
    expect(classifyNat({ servers: 0, candidates: [] }).verdict).toBe('unknown')
  })

  it('не обещает успех по своей стороне: исход решает пара роутеров', () => {
    // Даже с идеальным NAT у нас собеседник может оказаться за symmetric,
    // а фильтрацию (RFC 5780) браузер померить не даёт вовсе.
    const cone = classifyNat(probe([41234, 41234]))
    expect(cone.conclusive).toBe(false)
    // Пояснение к cone — отдельный ключ, а не пересказ «открытого» вывода;
    // за честность самой формулировки отвечают тесты словаря в tests/i18n.
    expect(cone.reason.key).toBe('nat.cone.reason')
    expect(cone.reason.key).not.toBe('nat.open.reason')

    const symmetric = classifyNat(probe([41234, 41999]))
    expect(symmetric.conclusive).toBe(false)
  })

  it('считает окончательными только выводы, не зависящие от второй стороны', () => {
    const blocked: StunProbe = { servers: 2, candidates: [candidate({ type: 'host' })] }
    expect(classifyNat(blocked).conclusive).toBe(true)

    const open: StunProbe = {
      servers: 2,
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
    expect(classifyNat(open).conclusive).toBe(true)
  })

  it('всегда даёт непустой ключ пояснения', () => {
    const inputs: StunProbe[] = [
      { servers: 0, candidates: [] },
      probe([41234], 54321, 1),
      probe([41234, 41999]),
    ]
    for (const probes of inputs) {
      // Пустой ключ переводчик отдал бы обратно пустой строкой — интерфейс
      // остался бы без объяснения вывода вовсе.
      expect(classifyNat(probes).reason.key.length).toBeGreaterThan(0)
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
    expect(
      classifyConnection({
        localType: 'relay',
        localAddress: '198.51.100.20',
        remoteType: 'srflx',
        remoteAddress: '203.0.113.7',
      }),
    ).toBe('relay')
    expect(
      classifyConnection({
        localType: 'host',
        localAddress: '192.168.1.5',
        remoteType: 'relay',
        remoteAddress: '198.51.100.20',
      }),
    ).toBe('relay')
  })

  it('relay перевешивает всё остальное, даже глобальный IPv6 с обеих сторон', () => {
    // Адреса тут глобальные, но трафик всё равно идёт через сервер.
    expect(
      classifyConnection({
        localType: 'relay',
        localAddress: '2a00:1450:4010:c0f::5e',
        remoteType: 'host',
        remoteAddress: '2606:4700:4700::1111',
      }),
    ).toBe('relay')
  })

  it('считает host-host в приватной сети локальным соединением', () => {
    expect(
      classifyConnection({
        localType: 'host',
        localAddress: '192.168.1.5',
        remoteType: 'host',
        remoteAddress: '192.168.1.9',
      }),
    ).toBe('local')
  })

  it('считает host-host через mDNS локальным соединением', () => {
    expect(
      classifyConnection({
        localType: 'host',
        localAddress: 'f7a3b1c2-0d4e-4f60-9a1b-2c3d4e5f6071.local',
        remoteType: 'host',
        remoteAddress: '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d.local',
      }),
    ).toBe('local')
  })

  it('считает host-host по глобальным IPv6 соединением по IPv6', () => {
    expect(
      classifyConnection({
        localType: 'host',
        localAddress: '2a00:1450:4010:c0f::5e',
        remoteType: 'host',
        remoteAddress: '2606:4700:4700::1111',
      }),
    ).toBe('ipv6')
  })

  it('не называет IPv6 путь, где глобальный адрес только с одной стороны', () => {
    // Вторая сторона в IPv4 — значит где-то по дороге всё же есть NAT.
    expect(
      classifyConnection({
        localType: 'host',
        localAddress: '2a00:1450:4010:c0f::5e',
        remoteType: 'srflx',
        remoteAddress: '203.0.113.7',
      }),
    ).toBe('nat')
  })

  it('не считает IPv6 путь по link-local и unique-local адресам', () => {
    expect(
      classifyConnection({
        localType: 'srflx',
        localAddress: 'fe80::1c2d:3e4f:5a6b:7c8d',
        remoteType: 'srflx',
        remoteAddress: 'fd00::1',
      }),
    ).toBe('nat')
  })

  it('считает пробитое через STUN соединение прошедшим через NAT', () => {
    expect(
      classifyConnection({
        localType: 'srflx',
        localAddress: '203.0.113.7',
        remoteType: 'srflx',
        remoteAddress: '198.51.100.20',
      }),
    ).toBe('nat')
    expect(
      classifyConnection({
        localType: 'prflx',
        localAddress: '203.0.113.7',
        remoteType: 'srflx',
        remoteAddress: '198.51.100.20',
      }),
    ).toBe('nat')
  })

  it('считает host-host по публичным IPv4 путём через NAT, а не локальным', () => {
    // Обеих сторон снаружи видно напрямую, но это уже не локальная сеть.
    expect(
      classifyConnection({
        localType: 'host',
        localAddress: '203.0.113.7',
        remoteType: 'host',
        remoteAddress: '198.51.100.20',
      }),
    ).toBe('nat')
  })
})
