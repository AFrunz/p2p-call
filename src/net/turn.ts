/** Публичные STUN разных операторов: чем разнообразнее, тем надёжнее диагностика NAT. */
export const DEFAULT_STUN_SERVERS = [
  'stun:stun.l.google.com:19302',
  'stun:stun.cloudflare.com:3478',
  'stun:stun.nextcloud.com:443',
] as const

export interface TurnConfig {
  url: string
  username: string
  credential: string
}

export interface ParsedTurnUrl {
  scheme: 'turn' | 'turns'
  host: string
  port: number
  transport: 'udp' | 'tcp'
}

export type ValidationResult = { ok: true } | { ok: false; errors: string[] }

const DEFAULT_PORT = { turn: 3478, turns: 5349 } as const
const DEFAULT_TRANSPORT = { turn: 'udp', turns: 'tcp' } as const

/**
 * Разбирает TURN URI по RFC 7065.
 * Порт по умолчанию: 3478 для turn, 5349 для turns.
 * Транспорт по умолчанию: udp для turn, tcp для turns.
 */
export function parseTurnUrl(url: string): ParsedTurnUrl | null {
  const match = /^(turns?):(.+)$/i.exec(url.trim())
  if (match?.[1] === undefined || match[2] === undefined) return null

  const scheme = match[1].toLowerCase() as 'turn' | 'turns'
  let rest = match[2]

  let transport = DEFAULT_TRANSPORT[scheme] as 'udp' | 'tcp'
  const query = rest.indexOf('?')
  if (query >= 0) {
    const parsed = /^transport=(udp|tcp)$/i.exec(rest.slice(query + 1))
    if (parsed?.[1] === undefined) return null
    transport = parsed[1].toLowerCase() as 'udp' | 'tcp'
    rest = rest.slice(0, query)
  }

  let host: string
  let portRaw: string | null = null

  if (rest.startsWith('[')) {
    const close = rest.indexOf(']')
    if (close < 0) return null
    host = rest.slice(1, close)
    const tail = rest.slice(close + 1)
    if (tail.startsWith(':')) portRaw = tail.slice(1)
    else if (tail.length > 0) return null
  } else {
    const colon = rest.lastIndexOf(':')
    if (colon >= 0) {
      host = rest.slice(0, colon)
      portRaw = rest.slice(colon + 1)
    } else {
      host = rest
    }
  }

  if (host.length === 0 || /\s/.test(host)) return null

  let port = DEFAULT_PORT[scheme] as number
  if (portRaw !== null) {
    if (!/^\d+$/.test(portRaw)) return null
    port = Number(portRaw)
    if (port < 1 || port > 65535) return null
  }

  return { scheme, host, port, transport }
}

/** Проверяет конфиг целиком, возвращая все ошибки разом — чтобы форма не мучила по одной. */
export function validateTurnConfig(config: Partial<TurnConfig>): ValidationResult {
  const errors: string[] = []

  const url = config.url?.trim() ?? ''
  if (url.length === 0) errors.push('Укажите адрес TURN-сервера.')
  else if (parseTurnUrl(url) === null) {
    errors.push('Адрес должен выглядеть как turn:example.com:3478 или turns:example.com:5349.')
  }

  if ((config.username ?? '').trim().length === 0) errors.push('Укажите имя пользователя.')
  if ((config.credential ?? '').trim().length === 0) errors.push('Укажите пароль.')

  return errors.length === 0 ? { ok: true } : { ok: false, errors }
}

/**
 * Собирает итоговый список ICE-серверов.
 * TURN опционален: без него остаются только STUN, и это штатный режим работы.
 */
export function buildIceServers(turn?: TurnConfig | null): RTCIceServer[] {
  const servers: RTCIceServer[] = DEFAULT_STUN_SERVERS.map((urls) => ({ urls }))

  // Битый TURN молча пропускаем: сломать из-за него весь ICE куда хуже,
  // чем остаться без ретранслятора.
  if (turn && validateTurnConfig(turn).ok) {
    servers.push({
      urls: turn.url.trim(),
      username: turn.username,
      credential: turn.credential,
    })
  }

  return servers
}
