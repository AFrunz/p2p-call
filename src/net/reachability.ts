export type Reachability = 'ok' | 'unreachable' | 'timeout'

/** Сколько ждём ответа сервера, прежде чем считать его молчащим. */
export const REACHABILITY_TIMEOUT_MS = 6000

/** Минимум от WebSocket, который нужен проверке. Подменяется в тестах. */
export interface ProbeSocket {
  addEventListener(type: 'open' | 'error' | 'close', listener: () => void): void
  close(): void
}

export type SocketFactory = (url: string) => ProbeSocket

/**
 * Проверяет, отвечает ли сигнальный сервер.
 *
 * Websocket, а не fetch к `/health`: страница на другом домене, а CORS на
 * сервере нет. Комната не создаётся — без `join` сервер о нас не узнает.
 */
export async function probeSignaling(
  url: string,
  timeoutMs: number = REACHABILITY_TIMEOUT_MS,
  createSocket: SocketFactory = (target) => new WebSocket(target) as ProbeSocket,
): Promise<Reachability> {
  let socket: ProbeSocket
  try {
    socket = createSocket(url)
  } catch {
    // Конструктор падает сразу на некорректном адресе.
    return 'unreachable'
  }

  return new Promise<Reachability>((resolve) => {
    let settled = false

    const finish = (result: Reachability) => {
      if (settled) return
      settled = true

      clearTimeout(timer)
      try {
        socket.close()
      } catch {
        // Сокет мог и не открыться — закрывать нечего.
      }
      resolve(result)
    }

    const timer = setTimeout(() => finish('timeout'), timeoutMs)

    socket.addEventListener('open', () => finish('ok'))
    socket.addEventListener('error', () => finish('unreachable'))
    // Закрытие до открытия — тоже отказ: сервер оборвал рукопожатие.
    socket.addEventListener('close', () => finish('unreachable'))
  })
}

/** Ключ локализации под результат проверки. */
export function reachabilityKey(result: Reachability): string {
  switch (result) {
    case 'ok':
      return 'settings.checkReachable'
    case 'timeout':
      return 'settings.checkTimeout'
    default:
      return 'settings.checkUnreachable'
  }
}
