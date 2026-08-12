import type { Bytes } from '../bytes.js'
import type { CandidateType, IceCandidateInfo } from './types.js'

const FINGERPRINT_BYTES = 32

const CANDIDATE_TYPES = new Set<string>(['host', 'srflx', 'prflx', 'relay'])
const TCP_TYPES = new Set<string>(['active', 'passive', 'so'])

/**
 * Достаёт DTLS-fingerprint (SHA-256, 32 байта) из SDP.
 * Возвращает null, если строки нет или хеш не SHA-256 — оба случая означают,
 * что мы не сможем посчитать SAS и должны об этом сказать, а не молча продолжить.
 */
export function extractFingerprint(sdp: string): Bytes | null {
  const match = /^a=fingerprint:sha-256[ \t]+([0-9a-fA-F:]+)/im.exec(sdp)
  if (match?.[1] === undefined) return null

  const parts = match[1].split(':')
  if (parts.length !== FINGERPRINT_BYTES) return null

  const bytes = new Uint8Array(FINGERPRINT_BYTES)
  for (let i = 0; i < parts.length; i++) {
    const pair = parts[i]!
    if (!/^[0-9a-fA-F]{2}$/.test(pair)) return null
    bytes[i] = Number.parseInt(pair, 16)
  }
  return bytes
}

/** Достаёт ice-ufrag — используется для диагностики и сверки сессий. */
export function extractIceUfrag(sdp: string): string | null {
  return /^a=ice-ufrag:(\S+)/im.exec(sdp)?.[1] ?? null
}

/** Разбирает все строки `a=candidate:...`. Нераспознанные кандидаты пропускаются. */
export function parseCandidates(sdp: string): IceCandidateInfo[] {
  const candidates: IceCandidateInfo[] = []
  for (const line of sdp.split(/\r?\n/)) {
    const parsed = parseCandidateLine(line)
    if (parsed !== null) candidates.push(parsed)
  }
  return candidates
}

/** Разбирает одну строку кандидата (с префиксом `a=candidate:` или без). */
export function parseCandidateLine(line: string): IceCandidateInfo | null {
  const trimmed = line.trim().replace(/^a=/, '')
  if (!trimmed.startsWith('candidate:')) return null

  const parts = trimmed.slice('candidate:'.length).trim().split(/\s+/)
  if (parts.length < 8) return null

  const [foundation, componentRaw, protocolRaw, priorityRaw, address, portRaw, typToken, typeRaw] =
    parts as [string, string, string, string, string, string, string, string]

  if (typToken !== 'typ') return null
  if (foundation.length === 0 || address.length === 0) return null

  const protocol = protocolRaw.toLowerCase()
  if (protocol !== 'udp' && protocol !== 'tcp') return null
  if (!CANDIDATE_TYPES.has(typeRaw)) return null

  const component = parseUint(componentRaw)
  const priority = parseUint(priorityRaw)
  const port = parsePort(portRaw)
  if (component === null || priority === null || port === null) return null

  // Хвост идёт парами `ключ значение`; неизвестные пары просто игнорируем.
  let relatedAddress: string | undefined
  let relatedPort: number | undefined
  let tcpType: 'active' | 'passive' | 'so' | undefined

  for (let i = 8; i + 1 < parts.length; i += 2) {
    const key = parts[i]!
    const value = parts[i + 1]!
    if (key === 'raddr') relatedAddress = value
    else if (key === 'rport') relatedPort = parsePort(value) ?? undefined
    else if (key === 'tcptype' && TCP_TYPES.has(value)) {
      tcpType = value as 'active' | 'passive' | 'so'
    }
  }

  return {
    foundation,
    component,
    protocol,
    priority,
    address,
    port,
    type: typeRaw as CandidateType,
    ...(relatedAddress !== undefined ? { relatedAddress } : {}),
    ...(relatedPort !== undefined ? { relatedPort } : {}),
    ...(tcpType !== undefined ? { tcpType } : {}),
  }
}

function parseUint(value: string): number | null {
  if (!/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function parsePort(value: string): number | null {
  const parsed = parseUint(value)
  if (parsed === null) return null
  // Порт 9 (discard) законно встречается в m-строках, поэтому нижняя граница 0.
  return parsed <= 65535 ? parsed : null
}

/** Сколько строк `a=candidate:` уже лежит в SDP. */
export function countCandidates(sdp: string): number {
  return sdp.split(/\r?\n/).filter((line) => line.trim().startsWith('a=candidate:')).length
}

/**
 * Дописывает собранные кандидаты в SDP, если их там нет.
 *
 * Код подключения передаётся один раз и целиком, поэтому кандидаты обязаны быть
 * внутри SDP. Полагаться на то, что браузер сам их туда положит, нельзя: это
 * поведение у разных движков различается, а пустой от кандидатов код выглядит
 * рабочим и молча приводит к провалу ICE через секунду после обмена.
 *
 * При bundle все дорожки идут одним транспортом, поэтому достаточно первой
 * медиасекции.
 */
export function insertCandidates(sdp: string, candidates: readonly string[]): string {
  if (candidates.length === 0 || countCandidates(sdp) > 0) return sdp

  const eol = sdp.includes('\r\n') ? '\r\n' : '\n'
  const lines = sdp.split(/\r?\n/)

  const media = lines.findIndex((line) => line.startsWith('m='))
  if (media < 0) return sdp

  // После ice-pwd — самое безопасное место: строка точно относится к этой
  // секции и идёт до атрибутов кодеков.
  let at = lines.findIndex((line, index) => index > media && line.startsWith('a=ice-pwd:'))
  if (at < 0) at = media
  at += 1

  const normalized = candidates.map((line) =>
    line.startsWith('a=') ? line : `a=${line}`,
  )
  lines.splice(at, 0, ...normalized)
  return lines.join(eol)
}
