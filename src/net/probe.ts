import { parseCandidateLine } from '../signaling/sdp.js'
import type { IceCandidateInfo } from '../signaling/types.js'
import { classifyNat, hasGlobalIpv6 } from './nat.js'
import type { NatDiagnosis, StunProbe } from './nat.js'

/** Сколько ждём ответа от одного STUN, прежде чем считать его молчащим. */
const PROBE_TIMEOUT_MS = 3000

/**
 * Собирает кандидатов через один STUN-сервер.
 *
 * Отдельное соединение на каждый сервер — принципиально: сравнивать внешние
 * порты имеет смысл только если оба запроса ушли с одного локального сокета
 * к разным адресатам.
 */
async function probeServer(server: string, timeoutMs: number): Promise<StunProbe> {
  const connection = new RTCPeerConnection({ iceServers: [{ urls: server }] })
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
        if (event.candidate === null) return void done()

        const parsed = parseCandidateLine(event.candidate.candidate)
        if (parsed !== null) candidates.push(parsed)
      })
    })

    return { server, candidates }
  } finally {
    connection.close()
  }
}

export interface NetworkReport extends NatDiagnosis {
  probes: StunProbe[]
  /** Есть ли у нас глобальный IPv6: с ним NAT не мешает вовсе. */
  ipv6: boolean
}

/**
 * Пре-флайт проверка сети до обмена кодами.
 *
 * Смысл в том, чтобы сказать про symmetric NAT заранее, а не после того, как
 * пользователь впустую переслал код и десять секунд смотрел на «соединение…».
 */
export async function probeNetwork(
  servers: readonly string[],
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<NetworkReport> {
  // Двух серверов достаточно и они обязательны: по одному отличить cone от
  // symmetric невозможно в принципе.
  const targets = servers.slice(0, 2)
  const probes = await Promise.all(targets.map((server) => probeServer(server, timeoutMs)))

  const all = probes.flatMap((probe) => probe.candidates)
  return { ...classifyNat(probes), probes, ipv6: hasGlobalIpv6(all) }
}
