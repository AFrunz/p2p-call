import {
  Activity,
  ArrowDownLeft,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock,
  CircleCheck,
  CircleHelp,
  CircleX,
  Clipboard,
  Copy,
  FileLock2,
  Gauge,
  Globe,
  Info,
  KeyRound,
  LoaderCircle,
  Mic,
  MicOff,
  Minus,
  PhoneOff,
  Plus,
  Server,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Terminal,
  Timer,
  TriangleAlert,
  Unplug,
  UserRound,
  UserRoundCheck,
  UserRoundSearch,
  Video,
  VideoOff,
  Wifi,
  X,
  Zap,
  createIcons,
} from 'lucide'

/**
 * Иконки подключаются поимённо, а не пачкой: полный набор lucide весит около
 * мегабайта, а нам нужно два десятка штук.
 */
const ICONS = {
  Activity,
  ArrowDownLeft,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock,
  CircleCheck,
  CircleHelp,
  CircleX,
  Clipboard,
  Copy,
  FileLock2,
  Gauge,
  Globe,
  Info,
  KeyRound,
  LoaderCircle,
  Mic,
  MicOff,
  Minus,
  PhoneOff,
  Plus,
  Server,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Terminal,
  Timer,
  TriangleAlert,
  Unplug,
  UserRound,
  UserRoundCheck,
  UserRoundSearch,
  Video,
  VideoOff,
  Wifi,
  X,
  Zap,
}

/** Заменяет все `<i data-lucide="...">` на настоящие svg. */
export function renderIcons(): void {
  createIcons({ icons: ICONS })
}

/**
 * Меняет иконку у уже отрисованного элемента.
 *
 * createIcons подменяет `<i>` на `<svg>`, поэтому вернуть `data-lucide` некуда:
 * заводим новый `<i>` на месте старого узла и просим отрисовать заново.
 */
export function swapIcon(node: Element, name: string): void {
  const replacement = document.createElement('i')
  replacement.setAttribute('data-lucide', name)
  for (const className of node.classList) replacement.classList.add(className)
  // Идентификатор переносим тоже: иначе следующая смена состояния уже не
  // найдёт узел, и иконка застынет на втором значении.
  if (node.id.length > 0) replacement.id = node.id

  node.replaceWith(replacement)
  renderIcons()
}

/** Иконка внутри контейнера — то, что нужно менять при смене состояния. */
export function iconIn(container: Element): Element | null {
  return container.querySelector('svg, i[data-lucide]')
}
