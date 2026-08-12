import { message } from '../i18n/message.js'
import type { Message } from '../i18n/message.js'
import type { CandidateType, IceCandidateInfo } from '../signaling/types.js'

/**
 * `open`      — публичный адрес, NAT отсутствует.
 * `cone`      — маппинг не зависит от получателя, hole punching сработает.
 * `symmetric` — на каждого получателя свой порт, прямое соединение маловероятно.
 * `blocked`   — ни один STUN не ответил: UDP зарезан или сети нет.
 * `unknown`   — данных не хватило для вывода.
 */
export type NatVerdict = 'open' | 'cone' | 'symmetric' | 'blocked' | 'unknown'

/**
 * Результат одной пробы сети.
 *
 * Кандидаты собираются ОДНИМ соединением сразу ко всем серверам. Разными
 * соединениями мерить нельзя: у каждого свой локальный сокет, а значит и свой
 * внешний порт даже на самом обычном NAT — сравнивать было бы нечего.
 */
export interface StunProbe {
  /** Сколько STUN-серверов опрашивалось. */
  servers: number
  candidates: IceCandidateInfo[]
}

export interface NatDiagnosis {
  verdict: NatVerdict
  /**
   * Объяснение вывода — ключ локализации, а не готовая строка.
   *
   * Диагностика считается один раз, а язык интерфейса можно переключить в любой
   * момент: храня ключ, мы не обязаны перезапускать пробы после смены языка.
   */
  reason: Message
  /** Есть ли шанс соединиться напрямую без TURN. */
  directLikely: boolean
  /**
   * Решает ли этот вывод исход сам по себе.
   *
   * Связность определяется парой NAT, а проба видит только нашу сторону, да и
   * то лишь mapping behavior — фильтрацию (RFC 5780) браузер померить не даёт.
   * Поэтому «UDP заблокирован» и «публичный адрес» окончательны, а «cone» и
   * «symmetric» — только вероятность, пока не известен NAT собеседника.
   */
  conclusive: boolean
}

/**
 * Определяет тип NAT по srflx-кандидатам.
 *
 * Признак symmetric NAT: один и тот же локальный сокет виден снаружи под
 * разными портами в зависимости от того, к какому серверу шёл трафик. Поэтому
 * серверов нужно минимум два, и опрашивать их обязательно с одного сокета.
 *
 * Обратный случай — совпадение портов — браузер до нас не доносит: одинаковые
 * srflx-кандидаты он схлопывает в один. Поэтому «спросили двоих, расхождения
 * не увидели» и есть признак обычного NAT.
 */
export function classifyNat(probe: StunProbe): NatDiagnosis {
  if (probe.servers === 0) {
    return {
      verdict: 'unknown',
      reason: message('nat.pending.reason'),
      directLikely: true,
      conclusive: false,
    }
  }

  const reflexive = probe.candidates.filter((candidate) => candidate.type === 'srflx')

  if (reflexive.length === 0) {
    return {
      verdict: 'blocked',
      reason: message('nat.blocked.reason'),
      directLikely: false,
      conclusive: true,
    }
  }

  const noNat = reflexive.some(
    (candidate) =>
      candidate.relatedAddress !== undefined &&
      candidate.relatedAddress === candidate.address &&
      candidate.relatedPort === candidate.port,
  )
  if (noNat) {
    return {
      verdict: 'open',
      reason: message('nat.open.reason'),
      directLikely: true,
      conclusive: true,
    }
  }

  // Сравнивать внешние порты имеет смысл только в пределах одного локального
  // сокета: разные сокеты законно получают разные порты и на обычном NAT.
  const byBase = new Map<string, Set<number>>()
  for (const candidate of reflexive) {
    const base = `${candidate.relatedAddress ?? '?'}:${candidate.relatedPort ?? '?'}`
    const ports = byBase.get(base) ?? new Set<number>()
    ports.add(candidate.port)
    byBase.set(base, ports)
  }

  for (const ports of byBase.values()) {
    if (ports.size > 1) {
      return {
        verdict: 'symmetric',
        reason: message('nat.symmetric.reason'),
        directLikely: false,
        conclusive: false,
      }
    }
  }

  if (probe.servers >= 2) {
    return {
      verdict: 'cone',
      reason: message('nat.cone.reason'),
      directLikely: true,
      conclusive: false,
    }
  }

  return {
    verdict: 'unknown',
    reason: message('nat.unknown.reason'),
    directLikely: true,
    conclusive: false,
  }
}

/** Есть ли среди кандидатов пригодный для связи IPv6 (не link-local). */
export function hasGlobalIpv6(candidates: IceCandidateInfo[]): boolean {
  return candidates.some((candidate) => isGlobalIpv6(candidate.address))
}

function isGlobalIpv6(address: string): boolean {
  if (!isIpv6(address)) return false

  const plain = stripBrackets(address).toLowerCase()
  if (plain === '::1' || plain === '::') return false
  if (/^fe[89ab]/.test(plain)) return false // link-local fe80::/10
  if (/^f[cd]/.test(plain)) return false // unique-local fc00::/7, наружу не маршрутизируется
  if (/^ff/.test(plain)) return false // multicast
  return true
}

/** Отличает IPv6 от IPv4, включая адреса в квадратных скобках. */
export function isIpv6(address: string): boolean {
  const plain = stripBrackets(address)
  return plain.includes(':')
}

/**
 * mDNS-кандидаты вида `a1b2c3d4-....local` — браузер так прячет локальный IP.
 * Для статистики их нельзя считать обычными host-адресами.
 */
export function isMdnsAddress(address: string): boolean {
  return /\.local$/i.test(address.trim())
}

export type ConnectionKind = 'local' | 'direct' | 'relay'

/** Классифицирует установленное соединение по типам кандидатов выбранной пары. */
export function classifyConnection(
  local: CandidateType,
  remote: CandidateType,
  localAddress: string,
): ConnectionKind {
  if (local === 'relay' || remote === 'relay') return 'relay'

  // host-host бывает и локальной сетью, и прямой связью по публичному IPv6.
  if (local === 'host' && remote === 'host') {
    return isMdnsAddress(localAddress) || isPrivateAddress(localAddress) ? 'local' : 'direct'
  }

  return 'direct'
}

function isPrivateAddress(address: string): boolean {
  const plain = stripBrackets(address).toLowerCase()

  if (isIpv6(plain)) {
    return plain === '::1' || /^fe[89ab]/.test(plain) || /^f[cd]/.test(plain)
  }

  return (
    /^10\./.test(plain) ||
    /^192\.168\./.test(plain) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(plain) ||
    /^169\.254\./.test(plain) ||
    /^127\./.test(plain)
  )
}

function stripBrackets(address: string): string {
  const trimmed = address.trim()
  return trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed
}
