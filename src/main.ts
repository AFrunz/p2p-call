import { CallSession } from './call/session.js'
import type { SessionView } from './call/session.js'
import { describeMissing, listDevices, requestMedia, stopStream } from './call/media.js'
import type { DeviceOption } from './call/media.js'
import { detectTransformSupport } from './call/transform.js'
import { LOCALES, createTranslator, detectLocale, localeName } from './i18n/index.js'
import type { Locale } from './i18n/index.js'
import type { Message } from './i18n/message.js'
import { FRAME_RATES, QUALITY_PRESETS } from './media/quality.js'
import { buildChecks } from './net/checks.js'
import type { NetworkCheck } from './net/checks.js'
import { probeNetwork } from './net/probe.js'
import { probeSignaling, reachabilityKey } from './net/reachability.js'
import type { NetworkReport } from './net/probe.js'
import { buildIceServers } from './net/turn.js'
import { parseInviteLink } from './signaling/link.js'
import {
  CONNECT_DELAYS,
  isConnectDelay,
  loadSettings,
  saveSettings,
  validateServerUrl,
} from './settings.js'
import type { Settings } from './settings.js'
import {
  attachStream,
  el,
  fillSelect,
  on,
  setDisabled,
  setPressed,
  setText,
  show,
  showOnly,
  silenceBriefly,
} from './ui/dom.js'
import {
  describeConnection,
  formatBitrate,
  formatLoss,
  formatResolution,
  formatRoundTrip,
} from './ui/format.js'
import { iconIn, renderIcons, swapIcon } from './ui/icons.js'

const SCREENS = ['screen-home', 'screen-exchange', 'screen-call', 'screen-ended'] as const

let settings: Settings = loadSettings(localStorage)
let locale: Locale = settings.locale ?? detectLocale(navigator.languages)
let t = createTranslator(locale)

let session: CallSession | null = null
/** Какой список шагов показан сейчас — нужен при смене языка. */
let stepsKind: 'direct' | 'server' = 'direct'
/** Свой код уже скопирован: по этому переходим ко второму шагу мастера. */
let lastCopied = false
/** Последний вид сессии: нужен, чтобы перерисовать мастер, не дожидаясь события. */
let lastView: SessionView | null = null
/** Слой шифрования в прошлой перерисовке — по нему ловим переключение. */
let lastFrameEncryption: boolean | null = null

/** Сколько молчим на переключении слоя, мс. */
const ENCRYPTION_SWITCH_MUTE_MS = 400

/** Сколько висит уведомление о подключении собеседника, мс. */
const PEER_JOINED_MS = 4000
let unsubscribe: (() => void) | null = null
let network: NetworkReport | null = null
let inviteLink = ''

let lastPhase: SessionView['phase'] | null = null
let lastNotice: string | null = null
let lastError: string | null = null
let callStartedAt: number | null = null
let callSeconds = 0
/** Фразу сверили — больше не навязываемся. */
let sasConfirmed = false
let toggleIcons = { audio: false, video: false }
let countdownHandle: ReturnType<typeof setInterval> | null = null
/** Момент, на который уже заведён отсчёт: повторный запуск сбросил бы кольцо. */
let countdownUntil: number | null = null
let timerHandle: ReturnType<typeof setInterval> | null = null
let toastHandle: ReturnType<typeof setTimeout> | null = null

// ------------------------------------------------------------------ переводы

/** Проставляет тексты во всю разметку. Вызывается и при смене языка. */
function applyTranslations(): void {
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    node.textContent = t(node.dataset['i18n'] ?? '')
  }
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n-aria]')) {
    node.setAttribute('aria-label', t(node.dataset['i18nAria'] ?? ''))
  }
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n-placeholder]')) {
    node.setAttribute('placeholder', t(node.dataset['i18nPlaceholder'] ?? ''))
  }

  document.documentElement.lang = locale
  document.title = t('home.title')
}

/** Переводит сообщение, пришедшее из модуля ядра. */
function tm(msg: Message): string {
  return t(msg.key, msg.params)
}

function setLocale(next: Locale): void {
  locale = next
  t = createTranslator(next)
  settings = { ...settings, locale: next }
  saveSettings(localStorage, settings)

  applyTranslations()
  renderQualityPanel()
  fillDelay()
  renderLangs()
  renderChecks()
  renderServerPanel()
  renderIcons()
}

function renderLangs(): void {
  el('langs').replaceChildren(
    ...LOCALES.map((code) => {
      const button = document.createElement('button')
      button.className = code === locale ? 'lang is-active' : 'lang'
      button.textContent = localeName(code)
      button.addEventListener('click', () => setLocale(code))
      return button
    }),
  )
}

// -------------------------------------------------------------------- мелочи

function toast(message: string): void {
  const node = el('toast')
  setText(node, message)
  show(node, true)

  if (toastHandle !== null) clearTimeout(toastHandle)
  toastHandle = setTimeout(() => show(node, false), 4500)
}

async function copy(text: string, messageKey: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast(t(messageKey))
  } catch {
    toast(t('toast.copyFailed'))
  }
}

function screen(name: (typeof SCREENS)[number]): void {
  showOnly([...SCREENS], name)
}

/**
 * Помечает кнопку занятой на время долгой операции.
 *
 * Захват камеры и сбор ICE-кандидатов занимают секунды, и без этого кнопка
 * просто не отзывается — пользователь жмёт её ещё раз и запускает вторую
 * сессию. Повторный клик здесь же и отсекается.
 */
async function withBusy(id: string, busyKey: string, action: () => Promise<void>): Promise<void> {
  const button = el<HTMLButtonElement>(id)
  if (button.dataset['busy'] !== undefined) return

  const restore = button.dataset['i18n']
  const previous = button.textContent ?? ''

  button.dataset['busy'] = ''
  button.disabled = true
  button.textContent = t(busyKey)

  try {
    await action()
  } finally {
    delete button.dataset['busy']
    button.disabled = false
    button.textContent = restore === undefined ? previous : t(restore)
  }
}

/** Строка состояния под кнопками: что происходит прямо сейчас. */
function status(rowId: string, textId: string, key: string | null): void {
  show(rowId, key !== null)
  if (key !== null) setText(textId, t(key))
}

/**
 * Строка состояния с итогом: крутящийся загрузчик обязан смениться на результат.
 *
 * Пока иконка остаётся прежней, строка «сервер отвечает» читается как «всё ещё
 * проверяем» — противоположно тому, что произошло.
 */
function statusResult(rowId: string, textId: string, key: string, ok: boolean): void {
  status(rowId, textId, key)

  const row = el(rowId)
  row.classList.remove('row--busy')
  row.classList.toggle('row--ok', ok)
  row.classList.toggle('row--bad', !ok)

  const current = iconIn(row)
  if (current !== null) swapIcon(current, ok ? 'circle-check' : 'circle-x')
}

// ------------------------------------------------- устройства и качество

/**
 * Отпускает захват после звонка.
 *
 * Пока микрофон захвачен, телефон держит режим разговора: динамик в разговорный,
 * громкость по своей шкале. Раньше это снималось только закрытием вкладки.
 */
function releaseMedia(): void {
  for (const id of ['remote-video', 'local-video', 'waiting-video']) attachStream(id, null)

  renderToggleIcons(false, false)
  setPressed('call-mic', false)
  setPressed('call-cam', false)
  show('pip-off', true)
  closePanels()
}

/**
 * Микрофон и камера переключаются одной ручкой.
 *
 * Источник правды — дорожки локального потока: состояние кнопки выводится из
 * них, а не хранится отдельно, иначе после досдачи дорожки они разъезжаются.
 */
async function toggleTrack(kind: 'audio' | 'video'): Promise<void> {
  const stream = session?.media.local
  if (stream === null || stream === undefined) return

  let tracks = kind === 'audio' ? stream.getAudioTracks() : stream.getVideoTracks()

  // Устройства могло не быть при захвате — занята камера, отозвано разрешение.
  // Спрашиваем ещё раз по нажатию, а не выключаем кнопку до конца звонка.
  if (tracks.length === 0) {
    const added = await acquireTrack(kind, stream)
    if (!added) return
    tracks = kind === 'audio' ? stream.getAudioTracks() : stream.getVideoTracks()
  }
  if (tracks.length === 0) return

  const enabled = !(tracks[0]?.enabled ?? false)
  for (const track of tracks) track.enabled = enabled

  session?.setMuted(kind, !enabled)
  setPressed(kind === 'audio' ? 'call-mic' : 'call-cam', enabled)
  renderToggleIcons(
    kind === 'audio' ? enabled : toggleIcons.audio,
    kind === 'video' ? enabled : toggleIcons.video,
  )
  if (kind === 'video') {
    show('pip-off', !enabled)
    show('waiting-off', !enabled)
  }
}

/** Досдаёт одну дорожку в уже живой поток. */
async function acquireTrack(kind: 'audio' | 'video', stream: MediaStream): Promise<boolean> {
  const media = await requestMedia({
    preset: settings.quality,
    frameRate: settings.frameRate,
    kinds: [kind],
    ...(kind === 'video' ? { cameraId: settings.cameraId } : { microphoneId: settings.microphoneId }),
  })

  const [track] = kind === 'audio' ? media.stream.getAudioTracks() : media.stream.getVideoTracks()
  if (track === undefined) {
    const problem = media.problem?.text ?? describeMissing(media.missing)
    toast(problem === null ? t('controls.camUnavailable') : tm(problem))
    return false
  }

  track.enabled = false
  stream.addTrack(track)
  await session?.attachTrack(track)
  return true
}

/** Строка выбора во всплывающей панели: подпись и галочка у выбранного. */
function optionRow(label: string, active: boolean, onPick: () => void): HTMLButtonElement {
  const row = document.createElement('button')
  row.type = 'button'
  row.className = active ? 'option is-active' : 'option'

  const text = document.createElement('span')
  text.textContent = label
  const mark = document.createElement('i')
  mark.setAttribute('data-lucide', 'check')

  row.append(text, mark)
  row.addEventListener('click', onPick)
  return row
}

async function fillDevices(): Promise<void> {
  const devices = await listDevices()
  const auto = t('devices.default')

  // Живое имя от браузера переводить нечего, а безымянному устройству модуль
  // отдаёт ключ с номером — отсюда разбор по типу.
  const label = (item: DeviceOption) =>
    typeof item.label === 'string' ? item.label : tm(item.label)

  const build = (
    containerId: string,
    list: DeviceOption[],
    current: string | null,
    key: 'cameraId' | 'microphoneId',
  ) => {
    const pick = (value: string | null) => {
      settings = { ...settings, [key]: value }
      saveSettings(localStorage, settings)
      void fillDevices()
      void restartCapture()
    }
    el(containerId).replaceChildren(
      optionRow(auto, current === null, () => pick(null)),
      ...list.map((item) => optionRow(label(item), current === item.deviceId, () => pick(item.deviceId))),
    )
  }

  build('devices-cameras', devices.cameras, settings.cameraId, 'cameraId')
  build('devices-mics', devices.microphones, settings.microphoneId, 'microphoneId')
  renderIcons()
}

function renderQualityPanel(): void {
  setText('quality-label', t(`quality.${settings.quality}`))

  el('quality-options').replaceChildren(
    ...QUALITY_PRESETS.map((preset) =>
      optionRow(t(`quality.${preset}`), preset === settings.quality, () => {
        settings = { ...settings, quality: preset }
        saveSettings(localStorage, settings)
        renderQualityPanel()
        void session?.setQuality(preset, settings.frameRate)
      }),
    ),
  )

  el('framerate-options').replaceChildren(
    ...FRAME_RATES.map((rate) =>
      optionRow(t('quality.fps', { value: rate }), rate === settings.frameRate, () => {
        settings = { ...settings, frameRate: rate }
        saveSettings(localStorage, settings)
        renderQualityPanel()
        void session?.setQuality(settings.quality, rate)
      }),
    ),
  )
  renderIcons()
}

/** Заново берёт устройства после смены камеры или микрофона в звонке. */
async function restartCapture(): Promise<void> {
  const stream = session?.media.local
  if (stream === null || stream === undefined) return

  for (const track of stream.getTracks()) {
    track.stop()
    stream.removeTrack(track)
  }
  for (const kind of ['audio', 'video'] as const) await acquireTrack(kind, stream)
}

function togglePanel(which: 'devices' | 'quality'): void {
  const target = `${which}-panel`
  const open = el(target).hidden
  closePanels()
  show(target, open)
  el(which === 'devices' ? 'action-devices' : 'action-quality').setAttribute(
    'aria-expanded',
    String(open),
  )
  renderIcons()
}

function closePanels(): void {
  for (const [panel, button] of [
    ['devices-panel', 'action-devices'],
    ['quality-panel', 'action-quality'],
  ] as const) {
    show(panel, false)
    el(button).setAttribute('aria-expanded', 'false')
  }
}

/** Вставляет код из буфера: набирать тысячу символов руками никто не станет. */
async function pasteCode(): Promise<void> {
  try {
    const text = await navigator.clipboard.readText()
    if (text.trim().length === 0) return toast(t('toast.clipboardEmpty'))
    el<HTMLTextAreaElement>('incoming-code').value = text.trim()
    renderIncoming()
  } catch {
    toast(t('toast.clipboardDenied'))
  }
}

// --------------------------------------------------------- обмен кодами

/**
 * Показывает состояние поля с чужим кодом.
 *
 * Длину показываем рядом: код переносят копированием, а мессенджеры иногда
 * режут его молча — совпадение чисел на двух устройствах ловит это сразу.
 */
function renderIncoming(): void {
  const value = el<HTMLTextAreaElement>('incoming-code').value.trim()
  const ready = value.length > 0

  setDisabled('action-accept', !ready, '')
  setText(
    'incoming-hint',
    ready ? t('exchange.codeAccepted', { count: value.length }) : t('exchange.noTyping'),
  )
}

/**
 * Мастер обмена кодами: один шаг на экран.
 *
 * Порядок шагов зависит от роли. Создающий сначала отдаёт свой код, потом
 * принимает ответный. Вставляющий чужой код — наоборот, и отсчёт у него
 * запускается сразу, поэтому предупреждение об этом стоит до, а не после.
 */
function renderExchange(view: SessionView): void {
  const responder = view.role === 'responder'
  const hasOutgoing = view.outgoingCode !== null
  const holding = session?.isHoldingCandidates ?? false

  // Шаг определяется тем, что уже сделано, а не отдельным счётчиком: так
  // возврат назад и обновление кода не сбивают нумерацию.
  // Коды разошлись — дальше делать нечего, идёт отсчёт. Это отдельное
  // состояние: обе карточки прячем, чтобы человек не искал, что ещё нажать.
  const counting = holding || view.phase === 'connecting'
  const step = responder ? (hasOutgoing ? 2 : 1) : hasOutgoing && lastCopied ? 2 : 1

  setText('exchange-step-label', t('exchange.step', { current: step, total: 2 }))
  el('progress-2').classList.toggle('is-done', step === 2)

  // Открытое поле принадлежит прошлому шагу: на новом оно только мешает.
  if (counting) {
    show('outgoing-code', false)
    setText('action-show-outgoing', t('exchange.show'))
  }

  show('waiting-block', counting)
  show('outgoing-block', !counting && hasOutgoing && (responder ? step === 2 : step === 1))
  show('incoming-block', !counting && (responder ? step === 1 : step === 2))
  show('exchange-next', !counting && step === 1)
  show('exchange-done', !counting && step === 2)
  if (!counting) placeNextAfter(responder ? 'incoming-block' : 'outgoing-block')

  setText('exchange-done-text', t(responder ? 'exchange.doneIncoming' : 'exchange.doneOutgoing'))
  show('action-show-outgoing', !responder)
  setText(
    'exchange-next-text',
    t(responder ? 'exchange.nextOutgoing' : 'exchange.nextIncoming'),
  )
  setText('outgoing-label', t(responder ? 'exchange.answerTitle' : 'exchange.yourCode'))

  if (view.outgoingCode !== null) {
    setText('outgoing-preview', envelope(view.outgoingCode))
    setText('outgoing-size', t('exchange.size', { count: view.outgoingCode.length }))
  }

  const foot = counting
    ? 'exchange.footRunning'
    : responder
      ? 'exchange.footClock'
      : step === 1
        ? 'exchange.footNoRush'
        : 'exchange.footSettings'
  setText('exchange-foot-text', t(foot))
}

/**
 * Первый шаг для того, кто входит по чужому коду.
 *
 * Сессии здесь ещё нет, а значит и перерисовки по её событиям — экран надо
 * собрать руками, иначе человек видит пустоту.
 */
function showJoinStep(): void {
  setText('exchange-title', t('exchange.joinTitle'))
  setText('exchange-step-label', t('exchange.step', { current: 1, total: 2 }))
  el('progress-2').classList.remove('is-done')

  show('outgoing-block', false)
  show('exchange-done', false)
  show('incoming-block', true)
  show('exchange-next', true)
  placeNextAfter('incoming-block')

  el<HTMLTextAreaElement>('incoming-code').placeholder = t('exchange.joinPlaceholder')
  setText('exchange-next-text', t('exchange.nextOutgoing'))
  setText('exchange-foot-text', t('exchange.footClock'))
  swapIcon(el('exchange-foot-icon'), 'clock')
  renderIncoming()
  renderIcons()
}

/**
 * Ставит подсказку о следующем шаге под активную карточку.
 *
 * Порядок в разметке один, а активная карточка зависит от роли: у входящего по
 * коду это поле ввода, у создающего — свой код. Без перестановки подсказка
 * «2 · отправьте ответный код» оказывается над тем, что нужно сделать первым.
 */
function placeNextAfter(id: string): void {
  el(id).insertAdjacentElement('afterend', el('exchange-next'))
}

/** Начало и конец кода: середину читать всё равно некому. */
function envelope(code: string): string {
  return code.length <= 32 ? code : `${code.slice(0, 12)} … ${code.slice(-12)}`
}

// ------------------------------------------------------- вкладка «Напрямую»

const CHECK_ICON: Record<NetworkCheck['state'], string> = {
  ok: 'circle-check',
  warn: 'triangle-alert',
  fail: 'circle-x',
  pending: 'loader-circle',
}

function renderChecks(): void {
  const view = buildChecks(network)

  el('action-status-toggle').dataset['state'] = view.verdict.state
  setText('verdict-title', t(view.verdict.titleKey))
  setText('verdict-note', t(view.verdict.noteKey))
  swapIcon(el('verdict-icon'), CHECK_ICON[view.verdict.state])

  el('checks').replaceChildren(...view.checks.map(checkRow))

  // Кнопку «поднять сервер» показываем только когда вывод окончательный. Но
  // создание звонка не прячем никогда: проба видит лишь нашу сторону, и
  // запрещать попытку — это обещать больше измеренного, только наоборот.
  show('action-goto-server', view.suggestServer)

  // Шаги зависят от вывода: когда прямое соединение не поднимется, человеку
  // нужен другой список действий, а не тот же самый в неисполнимом виде.
  renderSteps(view.suggestServer ? 'server' : 'direct')

  renderIcons()
}

/** Пошаговая подсказка под статусом: что человеку сделать дальше. */
function renderSteps(kind: 'direct' | 'server'): void {
  stepsKind = kind
  for (const index of [1, 2, 3] as const) {
    setText(`step-${index}`, t(`steps.${kind}.${index}`))
  }
}

/** Раскрывашка: список проверок и сравнение режимов прячутся до нажатия. */
function toggleExpander(buttonId: string, panelId: string): void {
  const button = el(buttonId)
  const open = button.getAttribute('aria-expanded') !== 'true'
  button.setAttribute('aria-expanded', String(open))
  show(panelId, open)
  renderIcons()
}

function checkRow(check: NetworkCheck): HTMLLIElement {
  const row = document.createElement('li')
  row.dataset['state'] = check.state

  const icon = document.createElement('i')
  icon.setAttribute('data-lucide', CHECK_ICON[check.state])

  const text = document.createElement('div')
  const title = document.createElement('span')
  title.textContent = t(check.titleKey)
  const note = document.createElement('span')
  note.textContent = t(check.noteKey, check.params)
  text.append(title, note)

  row.append(icon, text)
  return row
}

async function runDiagnostics(): Promise<void> {
  network = await probeNetwork(buildIceServers().map((server) => String(server.urls)))
  renderChecks()
}

// --------------------------------------------------------------------- табы

function setTab(tab: 'direct' | 'server'): void {
  for (const [id, name] of [
    ['tab-direct', 'direct'],
    ['tab-server', 'server'],
  ] as const) {
    el(id).classList.toggle('is-active', name === tab)
    el(id).setAttribute('aria-selected', String(name === tab))
  }

  show('panel-direct', tab === 'direct')
  show('panel-server', tab === 'server')
}

// -------------------------------------------------- вкладка «Через сервер»

function renderServerPanel(): void {
  const configured = settings.signalingServer !== null
  const hasLink = inviteLink.length > 0

  show('server-empty', !configured)
  show('server-card', configured)
  show('link-card', configured && hasLink)
  show('link-status', configured && hasLink)
  if (configured && hasLink) setText('link-status-text', t('link.waiting'))

  show('action-add-server', !configured)
  show('action-start-session', configured && !hasLink)
  show('action-join-own-link', configured && hasLink)

  if (settings.signalingServer !== null) setText('server-host', hostOf(settings.signalingServer))
  renderIcons()
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

// ------------------------------------------------------------------- звонок

function newSession(): CallSession {
  session?.hangUp()
  hideFailures()
  sasConfirmed = false
  callSeconds = 0
  show('sas-block', false)
  setDisabled('action-accept', false, '')

  const created = new CallSession({
    quality: settings.quality,
    frameRate: settings.frameRate,
    passphrase: null,
    cameraId: settings.cameraId,
    microphoneId: settings.microphoneId,
    signalingServer: settings.signalingServer,
    pageUrl: `${location.origin}${location.pathname}`,
    connectDelay: settings.connectDelay,
    network,
    // Разрешение на камеру и микрофон спрашиваем уже на экране звонка: индикатор
    // записи, зажёгшийся на главном экране, пугает раньше времени.
    deferCapture: true,
    stream: null,
  })

  // Прошлая сессия обязана замолчать: иначе её умирающее соединение
  // продолжает докладывать в интерфейс поверх новой.
  unsubscribe?.()
  unsubscribe = created.subscribe(render)
  session = created
  return created
}

function render(view: SessionView): void {
  lastView = view
  // Сравниваем по ключу: объект каждый раз новый, а повторять один и тот же
  // тост при каждой перерисовке незачем.
  if (view.notice !== null && view.notice.key !== lastNotice) {
    lastNotice = view.notice.key
    toast(tm(view.notice))

    // Обновлённый код надо не просто показать, а объяснить: человек уже
    // отправил прежний и ждёт результата.
    if (view.notice.key === 'session.answerRefreshed') {
      setText('exchange-status-text', tm(view.notice))
      show('exchange-status', true)
    }
  }
  if (view.error !== null && view.error.key !== lastError) {
    lastError = view.error.key
    // Провал заканчивает попытку — про такое нельзя сообщать тостом, который
    // исчезнет через несколько секунд. Остальное (собеседник вышел) — тост.
    if (view.phase === 'failed') showFailure(view)
    else toast(tm(view.error))
  }

  // Пока новый код не готов, поле обязано быть пустым: иначе пользователь
  // копирует код уже уничтоженной сессии и удивляется, почему не соединяется.
  el<HTMLTextAreaElement>('outgoing-code').value = view.outgoingCode ?? ''
  // Отсчёт нужен обеим сторонам: момент общий, и видеть его должны оба.
  const holding = session?.isHoldingCandidates ?? false
  show('answer-sent', holding)
  show('answer-refresh', !holding && view.role === 'responder' && view.outgoingCode !== null)
  renderCountdown(view.startAt, view.holdSeconds)
  renderExchange(view)
  // Закончившийся звонок ссылку больше не отдаёт: иначе очистка на выходе
  // тут же откатывается очередной перерисовкой умирающей сессии.
  const alive = view.phase !== 'ended' && view.phase !== 'failed'
  if (alive && view.inviteLink !== null && view.inviteLink !== inviteLink) {
    inviteLink = view.inviteLink
    el<HTMLInputElement>('invite-link').value = inviteLink
    renderServerPanel()
  }

  renderCall(view)

  if (view.phase !== lastPhase) {
    lastPhase = view.phase
    onPhase(view)
  }
}

/**
 * Показывает провал так, чтобы его успели прочитать.
 *
 * С экрана обмена кодами не уводим: там остались введённые данные и понятно,
 * на каком шаге всё сломалось. Из звонка уводить приходится — звонка больше
 * нет, — но ошибку переносим на главный экран, а не роняем молча.
 */
function showFailure(view: SessionView): void {
  const onExchange = !el('screen-exchange').hidden
  const prefix = onExchange ? 'exchange-error' : 'home-error'
  if (!onExchange) screen('screen-home')

  setText(`${prefix}-note`, view.error === null ? '' : tm(view.error))
  show(`${prefix}-hint`, view.suggestServer)
  show(`${prefix}-server`, view.suggestServer)
  show(prefix, true)
  renderIcons()
}

function hideFailures(): void {
  for (const prefix of ['home-error', 'exchange-error']) show(prefix, false)
  lastError = null
}

function onPhase(view: SessionView): void {
  status('direct-status', 'direct-status-text', view.phase === 'preparing' ? 'status.preparing' : null)
  status(
    'exchange-status',
    'exchange-status-text',
    view.phase === 'connecting' ? 'status.connecting' : view.phase === 'awaiting-exchange' ? 'status.waitingCode' : null,
  )
  if (view.phase === 'connecting') {
    // Отвечающий ждёт не сеть, а человека: пока код не вставили на той
    // стороне, ICE даже не начинал проверять пары.
    const waitingForPeer =
      view.role === 'responder' && (view.iceState === null || view.iceState === 'new')

    setText(
      'exchange-status-text',
      waitingForPeer
        ? t('status.sendAnswer')
        : `${t('status.connecting')}${view.iceState === null ? '' : ` (${view.iceState})`}`,
    )
  }
  if (view.phase === 'connecting' && inviteLink.length > 0) {
    setText('link-status-text', t('link.peerJoined'))
  }

  switch (view.phase) {
    case 'awaiting-exchange':
      // Со своим сервером обмена кодами нет вовсе: ссылка уже создана, и ждать
      // собеседника человек должен в звонке, где может проверить себя.
      setText('exchange-title', t('exchange.title'))
      screen('screen-exchange')
      break

    case 'awaiting-peer':
      // Ссылка готова: человек ждёт собеседника прямо в звонке и может
      // проверить себя, пока тот идёт по ссылке.
      void enterCall()
      break

    case 'connected': {
      const remote = session?.media.remote ?? null
      console.debug(
        `[p2p] входящие дорожки: ${(remote?.getTracks() ?? [])
          .map((track) => `${track.kind}(${track.enabled ? 'вкл' : 'выкл'},${track.readyState})`)
          .join(', ') || 'ни одной'}`,
      )

      attachStream('remote-video', remote)
      startTimer()
      // В режиме с кодами это первый экран звонка: захват дорожек происходит
      // здесь, а не в комнате ожидания, которой в этом сценарии нет.
      void enterCall()

      // Подключение собеседника — событие, которое легко пропустить: человек
      // мог отойти. Показываем его отдельно, а не только сменой картинки.
      if (view.inviteLink !== null) flashPeerJoined()
      break
    }

    case 'failed':
      // Экран выбирает showFailure: он знает, откуда пришёл провал.
      stopTimer()
      releaseMedia()
      break

    case 'ended':
      stopTimer()
      releaseMedia()
      showEnded(view)
      break
  }
}

/**
 * Переводит на экран звонка и только там просит устройства.
 *
 * Камера и микрофон включаются выключенными: войти в разговор молча — это
 * осознанный выбор, а не забытая настройка.
 */
async function enterCall(): Promise<void> {
  screen('screen-call')
  attachStream('waiting-video', session?.media.local ?? null)
  attachStream('local-video', session?.media.local ?? null)

  const stream = session?.media.local
  if (stream !== null && stream !== undefined && stream.getTracks().length === 0) {
    for (const kind of ['audio', 'video'] as const) await acquireTrack(kind, stream)
    attachStream('waiting-video', stream)
    attachStream('local-video', stream)
  }

  await fillDevices()
  renderQualityPanel()
  // Перерисовку не зовём: она пришла бы со старым видом, снятым до захвата
  // дорожек, и погасила бы уже правильные значки. Свежий вид принесёт сессия.
}

/**
 * Забывает закончившийся звонок.
 *
 * Ссылка-приглашение живёт ровно одну сессию: комната по ней уже занята
 * прошлым разговором, а вернувшись на вкладку сервера, человек ждёт кнопку
 * «начать», а не чужой адрес из прошлого. Коды в полях — по той же причине.
 */
function forgetSession(): void {
  session = null
  lastPhase = null
  lastCopied = false
  lastView = null
  countdownUntil = null

  inviteLink = ''
  el<HTMLInputElement>('invite-link').value = ''
  el<HTMLTextAreaElement>('outgoing-code').value = ''
  el<HTMLTextAreaElement>('incoming-code').value = ''
  show('outgoing-code', false)

  renderServerPanel()
}

/** Короткое уведомление о том, что собеседник вошёл в комнату. */
function flashPeerJoined(): void {
  show('peer-joined', true)
  renderIcons()
  setTimeout(() => show('peer-joined', false), PEER_JOINED_MS)
}

function renderCall(view: SessionView): void {
  // Со своим сервером человек попадает в звонок сразу после создания ссылки и
  // ждёт там: так он успевает проверить себя, пока второй идёт по ссылке.
  const waiting = view.inviteLink !== null && !view.peerPresent && view.phase !== 'ended'
  setBadge(
    'badge-route',
    waiting ? t('call.waitingBadge') : tm(describeConnection(view.stats?.route ?? null)),
  )
  el('badge-route').classList.toggle('badge--warn', waiting)
  show('call-waiting', waiting)
  show('badge-timer', !waiting)
  // В ожидании своё видео уже занимает середину экрана — маленькое окно в углу
  // показывало бы то же самое второй раз.
  show('pip', !waiting)

  // Смена слоя шифрования — момент, когда декодер получает кадры по старым
  // правилам и выдаёт их резким щелчком прямо в наушники.
  if (lastFrameEncryption !== null && lastFrameEncryption !== view.frameEncryption) {
    silenceBriefly('remote-video', ENCRYPTION_SWITCH_MUTE_MS)
  }
  lastFrameEncryption = view.frameEncryption

  const encryption = el('badge-encryption')
  encryption.classList.toggle('badge--ok', view.frameEncryption)
  encryption.classList.toggle('badge--warn', !view.frameEncryption)
  setBadge('badge-encryption', t(view.frameEncryption ? 'encryption.e2ee' : 'encryption.transportOnly'))
  renderEncryptionTip(view.frameEncryption)

  // Раньше блок возвращался при каждой перерисовке статистики: показ был
  // привязан только к наличию фразы и не помнил, что её уже сверили.
  if (view.sas !== null && !sasConfirmed) {
    setText('sas-words', view.sas.join(' · '))
    show('sas-block', true)
  }

  show('call-off', view.peerMuted.video && !waiting)
  show('peer-mic-off', view.peerMuted.audio && !waiting)
  // Значок нужен и в комнате ожидания: человек проверяет себя именно там, и
  // выключенный микрофон должен быть виден сразу, а не после первого нажатия.
  const micOff = view.muted.audio && view.canSend.audio
  show('self-mic-off', micOff)
  show('waiting-mic-off', micOff)
  show('pip-off', view.muted.video)
  show('waiting-off', view.muted.video)
  setPressed('call-mic', !view.muted.audio)
  setPressed('call-cam', !view.muted.video)
  el('call-mic').title = view.canSend.audio ? '' : t('controls.micUnavailable')
  el('call-cam').title = view.canSend.video ? '' : t('controls.camUnavailable')
  renderToggleIcons(!view.muted.audio, !view.muted.video)

  renderStats(view)
}

/**
 * Иконка тумблера должна показывать текущее состояние, а не одно и то же
 * перечёркнутое изображение: по нему невозможно понять, включён микрофон или нет.
 */
function renderToggleIcons(audioOn: boolean, videoOn: boolean): void {
  if (toggleIcons.audio === audioOn && toggleIcons.video === videoOn) return
  toggleIcons = { audio: audioOn, video: videoOn }

  const wanted: [string, string][] = [
    ['call-mic', audioOn ? 'mic' : 'mic-off'],
    ['call-cam', videoOn ? 'video' : 'video-off'],
  ]

  for (const [id, name] of wanted) {
    const current = iconIn(el(id))
    if (current === null) continue

    const replacement = document.createElement('i')
    replacement.setAttribute('data-lucide', name)
    current.replaceWith(replacement)
  }
  renderIcons()
}

/**
 * Подсказка у бейджа шифрования: два слоя, у каждого отметка и строка о том,
 * кто именно не услышит. Названия слоёв человеку ничего не говорят, поэтому
 * пункты названы по тому, от кого они защищают.
 */
function renderEncryptionTip(frameEncryption: boolean): void {
  const item = el('tip-e2ee')
  const icon = item.querySelector('i')
  if (icon !== null) {
    const replacement = document.createElement('i')
    replacement.setAttribute('data-lucide', frameEncryption ? 'circle-check' : 'circle-x')
    icon.replaceWith(replacement)
  }
  item.classList.toggle('is-off', !frameEncryption)

  const title = item.querySelector('strong')
  if (title !== null) title.textContent = t(frameEncryption ? 'encryption.server' : 'encryption.serverOff')
  setText('tip-e2ee-note', t(frameEncryption ? 'encryption.serverNote' : 'encryption.serverOffNote'))
  renderIcons()
}

/** У бейджа первый ребёнок — иконка, подпись всегда во втором. */
function setBadge(id: string, text: string): void {
  const label = el(id).querySelector('span')
  if (label !== null) label.textContent = text
}

function renderStats(view: SessionView): void {
  const stats = view.stats
  if (stats === null) return

  const cells: [string, string][] = [
    ['stats.outbound', tm(formatBitrate(stats.outboundBitrate))],
    ['stats.inbound', tm(formatBitrate(stats.inboundBitrate))],
    ['stats.latency', tm(formatRoundTrip(stats.roundTripMs))],
    ['stats.jitter', tm(formatRoundTrip(stats.jitterMs))],
    ['stats.loss', formatLoss(stats.packetLoss)],
    [
      'stats.mic',
      stats.micLevel === null ? '—' : `${Math.round(stats.micLevel * 100)}%`,
    ],
    ['stats.resolution', tm(formatResolution(stats.frameWidth, stats.frameHeight))],
    ['stats.fps', stats.fps === null ? '—' : String(Math.round(stats.fps))],
  ]

  el('stats').replaceChildren(
    ...cells.map(([key, value]) => {
      const cell = document.createElement('div')
      const name = document.createElement('span')
      name.textContent = t(key)
      const amount = document.createElement('span')
      amount.textContent = value
      cell.append(name, amount)
      return cell
    }),
  )
}

/** Итог звонка: почему он закончился и сколько длился. */
function showEnded(view: SessionView): void {
  const reason = view.endReason ?? 'local'

  setText('ended-title', t(`ended.${reason}.title`))
  setText('ended-note', t(`ended.${reason}.note`))

  const duration = callSeconds > 0
  show('ended-duration', duration)
  if (duration) setText('ended-duration', t('ended.duration', { value: clock(callSeconds) }))

  const icon = iconIn(el('screen-ended'))
  if (icon !== null) {
    const replacement = document.createElement('i')
    replacement.setAttribute('data-lucide', reason === 'lost' ? 'unplug' : 'phone-off')
    icon.replaceWith(replacement)
  }

  screen('screen-ended')
  renderIcons()
}

function clock(seconds: number): string {
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

/** Обратный отсчёт до общего старта проверки. */
/**
 * Обратный отсчёт до общего момента старта.
 *
 * Кольцо, а не строка: человеку важно не точное число, а сколько осталось —
 * взгляда на заполненность хватает, чтобы решить, успевает он отправить код
 * или пора обновлять.
 */
function renderCountdown(startAt: number | null, holdSeconds: number): void {
  // Перерисовки приходят часто — от статистики звонка до смены состояния
  // кнопок. Перезапуск таймера на каждой из них сбрасывал бы кольцо.
  if (startAt === countdownUntil) return
  countdownUntil = startAt

  if (countdownHandle !== null) clearInterval(countdownHandle)
  countdownHandle = null

  if (startAt === null) return

  // Полная шкала — заданное окно на перенос кода, а не остаток на момент
  // первой отрисовки: иначе кольцо каждый раз начинается заново от текущего.
  const total = Math.max(1, holdSeconds)

  const tick = () => {
    const left = Math.max(0, Math.round((startAt - Date.now()) / 1000))
    setText('countdown-value', left === 0 ? '—' : clock(left))
    el('countdown-ring').style.setProperty('--progress', String(left / total))
    setText(
      'countdown-hint',
      left === 0 ? t('exchange.countdownNow') : t('exchange.countdown', { value: clock(left) }),
    )
    if (left === 0 && countdownHandle !== null) {
      clearInterval(countdownHandle)
      countdownHandle = null
    }
  }

  tick()
  countdownHandle = setInterval(tick, 1000)
}

function startTimer(): void {
  callStartedAt = Date.now()

  const tick = () => {
    callSeconds = Math.floor((Date.now() - (callStartedAt ?? Date.now())) / 1000)
    setBadge('badge-timer', clock(callSeconds))
  }

  tick()
  timerHandle ??= setInterval(tick, 1000)
}

function stopTimer(): void {
  if (timerHandle !== null) clearInterval(timerHandle)
  timerHandle = null
  callStartedAt = null
}

// ---------------------------------------------------------------- настройки

function fillDelay(): void {
  fillSelect(
    'setting-delay',
    CONNECT_DELAYS.map((value) => ({
      value: String(value),
      label: t('settings.delaySeconds', { value }),
    })),
    String(settings.connectDelay),
  )
}

function openSettings(): void {
  el<HTMLInputElement>('setting-server').value = settings.signalingServer ?? ''
  show('server-error', false)
  fillDelay()
  renderLangs()
  show('screen-settings', true)
}

function saveSettingsForm(): boolean {
  const raw = el<HTMLInputElement>('setting-server').value.trim()
  const error = el('server-error')

  let signalingServer: string | null = null
  if (raw.length > 0) {
    const check = validateServerUrl(raw)
    if (!check.ok) {
      setText(error, tm(check.error))
      show(error, true)
      return false
    }
    signalingServer = raw
  }

  show(error, false)
  const delay = Number(el<HTMLSelectElement>('setting-delay').value)
  settings = {
    ...settings,
    signalingServer,
    locale,
    connectDelay: isConnectDelay(delay) ? delay : settings.connectDelay,
  }
  saveSettings(localStorage, settings)
  renderServerPanel()
  return true
}

// ------------------------------------------------------------------ события

function wire(): void {
  on('action-settings', 'click', openSettings)
  on('action-close-settings', 'click', () => show('screen-settings', false))
  on('action-save-settings', 'click', () => {
    if (!saveSettingsForm()) return
    show('screen-settings', false)
    toast(t('toast.settingsSaved'))
  })
  on('action-check-server', 'click', () => {
    const raw = el<HTMLInputElement>('setting-server').value
    const check = validateServerUrl(raw)
    if (!check.ok) return status('server-check-status', 'server-check-text', check.error.key)

    void withBusy('action-check-server', 'settings.checking', async () => {
      el('server-check-status').classList.add('row--busy')
      el('server-check-status').classList.remove('row--ok', 'row--bad')
      const spinner = iconIn(el('server-check-status'))
      if (spinner !== null) swapIcon(spinner, 'loader-circle')
      status('server-check-status', 'server-check-text', 'settings.checking')

      const result = await probeSignaling(raw.trim())
      statusResult('server-check-status', 'server-check-text', reachabilityKey(result), result === 'ok')
    })
  })
  on('action-remove-server', 'click', () => {
    el<HTMLInputElement>('setting-server').value = ''
    inviteLink = ''
    el<HTMLInputElement>('invite-link').value = ''
    settings = { ...settings, signalingServer: null }
    saveSettings(localStorage, settings)
    renderServerPanel()
  })

  on('call-mic', 'click', () => void toggleTrack('audio'))
  on('call-cam', 'click', () => void toggleTrack('video'))

  on('action-mode-help', 'click', () => toggleExpander('action-mode-help', 'mode-help'))
  on('action-status-toggle', 'click', () => toggleExpander('action-status-toggle', 'checks'))
  on('action-stats-toggle', 'click', () => toggleExpander('action-stats-toggle', 'stats'))

  // Панели устройств и качества взаимно исключают друг друга: две всплывашки
  // над кнопками перекрыли бы и звонок, и друг друга.
  on('action-devices', 'click', () => togglePanel('devices'))
  on('action-quality', 'click', () => togglePanel('quality'))

  for (const prefix of ['home-error', 'exchange-error']) {
    on(`${prefix}-close`, 'click', () => show(prefix, false))
    on(`${prefix}-server`, 'click', () => {
      hideFailures()
      screen('screen-home')
      setTab('server')
    })
  }

  on('tab-direct', 'click', () => setTab('direct'))
  on('tab-server', 'click', () => setTab('server'))
  on('action-goto-server', 'click', () => setTab('server'))


  on('action-create-code', 'click', () => {
    void withBusy('action-create-code', 'direct.creating', async () => {
      const created = newSession()
      await created.prepare()
      status('direct-status', 'direct-status-text', 'status.gathering')
      await created.createCode()
      status('direct-status', 'direct-status-text', null)
    })
  })

  on('action-open-join', 'click', () => {
    // Сессия могла остаться от прошлой попытки «Создать звонок»: тогда код
    // собеседника ушёл бы не в ту ветку и был бы отвергнут как чужая роль.
    session?.hangUp()
    session = null
    lastPhase = null

    hideFailures()
    setDisabled('action-accept', false, '')
    el<HTMLTextAreaElement>('outgoing-code').value = ''
    el<HTMLTextAreaElement>('incoming-code').value = ''
    screen('screen-exchange')
    showJoinStep()
  })

  on('action-paste-code', 'click', () => void pasteCode())
  on('action-show-outgoing', 'click', () => {
    const box = el<HTMLTextAreaElement>('outgoing-code')
    const opening = box.hidden
    show('outgoing-code', opening)
    box.value = lastView?.outgoingCode ?? box.value
    setText('action-show-outgoing', t(opening ? 'exchange.hide' : 'exchange.show'))
    if (opening) box.select()
  })
  on('action-copy-link-3', 'click', () => void copy(inviteLink, 'toast.linkCopied'))

  on('action-exchange-back', 'click', () => {
    session?.hangUp()
    forgetSession()
    screen('screen-home')
  })

  on('action-accept', 'click', () => {
    const input = el<HTMLTextAreaElement>('incoming-code').value.trim()
    if (input.length === 0) return toast(t('toast.pasteCode'))

    void withBusy('action-accept', 'exchange.connecting', async () => {
      const created = session ?? newSession()
      if (created.media.local === null) await created.prepare()

      status('exchange-status', 'exchange-status-text', 'status.gathering')
      // Ссылка и код различаются структурно — спрашивать пользователя незачем.
      if (parseInviteLink(input) !== null) await created.joinLink(input)
      else await created.acceptCode(input)
    }).then(() => {
      // Код применён — принимать его повторно нечего. Второй вызов
      // setRemoteDescription в стабильном состоянии просто падает, а кнопка
      // после снятия занятости выглядит готовой к нажатию.
      if (session?.phase === 'connecting' || session?.phase === 'connected') {
        setDisabled('action-accept', true, '')
      }
    })
  })

  // Клик по полю выделяет код целиком: иначе в прокрученном поле легко
  // захватить только видимую часть и не заметить этого.
  for (const event of ['focus', 'click'] as const) {
    on('outgoing-code', event, () => el<HTMLTextAreaElement>('outgoing-code').select())
  }

  // Поле приёма тоже выделяется целиком: иначе вставка дописывается к
  // остаткам прошлой попытки, и код склеивается из двух разных.
  on('incoming-code', 'focus', () => el<HTMLTextAreaElement>('incoming-code').select())

  on('incoming-code', 'input', () => {
    const length = el<HTMLTextAreaElement>('incoming-code').value.trim().length
    setText(
      'incoming-label',
      length === 0 ? t('exchange.peerCode') : `${t('exchange.peerCode')} · ${t('exchange.chars', { count: length })}`,
    )
  })

  on('action-refresh-answer', 'click', () => {
    void withBusy('action-refresh-answer', 'exchange.connecting', async () => {
      const ok = await session?.refreshAnswer(true)
      if (ok === true) {
        toast(t('exchange.refreshed'))
        show('answer-sent', true)
        show('answer-refresh', false)
      }
    })
  })

  on('incoming-code', 'input', renderIncoming)

  on('action-copy-code', 'click', () => {
    // Шаг меняется сразу: ждать очередного события сессии значит показать поле
    // для чужого кода с задержкой в секунду.
    lastCopied = true
    if (lastView !== null) renderExchange(lastView)
    void copy(el<HTMLTextAreaElement>('outgoing-code').value, 'toast.codeCopied')
  })

  on('action-add-server', 'click', openSettings)
  on('action-edit-server', 'click', openSettings)
  on('action-start-session', 'click', () => {
    void withBusy('action-start-session', 'server.starting', async () => {
      const created = newSession()
      // Сначала ссылка: она переводит человека в комнату ожидания, и уже там
      // спрашиваются камера с микрофоном.
      await created.prepare()
      await created.createLink()
    })
  })

  for (const id of ['action-copy-link', 'action-copy-link-2']) {
    on(id, 'click', () => void copy(inviteLink, 'toast.linkCopied'))
  }
  on('action-join-own-link', 'click', () => {
    void withBusy('action-join-own-link', 'link.joining', async () => {
      await session?.joinLink(inviteLink)
    })
  })

  on('action-sas-ok', 'click', () => {
    sasConfirmed = true
    show('sas-block', false)
  })

  on('action-back-home', 'click', () => {
    forgetSession()
    screen('screen-home')
    // Заодно открываем ту вкладку, с которой звонок и начинался: без сервера
    // это обмен кодами, с сервером — ссылка.
    setTab(settings.signalingServer === null ? 'direct' : 'server')
  })
  on('action-hangup', 'click', () => {
    session?.hangUp()
    // Экран завершения покажет render по фазе; ссылку и коды забываем сразу,
    // чтобы следующая сессия начиналась с чистой вкладки сервера.
    forgetSession()
  })

  window.addEventListener('beforeunload', () => session?.hangUp())
}

// -------------------------------------------------------------------- запуск

/** Отладочный доступ из консоли: `__p2p.stats()` и `__p2p.state()`. */
function exposeDiagnostics(): void {
  Object.defineProperty(window, '__p2p', {
    value: {
      stats: () => session?.diagnose() ?? console.debug('[p2p] звонка нет'),
      state: () => ({ phase: session?.phase ?? 'idle', network, inviteLink }),
    },
    configurable: true,
  })
}

function start(): void {
  // Разметка становится видимой, когда стили применены и иконки отрисованы:
  // до этого показывать нечего, кроме голого html.
  document.body.classList.add('is-ready')
  exposeDiagnostics()
  applyTranslations()
  renderQualityPanel()
  renderLangs()
  setTab('direct')
  renderChecks()
  renderServerPanel()
  wire()
  screen('screen-home')
  renderIcons()

  if (detectTransformSupport() === 'none') toast(t('notice.noFrameEncryption'))

  void runDiagnostics()

  // Страница открыта по ссылке-приглашению — подключаемся, ничего не спрашивая.
  void followInviteLink(location.href)

  // Секрет комнаты живёт во фрагменте, а переход на тот же адрес с другим
  // фрагментом страницу не перезагружает: без этого вторая ссылка, открытая
  // из уже запущенного приложения, просто ничего не делала бы.
  window.addEventListener('hashchange', () => void followInviteLink(location.href))
}

/** Открывает приглашение, если по адресу лежит именно оно. */
async function followInviteLink(url: string): Promise<void> {
  if (parseInviteLink(url) === null) return

  const created = newSession()
  await created.prepare()
  await created.joinLink(url)
  // Секрет комнаты не должен остаться в истории браузера.
  history.replaceState(null, '', location.pathname)
}

start()
