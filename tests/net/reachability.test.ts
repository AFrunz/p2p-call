import { describe, expect, it, vi } from 'vitest'
import { probeSignaling, reachabilityKey } from '../../src/net/reachability.js'
import type { ProbeSocket } from '../../src/net/reachability.js'

/** Сокет-заглушка: события подаются вручную, закрытия считаются. */
function fakeSocket() {
  const listeners = new Map<string, (() => void)[]>()
  let closed = 0

  const socket: ProbeSocket = {
    addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener])
    },
    close() {
      closed++
    },
  }

  return {
    socket,
    get closed() {
      return closed
    },
    emit(type: 'open' | 'error' | 'close') {
      for (const listener of listeners.get(type) ?? []) listener()
    },
  }
}

describe('probeSignaling', () => {
  it('считает сервер живым, когда сокет открылся', async () => {
    const fake = fakeSocket()
    const result = probeSignaling('wss://call.example.com/ws', 1000, () => fake.socket)

    fake.emit('open')
    expect(await result).toBe('ok')
  })

  it('считает сервер недоступным при ошибке сокета', async () => {
    const fake = fakeSocket()
    const result = probeSignaling('wss://call.example.com/ws', 1000, () => fake.socket)

    fake.emit('error')
    expect(await result).toBe('unreachable')
  })

  it('считает недоступным и закрытие до открытия: сервер оборвал рукопожатие', async () => {
    const fake = fakeSocket()
    const result = probeSignaling('wss://call.example.com/ws', 1000, () => fake.socket)

    fake.emit('close')
    expect(await result).toBe('unreachable')
  })

  it('отличает молчание от отказа по таймауту', async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeSocket()
      const result = probeSignaling('wss://call.example.com/ws', 5000, () => fake.socket)

      vi.advanceTimersByTime(5000)
      expect(await result).toBe('timeout')
    } finally {
      vi.useRealTimers()
    }
  })

  it('всегда закрывает сокет за собой', async () => {
    // Иначе проверка настроек оставляла бы висящее соединение на каждый клик.
    const fake = fakeSocket()
    const result = probeSignaling('wss://call.example.com/ws', 1000, () => fake.socket)

    fake.emit('open')
    await result
    expect(fake.closed).toBe(1)
  })

  it('игнорирует события после первого — результат не переигрывается', async () => {
    const fake = fakeSocket()
    const result = probeSignaling('wss://call.example.com/ws', 1000, () => fake.socket)

    fake.emit('open')
    fake.emit('error')
    fake.emit('close')

    expect(await result).toBe('ok')
    expect(fake.closed).toBe(1)
  })

  it('переживает падение конструктора на битом адресе', async () => {
    const result = await probeSignaling('не адрес', 1000, () => {
      throw new SyntaxError('bad url')
    })
    expect(result).toBe('unreachable')
  })

  it('переживает сокет, который не даёт себя закрыть', async () => {
    const fake = fakeSocket()
    const broken: ProbeSocket = {
      addEventListener: fake.socket.addEventListener.bind(fake.socket),
      close() {
        throw new Error('уже закрыт')
      },
    }

    const result = probeSignaling('wss://call.example.com/ws', 1000, () => broken)
    fake.emit('open')

    expect(await result).toBe('ok')
  })
})

describe('reachabilityKey', () => {
  it('даёт свой ключ на каждый исход', () => {
    const keys = ['ok', 'timeout', 'unreachable'].map((state) =>
      reachabilityKey(state as 'ok' | 'timeout' | 'unreachable'),
    )
    expect(new Set(keys).size).toBe(3)
  })

  it('отличает молчание от отказа: пользователю это разные действия', () => {
    // «Не ответил вовремя» — возможно, сервер жив и просто медленный;
    // «не отвечает» — скорее опечатка в адресе или сервер не запущен.
    expect(reachabilityKey('timeout')).not.toBe(reachabilityKey('unreachable'))
  })
})
