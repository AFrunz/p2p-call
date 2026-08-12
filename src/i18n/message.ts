/**
 * Переводимое сообщение.
 *
 * Модули ядра не должны знать про текущий язык: они возвращают ключ и
 * подстановки, а превращает это в строку тот, кто рисует интерфейс. Иначе
 * пришлось бы либо таскать переводчик через все слои, либо перезапускать
 * диагностику при переключении языка.
 */
export interface Message {
  key: string
  params?: Record<string, string | number>
}

export function message(key: string, params?: Record<string, string | number>): Message {
  return params === undefined ? { key } : { key, params }
}
