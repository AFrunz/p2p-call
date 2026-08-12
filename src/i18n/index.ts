import { en } from './en.js'
import { ru } from './ru.js'

export type Locale = 'ru' | 'en'

export const LOCALES: readonly Locale[] = ['ru', 'en']

/** Плоский словарь: ключи с точками — обычные строки, вложенности нет. */
export type Dictionary = Readonly<Record<string, string>>

export type Translate = (key: string, params?: Record<string, string | number>) => string

const DICTIONARIES: Record<Locale, Dictionary> = { ru, en }

/** Название языка пишется на нём самом: в списке выбора это единственный способ его узнать. */
const NAMES: Record<Locale, string> = { ru: 'Русский', en: 'English' }

const PLACEHOLDER = /\{([a-zA-Z0-9_]+)\}/g

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value)
}

export function localeName(locale: Locale): string {
  return NAMES[locale]
}

export function dictionary(locale: Locale): Dictionary {
  return DICTIONARIES[locale]
}

/**
 * Выбирает язык по списку `navigator.languages`.
 *
 * Берём первый тег, чей основной субтег поддерживается: порядок в списке — это
 * и есть предпочтение пользователя, и уважать его правильнее, чем угадывать по
 * аудитории проекта. Если не подошло ничего (условный `de-DE`), возвращаем
 * английский: русский интерфейс незнакомому с языком человеку не поможет
 * вообще, а английский хотя бы даёт шанс дойти до переключателя в настройках.
 */
export function detectLocale(navigatorLanguages: readonly string[]): Locale {
  for (const tag of navigatorLanguages) {
    if (typeof tag !== 'string') continue

    // BCP 47 разделяет субтеги дефисом, но некоторые окружения отдают `ru_RU`.
    const primary = tag.trim().toLowerCase().split(/[-_]/)[0]
    if (isLocale(primary)) return primary
  }

  return 'en'
}

/**
 * Возвращает функцию перевода.
 *
 * Неизвестный ключ отдаётся как есть: опечатка в разметке должна быть заметна
 * разработчику, но не ломать интерфейс пользователю.
 */
export function createTranslator(locale: Locale): Translate {
  const dict = DICTIONARIES[locale]

  return (key, params) => {
    // hasOwn, а не `dict[key] ?? key`: иначе ключ вроде `toString` вытащит
    // метод из прототипа Object и вернёт вместо строки функцию.
    const template = Object.hasOwn(dict, key) ? (dict[key] as string) : key
    if (params === undefined) return template

    return template.replace(PLACEHOLDER, (match, name: string) => {
      const value = params[name]
      // Незаполненный плейсхолдер оставляем видимым: тихо подставленная пустота
      // выглядит как готовый текст и прячет ошибку вызывающего кода.
      return value === undefined ? match : String(value)
    })
  }
}
