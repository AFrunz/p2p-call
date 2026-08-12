import { createHmac, randomBytes } from 'node:crypto'
import type { Config } from './config.js'
import type { IceServerConfig } from '../../src/protocol/signaling.js'

/**
 * Выпускает временные учётные данные TURN по схеме coturn `use-auth-secret`.
 *
 * Пароль считается из общего секрета, поэтому сам секрет никогда не покидает
 * сервер, а выданная пара протухает через TURN_CREDENTIAL_TTL. Даже утёкшая
 * ссылка не даёт вечного доступа к ретранслятору.
 */
export function mintTurnCredentials(
  secret: string,
  ttlSeconds: number,
  now: number = Date.now(),
): { username: string; credential: string } {
  const expiry = Math.floor(now / 1000) + ttlSeconds
  const username = `${expiry}:${randomBytes(6).toString('hex')}`
  const credential = createHmac('sha1', secret).update(username).digest('base64')

  return { username, credential }
}

/** Собирает список ICE-серверов для конкретного клиента. */
export function buildIceServers(config: Config, now: number = Date.now()): IceServerConfig[] {
  const servers: IceServerConfig[] = [{ urls: [...config.stunServers] }]

  if (config.turnHost === null || config.turnSecret === null) return servers

  const { username, credential } = mintTurnCredentials(
    config.turnSecret,
    config.credentialTtlSeconds,
    now,
  )

  // UDP — основной путь, TCP спасает в сетях, где UDP зарезан целиком.
  const urls = [
    `turn:${config.turnHost}:${config.turnPort}?transport=udp`,
    `turn:${config.turnHost}:${config.turnPort}?transport=tcp`,
  ]
  if (config.turnTls) urls.push(`turns:${config.turnHost}:${config.turnTlsPort}?transport=tcp`)

  servers.push({ urls, username, credential })
  return servers
}
