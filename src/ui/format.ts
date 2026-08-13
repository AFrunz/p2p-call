import { message } from '../i18n/message.js'
import type { Message } from '../i18n/message.js'
import type { ConnectionRoute } from '../net/nat.js'

/** Битрейт в человеческом виде: биты — единица, в которой считают каналы связи. */
export function formatBitrate(bitsPerSecond: number): Message {
  if (!Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) return message('format.none')
  if (bitsPerSecond < 1_000_000) {
    return message('format.kbps', { value: Math.round(bitsPerSecond / 1000) })
  }
  // Строка, а не число: у `2.0 Мбит/с` нолик значащий — он показывает точность
  // измерения, а число молча схлопнуло бы его в «2».
  return message('format.mbps', { value: (bitsPerSecond / 1_000_000).toFixed(1) })
}

export function formatRoundTrip(milliseconds: number | null): Message {
  return milliseconds === null ? message('format.none') : message('format.ms', { value: milliseconds })
}

/**
 * Проценты словаря не требуют: `%` интернационален. Ноль потерь показываем как
 * `0%` — прочерк читался бы как «не измеряли».
 */
export function formatLoss(fraction: number): string {
  if (!Number.isFinite(fraction) || fraction <= 0) return '0%'
  // На малых потерях один знак после запятой округлил бы 0.3% до нуля, а это
  // разница между «связь чистая» и «связь сыпется».
  return `${(fraction * 100).toFixed(fraction < 0.01 ? 2 : 1)}%`
}

/**
 * Разрешение картинки.
 *
 * Ключ явный, хотя сама пара чисел одинакова во всех языках. Подставлять
 * готовое значение вместо ключа — значит опираться на фолбэк «неизвестный ключ
 * возвращаем как есть»: работает, но превращает деталь реализации в контракт и
 * рассыплется от первой же проверки «все ключи есть в словаре».
 */
export function formatResolution(width: number | null, height: number | null): Message {
  return width === null || height === null
    ? message('format.none')
    : message('format.resolution', { width, height })
}

/** Подпись о том, каким путём прошло соединение. */
export function describeConnection(route: ConnectionRoute | null): Message {
  switch (route) {
    case 'local':
      return message('route.local')
    case 'ipv6':
      return message('route.ipv6')
    case 'nat':
      return message('route.nat')
    case 'relay':
      return message('route.relay')
    default:
      // Пока пара кандидатов не выбрана, называть соединение прямым нельзя:
      // оно вполне может оказаться ретранслируемым.
      return message('route.pending')
  }
}

/**
 * Что показывать про шифрование.
 *
 * Транспортный слой есть всегда и отключить его нельзя, поэтому «выключено»
 * тут не бывает — бывает «только транспортное», и это надо назвать честно.
 */
export function describeEncryption(frameEncryption: boolean): { text: Message; ok: boolean } {
  return frameEncryption
    ? { text: message('encryption.e2ee'), ok: true }
    : { text: message('encryption.transportOnly'), ok: false }
}
