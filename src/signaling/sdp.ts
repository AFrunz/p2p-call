import type { Bytes } from '../bytes.js'
import type { CandidateType, IceCandidateInfo } from './types.js'

const FINGERPRINT_BYTES = 32

const CANDIDATE_TYPES = new Set<string>(['host', 'srflx', 'prflx', 'relay'])
const TCP_TYPES = new Set<string>(['active', 'passive', 'so'])

/**
 * Достаёт DTLS-fingerprint из SDP.
 *
 * Принимаются SHA-256 и сильнее: какой именно хеш согласуют браузеры, зависит
 * от них, а обе стороны всё равно видят одну и ту же пару отпечатков — этого
 * достаточно, чтобы SAS сошёлся. SHA-1 отвергаем: слишком слаб, чтобы на нём
 * держалась защита от подмены.
 */
export function extractFingerprint(sdp: string): Bytes | null {
  const match = /^a=fingerprint:sha-(256|384|512)[ \t]+([0-9a-fA-F:]+)/im.exec(sdp)
  if (match?.[2] === undefined) return null

  const parts = match[2].split(':')
  if (parts.length < FINGERPRINT_BYTES) return null

  const bytes = new Uint8Array(parts.length)
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
 * Дописывает кандидатов в SDP, если их там нет.
 *
 * Обмен одноразовый, добавить их потом некуда, а класть ли их в
 * localDescription — движки решают по-разному. При bundle хватает первой
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

  // События приходят по одному на каждую m-строку, поэтому один и тот же
  // кандидат встречается несколько раз. При bundle всё идёт одним транспортом
  // и повторы бессмысленны — они лишь раздувают код и множат пары.
  const normalized = [
    ...new Set(candidates.map((line) => (line.startsWith('a=') ? line : `a=${line}`))),
  ]
  lines.splice(at, 0, ...normalized)
  return lines.join(eol)
}

/**
 * Вынимает кандидатов из SDP, оставляя всё остальное.
 *
 * Нужно, чтобы отвечающая сторона могла подготовить ответ, но не начинать
 * проверку пар: без удалённых кандидатов парам не из чего строиться, и ICE не
 * сдаётся через полминуты, пока человек переносит код.
 */
export function stripCandidates(sdp: string): { sdp: string; candidates: string[] } {
  const candidates: string[] = []
  const kept: string[] = []

  for (const line of sdp.split(/\r?\n/)) {
    if (line.trim().startsWith('a=candidate:')) candidates.push(line.trim().replace(/^a=/, ''))
    else kept.push(line)
  }

  const eol = sdp.includes('\r\n') ? '\r\n' : '\n'
  return { sdp: kept.join(eol), candidates }
}
