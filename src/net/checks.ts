import type { IceCandidateInfo } from '../signaling/types.js'
import type { StunProbe } from './nat.js'
import type { NetworkReport } from './probe.js'

export type CheckState = 'ok' | 'warn' | 'fail' | 'pending'
export type CheckId = 'reachability' | 'reflexive' | 'nat' | 'ipv6'

export interface NetworkCheck {
  id: CheckId
  state: CheckState
  /** Ключ локализации для названия строки. */
  titleKey: string
  /** Ключ локализации для пояснения. */
  noteKey: string
  /** Подстановки в пояснение, например внешний адрес. */
  params?: Record<string, string>
}

export interface ChecksView {
  checks: NetworkCheck[]
  verdict: { state: CheckState; titleKey: string; noteKey: string }
  /** Всё плохо и без сервера не обойтись — интерфейс покажет кнопку перехода на вкладку сервера. */
  suggestServer: boolean
}

/**
 * Превращает отчёт диагностики в таблицу проверок для интерфейса.
 *
 * Главное правило здесь — не обещать больше, чем мы измерили. Проба видит
 * только нашу сторону, и то лишь mapping behavior, поэтому зелёный вердикт
 * читается как «с вашей стороны препятствий нет», а красный (и предложение
 * сервера-ретранслятора) ставится только по окончательному выводу.
 */
export function buildChecks(report: NetworkReport | null): ChecksView {
  if (report === null) {
    return {
      checks: [
        pendingCheck('reachability'),
        pendingCheck('reflexive'),
        pendingCheck('nat'),
        pendingCheck('ipv6'),
      ],
      verdict: {
        state: 'pending',
        titleKey: 'checks.verdict.pending.title',
        noteKey: 'checks.verdict.pending.note',
      },
      suggestServer: false,
    }
  }

  const reflexive = firstReflexive(report.probes)

  // Красный вердикт и кнопка сервера — только когда вывод не зависит от второй
  // стороны и она уже ничего не спасёт: фактически при заблокированном UDP.
  const hopeless = report.conclusive && !report.directLikely
  const state: CheckState = hopeless ? 'fail' : verdictState(report)

  return {
    checks: [
      reachabilityCheck(report, reflexive),
      reflexiveCheck(report, reflexive),
      natCheck(report),
      ipv6Check(report),
    ],
    verdict: {
      state,
      titleKey: `checks.verdict.${state}.title`,
      // Пояснение своё на каждый вывод: «cone» и «open» одинаково зелёные, но
      // обещать успех можно только там, где мы правда всё узнали.
      noteKey: `checks.verdict.${report.verdict}.note`,
    },
    suggestServer: hopeless,
  }
}

/** Ответил ли хоть один STUN. */
function reachabilityCheck(report: NetworkReport, reflexive: IceCandidateInfo | null): NetworkCheck {
  if (report.verdict === 'blocked') {
    return check('reachability', 'fail', 'checks.reachability.blocked')
  }
  // Проб могло не быть вовсе (пустой список серверов) — это не успех, а «не мерили».
  if (reflexive === null) return pendingCheck('reachability')
  return check('reachability', 'ok', 'checks.reachability.ok')
}

/** Получен ли внешний (srflx) адрес — его же показываем пользователю. */
function reflexiveCheck(report: NetworkReport, reflexive: IceCandidateInfo | null): NetworkCheck {
  if (report.verdict === 'blocked') {
    return check('reflexive', 'fail', 'checks.reflexive.blocked')
  }
  if (reflexive === null) return pendingCheck('reflexive')

  return {
    ...check('reflexive', 'ok', 'checks.reflexive.ok'),
    params: { address: reflexive.address, port: String(reflexive.port) },
  }
}

/** Тип отображения портов. Symmetric — жёлтый: с обычным роутером у собеседника шанс есть. */
function natCheck(report: NetworkReport): NetworkCheck {
  const noteKey = `checks.nat.${report.verdict}`
  switch (report.verdict) {
    case 'open':
    case 'cone':
      return check('nat', 'ok', noteKey)
    case 'symmetric':
      return check('nat', 'warn', noteKey)
    case 'blocked':
      return check('nat', 'fail', noteKey)
    case 'unknown':
      return check('nat', 'pending', noteKey)
  }
}

/** Отсутствие IPv6 не ошибка: просто теряется самый простой путь в обход NAT. */
function ipv6Check(report: NetworkReport): NetworkCheck {
  return report.ipv6
    ? check('ipv6', 'ok', 'checks.ipv6.ok')
    : check('ipv6', 'warn', 'checks.ipv6.missing')
}

function verdictState(report: NetworkReport): CheckState {
  switch (report.verdict) {
    case 'open':
    case 'cone':
      return 'ok'
    case 'symmetric':
      return 'warn'
    case 'blocked':
      return 'fail'
    case 'unknown':
      return 'pending'
  }
}

function firstReflexive(probes: readonly StunProbe[]): IceCandidateInfo | null {
  for (const probe of probes) {
    for (const candidate of probe.candidates) {
      if (candidate.type === 'srflx') return candidate
    }
  }
  return null
}

function check(id: CheckId, state: CheckState, noteKey: string): NetworkCheck {
  return { id, state, titleKey: `checks.${id}.title`, noteKey }
}

function pendingCheck(id: CheckId): NetworkCheck {
  return check(id, 'pending', `checks.${id}.pending`)
}
