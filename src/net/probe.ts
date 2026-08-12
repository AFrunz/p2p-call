import { parseCandidateLine } from '../signaling/sdp.js'
import type { IceCandidateInfo } from '../signaling/types.js'
import { classifyNat, hasGlobalIpv6 } from './nat.js'
import type { NatDiagnosis, StunProbe } from './nat.js'

/** Сколько ждём кандидатов, прежде чем считать оставшиеся серверы молчащими. */
const PROBE_TIMEOUT_MS = 4000

export interface NetworkReport extends NatDiagnosis {
  probe: StunProbe
  /** Есть ли у нас глобальный IPv6: с ним NAT не мешает вовсе. */
  ipv6: boolean
}

/**
 * Проверка сети до обмена кодами.
 *
 * Все STUN опрашиваются ОДНИМ соединением: тип маппинга виден только при
 * сравнении внешних портов одного локального сокета.
 */
export async function probeNetwork(
  servers: readonly string[],
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<NetworkReport> {
  // Двух серверов достаточно и они обязательны: по одному отличить обычный
  // NAT от symmetric невозможно в принципе.
  const targets = servers.slice(0, 3)
  const connection = new RTCPeerConnection({ iceServers: targets.map((urls) => ({ urls })) })
  const candidates: IceCandidateInfo[] = []

  try {
    connection.createDataChannel('probe')
    await connection.setLocalDescription(await connection.createOffer())

    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(done, timeoutMs)

      connection.addEventListener('icecandidate', (event) => {
        // Конец сбора приходит либо null, либо кандидатом с пустой строкой.
        const line = event.candidate?.candidate ?? ''
        if (line.length === 0) return void done()

        const parsed = parseCandidateLine(line)
        if (parsed !== null) candidates.push(parsed)
      })
    })
  } finally {
    connection.close()
  }

  const probe: StunProbe = { servers: targets.length, candidates }
  return { ...classifyNat(probe), probe, ipv6: hasGlobalIpv6(candidates) }
}
