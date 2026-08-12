/**
 * Переводимое сообщение: модули ядра отдают ключ с подстановками, строку
 * собирает интерфейс. Иначе смена языка требовала бы пересчёта состояния.
 */
export interface Message {
  key: string
  params?: Record<string, string | number>
}

export function message(key: string, params?: Record<string, string | number>): Message {
  return params === undefined ? { key } : { key, params }
}
