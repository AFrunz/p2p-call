import { FrameFormatError } from './frame.js'
import { nextKeyId, ratchet } from './kdf.js'
import type { DirectionKeys } from './kdf.js'

/** Сколько поколений ключа держим на приёме: кадры в полёте отстают от ротации. */
export const KEY_HISTORY = 4

/** Идентификатор поколения занимает один байт и заворачивается. */
const KEY_ID_SPACE = 256

/**
 * Ключи приёма с догоняющим храповиком.
 *
 * Отправитель крутит ключи по своему расписанию, а получатель узнаёт о ротации
 * только из номера поколения в кадре. Догонять приходится вслепую, и вот тут
 * важна осторожность: номер приходит от собеседника, а до того, как он навесил
 * шифрование, в этом байте лежит вообще случайный мусор.
 */
export class ReceiverKeys {
  private readonly generations: Map<number, CryptoKey>
  private latest: DirectionKeys
  private latestId = 0

  constructor(keys: DirectionKeys) {
    this.generations = new Map([[0, keys.key]])
    this.latest = keys
  }

  /**
   * Ключ для поколения из кадра.
   *
   * Крутить храповик можно только вперёд и только на несколько шагов — ровно на
   * столько, на сколько отправитель мог уйти. Всё остальное отвергаем, не трогая
   * состояние: иначе один мусорный номер уводит цепочку вперёд, старые поколения
   * вычищаются, и настоящие кадры перестают расшифровываться до конца звонка.
   */
  async keyFor(keyId: number): Promise<CryptoKey> {
    const known = this.generations.get(keyId)
    if (known !== undefined) return known

    const ahead = (keyId - this.latestId + KEY_ID_SPACE) % KEY_ID_SPACE
    if (ahead === 0 || ahead > KEY_HISTORY) {
      throw new FrameFormatError(`неизвестное поколение ключа: ${keyId}`, false)
    }

    for (let step = 0; step < ahead; step++) {
      this.latest = await ratchet(this.latest)
      this.latestId = nextKeyId(this.latestId)
      this.generations.set(this.latestId, this.latest.key)
    }

    // Старые поколения держим ровно столько, сколько нужно кадрам в полёте.
    while (this.generations.size > KEY_HISTORY) {
      const oldest = this.generations.keys().next().value as number
      this.generations.delete(oldest)
    }

    return this.latest.key
  }

  /** Поколения, ключи которых сейчас доступны. Для тестов и диагностики. */
  get known(): number[] {
    return [...this.generations.keys()]
  }
}
