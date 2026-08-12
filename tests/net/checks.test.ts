import { describe, expect, it } from 'vitest'
import { buildChecks } from '../../src/net/checks.js'
import type { CheckId, ChecksView } from '../../src/net/checks.js'
import { classifyNat } from '../../src/net/nat.js'
import type { StunProbe } from '../../src/net/nat.js'
import type { NetworkReport } from '../../src/net/probe.js'
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

/** Проба, из которой не вернулось ни одного srflx: STUN промолчал. */
function silent(server: string): StunProbe {
  return { server, candidates: [candidate({ type: 'host', address: '192.168.1.5' })] }
}

/**
 * Отчёт собираем настоящим классификатором, как это делает probeNetwork:
 * иначе легко разъехаться с полями conclusive/directLikely, на которых всё держится.
 */
function report(probes: StunProbe[], ipv6 = false): NetworkReport {
  return { ...classifyNat(probes), probes, ipv6 }
}

function stateOf(view: ChecksView, id: CheckId): string {
  const found = view.checks.find((check) => check.id === id)
  expect(found, `нет проверки ${id}`).toBeDefined()
  return found?.state ?? 'missing'
}

const cone = report([probe('stun:a', 41234), probe('stun:b', 41234)])
const symmetric = report([probe('stun:a', 41234), probe('stun:b', 41999)])
const blocked = report([silent('stun:a'), silent('stun:b')])
const open = report([
  {
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
  },
  {
    server: 'stun:b',
    candidates: [
      candidate({
        type: 'srflx',
        address: '203.0.113.7',
        port: 54321,
        relatedAddress: '203.0.113.7',
        relatedPort: 54321,
      }),
    ],
  },
])

/** Все интересные исходы разом — по ним гоняем инварианты таблицы. */
const allViews: ChecksView[] = [null, cone, symmetric, blocked, open].map((input) =>
  buildChecks(input),
)

describe('buildChecks', () => {
  it('до диагностики держит все проверки в ожидании и ничего не советует', () => {
    const view = buildChecks(null)
    expect(view.checks).toHaveLength(4)
    expect(view.checks.every((check) => check.state === 'pending')).toBe(true)
    expect(view.verdict.state).toBe('pending')
    expect(view.suggestServer).toBe(false)
  })

  it('при заблокированном UDP красит сетевые проверки и предлагает сервер', () => {
    const view = buildChecks(blocked)
    expect(stateOf(view, 'reachability')).toBe('fail')
    expect(stateOf(view, 'reflexive')).toBe('fail')
    expect(stateOf(view, 'nat')).toBe('fail')
    expect(view.verdict.state).toBe('fail')
    expect(view.suggestServer).toBe(true)
  })

  it('на symmetric NAT предупреждает, но не хоронит звонок и не навязывает сервер', () => {
    // Ключевой тест на честность: исход решает пара роутеров, а мы видели только
    // свой. С обычным NAT у собеседника соединение вполне может получиться.
    const view = buildChecks(symmetric)
    expect(stateOf(view, 'nat')).toBe('warn')
    expect(view.verdict.state).toBe('warn')
    expect(view.verdict.state).not.toBe('fail')
    expect(view.suggestServer).toBe(false)
  })

  it('на cone NAT даёт зелёный вердикт, но не обещает успех', () => {
    const view = buildChecks(cone)
    expect(view.verdict.state).toBe('ok')
    expect(view.suggestServer).toBe(false)
    // Текст у неокончательного вывода отдельный: он говорит про роутер
    // собеседника, а не про гарантированное соединение.
    expect(view.verdict.noteKey).not.toBe(buildChecks(open).verdict.noteKey)
    expect(view.verdict.noteKey).toContain('cone')
  })

  it('на публичном адресе без NAT вердикт зелёный', () => {
    const view = buildChecks(open)
    expect(view.verdict.state).toBe('ok')
    expect(stateOf(view, 'nat')).toBe('ok')
    expect(view.suggestServer).toBe(false)
  })

  it('когда ответил только один STUN, честно оставляет тип NAT в ожидании', () => {
    const view = buildChecks(report([probe('stun:a', 41234)]))
    expect(stateOf(view, 'nat')).toBe('pending')
    expect(stateOf(view, 'reachability')).toBe('ok')
    expect(view.verdict.state).not.toBe('fail')
    expect(view.suggestServer).toBe(false)
  })

  it('показывает найденный внешний адрес в подстановках', () => {
    const view = buildChecks(cone)
    const reflexive = view.checks.find((check) => check.id === 'reflexive')
    expect(reflexive?.state).toBe('ok')
    expect(reflexive?.params?.['address']).toBe('203.0.113.7')
    expect(reflexive?.params?.['port']).toBe('41234')
  })

  it('считает отсутствие IPv6 предупреждением, а не ошибкой', () => {
    expect(stateOf(buildChecks(report(cone.probes, false)), 'ipv6')).toBe('warn')
    expect(stateOf(buildChecks(report(cone.probes, true)), 'ipv6')).toBe('ok')
    // Потерянный простой путь не должен портить общий вердикт.
    expect(buildChecks(report(cone.probes, false)).verdict.state).toBe('ok')
  })

  it('всегда отдаёт ровно четыре проверки в одном и том же порядке', () => {
    // Интерфейс рисует таблицу как есть: строки не должны прыгать между перерисовками.
    const expected: CheckId[] = ['reachability', 'reflexive', 'nat', 'ipv6']
    for (const view of allViews) {
      expect(view.checks.map((check) => check.id)).toEqual(expected)
    }
  })

  it('у каждой проверки и вердикта есть непустые ключи локализации', () => {
    for (const view of allViews) {
      for (const check of view.checks) {
        expect(check.titleKey.length).toBeGreaterThan(0)
        expect(check.noteKey.length).toBeGreaterThan(0)
      }
      expect(view.verdict.titleKey.length).toBeGreaterThan(0)
      expect(view.verdict.noteKey.length).toBeGreaterThan(0)
    }
  })
})
