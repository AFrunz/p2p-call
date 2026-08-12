export interface Config {
  port: number
  /** Публичный хост TURN. Пусто — сервер работает только как сигналинг. */
  turnHost: string | null
  /** Общий секрет coturn (`static-auth-secret`). Наружу не отдаётся никогда. */
  turnSecret: string | null
  turnPort: number
  /** Включать ли `turns:` — требует настроенного сертификата у coturn. */
  turnTls: boolean
  turnTlsPort: number
  /** Сколько живут выданные учётные данные TURN. */
  credentialTtlSeconds: number
  stunServers: string[]
  maxRooms: number
  /** Через сколько выкидывать комнату, в которой никого не осталось. */
  roomTtlMs: number
  /** Потолок сообщений в секунду на одно соединение. */
  messageRateLimit: number
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

const DEFAULT_STUN = ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478']

/**
 * Читает конфигурацию из окружения и падает сразу, если она противоречива.
 *
 * Молча стартовать с полурабочим TURN нельзя: пользователь узнает об этом
 * только в момент звонка, который не установится.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const turnHost = optional(env['TURN_HOST'])
  const turnSecret = optional(env['TURN_SECRET'])

  if (turnHost !== null && turnSecret === null) {
    throw new ConfigError('Задан TURN_HOST, но не задан TURN_SECRET — TURN не сможет пускать клиентов.')
  }
  if (turnSecret !== null && turnSecret.length < 32) {
    throw new ConfigError('TURN_SECRET короче 32 символов. Сгенерируйте: openssl rand -hex 32')
  }

  const turnTls = flag(env['TURN_TLS'], false)
  if (turnTls && turnHost === null) {
    throw new ConfigError('TURN_TLS=true не имеет смысла без TURN_HOST.')
  }

  return {
    port: number(env['PORT'], 8080, 1, 65535),
    turnHost,
    turnSecret,
    turnPort: number(env['TURN_PORT'], 3478, 1, 65535),
    turnTls,
    turnTlsPort: number(env['TURN_TLS_PORT'], 5349, 1, 65535),
    credentialTtlSeconds: number(env['TURN_CREDENTIAL_TTL'], 3600, 60, 86_400),
    stunServers: list(env['STUN_SERVERS'], DEFAULT_STUN),
    maxRooms: number(env['MAX_ROOMS'], 500, 1, 100_000),
    roomTtlMs: number(env['ROOM_TTL_SECONDS'], 600, 30, 86_400) * 1000,
    messageRateLimit: number(env['MESSAGE_RATE_LIMIT'], 30, 1, 1000),
  }
}

function optional(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  return trimmed.length === 0 ? null : trimmed
}

function number(value: string | undefined, fallback: number, min: number, max: number): number {
  const raw = optional(value)
  if (raw === null) return fallback

  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ConfigError(`Ожидалось целое число от ${min} до ${max}, получено «${raw}».`)
  }
  return parsed
}

function flag(value: string | undefined, fallback: boolean): boolean {
  const raw = optional(value)?.toLowerCase()
  if (raw === null || raw === undefined) return fallback
  if (raw === 'true' || raw === '1' || raw === 'yes') return true
  if (raw === 'false' || raw === '0' || raw === 'no') return false
  throw new ConfigError(`Ожидалось true или false, получено «${raw}».`)
}

function list(value: string | undefined, fallback: string[]): string[] {
  const raw = optional(value)
  if (raw === null) return fallback

  const parsed = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)

  for (const item of parsed) {
    if (!/^stuns?:/i.test(item)) {
      throw new ConfigError(`STUN_SERVERS должен содержать адреса вида stun:host:port, получено «${item}».`)
    }
  }
  return parsed.length > 0 ? parsed : fallback
}
