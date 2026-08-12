import QRCode from 'qrcode'
import { CallSession } from './call/session.js'
import type { SessionView } from './call/session.js'
import { describeMissing, listDevices, requestMedia, stopStream } from './call/media.js'
import type { DeviceOption } from './call/media.js'
import { detectTransformSupport } from './call/transform.js'
import { LOCALES, createTranslator, detectLocale, localeName } from './i18n/index.js'
import type { Locale } from './i18n/index.js'
import type { Message } from './i18n/message.js'
import { isQualityPreset } from './media/quality.js'
import { buildChecks } from './net/checks.js'
import type { NetworkCheck } from './net/checks.js'
import { probeNetwork } from './net/probe.js'
import { probeSignaling, reachabilityKey } from './net/reachability.js'
import type { NetworkReport } from './net/probe.js'
import { buildIceServers } from './net/turn.js'
import { parseInviteLink } from './signaling/link.js'
import { loadSettings, qualityOptions, saveSettings, validateServerUrl } from './settings.js'
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
} from './ui/dom.js'
import { describeConnection, formatBitrate, formatLoss, formatRoundTrip } from './ui/format.js'
import { iconIn, renderIcons } from './ui/icons.js'

const SCREENS = ['screen-home', 'screen-exchange', 'screen-call', 'screen-ended'] as const

let settings: Settings = loadSettings(localStorage)
let locale: Locale = settings.locale ?? detectLocale(navigator.languages)
let t = createTranslator(locale)

let session: CallSession | null = null
let previewStream: MediaStream | null = null
let network: NetworkReport | null = null
let passphrase: string | null = null
let inviteLink = ''

let lastPhase: SessionView['phase'] | null = null
let lastNotice: string | null = null
let lastError: string | null = null
let callStartedAt: number | null = null
let callSeconds = 0
/** Фразу сверили — больше не навязываемся. */
let sasConfirmed = false
let toggleIcons = { audio: false, video: false }
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
  fillQuality()
  renderLangs()
  renderChecks()
  renderServerPanel()
  renderPassphrase()
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

/** Повторное нажатие прячет код обратно — это переключатель, а не одноразовая кнопка. */
async function toggleQr(canvasId: string, text: string): Promise<void> {
  const canvas = el<HTMLCanvasElement>(canvasId)
  if (!canvas.hidden) return show(canvas, false)

  try {
    await QRCode.toCanvas(canvas, text, { margin: 1, width: 260, errorCorrectionLevel: 'L' })
    show(canvas, true)
  } catch {
    toast(t('toast.qrFailed'))
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

// -------------------------------------------------------------------- превью

async function startPreview(): Promise<void> {
  if (previewStream !== null) return

  const media = await requestMedia({
    preset: settings.quality,
    cameraId: settings.cameraId,
    microphoneId: settings.microphoneId,
  })
  previewStream = media.stream

  // Разрешение получено, но в эфир не идём: включить себя — осознанное действие.
  for (const track of media.stream.getTracks()) track.enabled = false

  attachStream('preview-video', previewStream)
  renderPreviewState()
  setText('preview-hint', t('preview.off'))

  if (media.ignoredSavedDevice) {
    settings = { ...settings, cameraId: null, microphoneId: null }
    saveSettings(localStorage, settings)
    toast(t('toast.savedDeviceGone'))
  }

  // К причине добавляем перепись устройств: «камер: 0, микрофонов: 1» сразу
  // отделяет отсутствие железа от невыданного разрешения.
  const explanation = [media.problem?.text ?? describeMissing(media.missing), media.problem?.details]
    .filter((part): part is Message => part != null)
    .map(tm)

  if (explanation.length > 0) setText('preview-hint', explanation.join(' '))

  await fillDevices()
  syncAvailability()
}

function renderPreviewState(): void {
  const camera = previewStream?.getVideoTracks()[0]
  show('preview-off', camera?.enabled !== true)
}

function syncAvailability(): void {
  const hasAudio = (previewStream?.getAudioTracks().length ?? 0) > 0
  const hasVideo = (previewStream?.getVideoTracks().length ?? 0) > 0

  // Кнопки не блокируем: нажатие — это ещё одна попытка получить устройство.
  el('toggle-mic').title = hasAudio ? '' : t('controls.micUnavailable')
  el('toggle-cam').title = hasVideo ? '' : t('controls.camUnavailable')
}

/**
 * Микрофон и камера переключаются одной ручкой и на главном экране, и в звонке.
 * Источник правды — дорожки локального потока, поэтому состояние берём из них.
 */
async function toggleTrack(kind: 'audio' | 'video'): Promise<void> {
  const stream = session?.media.local ?? previewStream
  let tracks = kind === 'audio' ? stream?.getAudioTracks() : stream?.getVideoTracks()

  // Устройства могло не быть при захвате — занята камера, отозвано разрешение.
  // Спрашиваем ещё раз по нажатию, а не выключаем кнопку до конца сеанса.
  if (stream !== null && stream !== undefined && (tracks === undefined || tracks.length === 0)) {
    const added = await acquireTrack(kind, stream)
    if (!added) return
    tracks = kind === 'audio' ? stream.getAudioTracks() : stream.getVideoTracks()
  }
  if (tracks === undefined || tracks.length === 0) return

  const enabled = !(tracks[0]?.enabled ?? false)
  for (const track of tracks) track.enabled = enabled

  session?.setMuted(kind, !enabled)
  setPressed(kind === 'audio' ? 'toggle-mic' : 'toggle-cam', enabled)
  setPressed(kind === 'audio' ? 'call-mic' : 'call-cam', enabled)
  renderToggleIcons(
    kind === 'audio' ? enabled : toggleIcons.audio,
    kind === 'video' ? enabled : toggleIcons.video,
  )
  renderPreviewState()
  show('pip-off', kind === 'video' ? !enabled : el('pip-off').hidden === false)
}

/** Досдаёт одну дорожку в уже живой поток. */
async function acquireTrack(kind: 'audio' | 'video', stream: MediaStream): Promise<boolean> {
  const media = await requestMedia({
    preset: settings.quality,
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
  if (session !== null) await session.attachTrack(track)

  syncAvailability()
  return true
}

async function fillDevices(): Promise<void> {
  const devices = await listDevices()
  const auto = { value: '', label: t('devices.default') }

  // Живое имя от браузера переводить нечего, а безымянному устройству модуль
  // отдаёт ключ с номером — отсюда разбор по типу.
  const option = (item: DeviceOption) => ({
    value: item.deviceId,
    label: typeof item.label === 'string' ? item.label : tm(item.label),
  })

  fillSelect('select-camera', [auto, ...devices.cameras.map(option)], settings.cameraId ?? '')
  fillSelect(
    'select-microphone',
    [auto, ...devices.microphones.map(option)],
    settings.microphoneId ?? '',
  )
}

async function restartPreview(): Promise<void> {
  stopStream(previewStream)
  previewStream = null
  await startPreview()
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

  el('verdict').dataset['state'] = view.verdict.state
  setText('verdict-title', t(view.verdict.titleKey))
  setText('verdict-note', t(view.verdict.noteKey))

  el('checks').replaceChildren(...view.checks.map(checkRow))

  // Кнопку «поднять сервер» показываем только когда вывод окончательный.
  show('action-goto-server', view.suggestServer)
  show('action-create-code', !view.suggestServer)

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

function renderPassphrase(): void {
  setText('passphrase-value', t(passphrase === null ? 'passphrase.unset' : 'passphrase.set'))
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
    passphrase,
    cameraId: settings.cameraId,
    microphoneId: settings.microphoneId,
    signalingServer: settings.signalingServer,
    pageUrl: `${location.origin}${location.pathname}`,
    network,
    // Камера уже захвачена на главном экране вместе с состоянием тумблеров —
    // просить её второй раз значит заставить человека ждать на ровном месте.
    stream: previewStream,
  })

  created.subscribe(render)
  session = created
  return created
}

function render(view: SessionView): void {
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
  show('outgoing-block', view.outgoingCode !== null)
  if (view.outgoingCode !== null) {
    // Длина рядом с кодом — чтобы обе стороны могли сверить её глазами:
    // выделение мышью в прокрученном поле теряет хвост незаметно.
    const label = t(view.role === 'responder' ? 'exchange.answerCode' : 'exchange.yourCode')
    setText('outgoing-label', `${label} · ${t('exchange.chars', { count: view.outgoingCode.length })}`)
  }
  if (view.inviteLink !== null && view.inviteLink !== inviteLink) {
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
      setText('exchange-title', t('exchange.title'))
      setText('exchange-hint', t('exchange.hint'))
      screen('screen-exchange')
      break

    case 'connected':
      attachStream('remote-video', session?.media.remote ?? null)
      attachStream('local-video', session?.media.local ?? null)
      startTimer()
      screen('screen-call')
      break

    case 'failed':
      // Экран выбирает showFailure: он знает, откуда пришёл провал.
      stopTimer()
      break

    case 'ended':
      stopTimer()
      showEnded(view)
      break
  }
}

function renderCall(view: SessionView): void {
  setBadge('badge-connection', tm(describeConnection(view.stats?.kind ?? null)))

  const encryption = el('badge-encryption')
  encryption.classList.toggle('badge--ok', view.frameEncryption)
  encryption.classList.toggle('badge--warn', !view.frameEncryption)
  setBadge('badge-encryption', t(view.frameEncryption ? 'encryption.e2ee' : 'encryption.transportOnly'))

  // Раньше блок возвращался при каждой перерисовке статистики: показ был
  // привязан только к наличию фразы и не помнил, что её уже сверили.
  if (view.sas !== null && !sasConfirmed) {
    setText('sas-words', view.sas.join(' · '))
    show('sas-block', true)
  }

  show('call-off', view.peerMuted.video)
  show('badge-peer-mic', view.peerMuted.audio)
  show('pip-off', view.muted.video)
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
    ['toggle-mic', audioOn ? 'mic' : 'mic-off'],
    ['call-mic', audioOn ? 'mic' : 'mic-off'],
    ['toggle-cam', videoOn ? 'video' : 'video-off'],
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
    ['stats.loss', formatLoss(stats.packetLoss)],
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

function fillQuality(): void {
  fillSelect(
    'quality-select',
    qualityOptions().map((option) => ({ value: option.value, label: t(option.labelKey) })),
    settings.quality,
  )
}

function openSettings(): void {
  el<HTMLInputElement>('setting-server').value = settings.signalingServer ?? ''
  show('server-error', false)
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
  settings = { ...settings, signalingServer, locale }
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
      status('server-check-status', 'server-check-text', 'settings.checking')
      const result = await probeSignaling(raw.trim())
      status('server-check-status', 'server-check-text', reachabilityKey(result))
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

  on('toggle-mic', 'click', () => void toggleTrack('audio'))
  on('toggle-cam', 'click', () => void toggleTrack('video'))
  on('call-mic', 'click', () => void toggleTrack('audio'))
  on('call-cam', 'click', () => void toggleTrack('video'))

  for (const [id, key] of [
    ['select-camera', 'cameraId'],
    ['select-microphone', 'microphoneId'],
  ] as const) {
    on(id, 'change', (event) => {
      const value = (event.currentTarget as HTMLSelectElement).value
      settings = { ...settings, [key]: value.length > 0 ? value : null }
      saveSettings(localStorage, settings)
      void restartPreview()
    })
  }

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

  on('action-passphrase', 'click', () => {
    const typed = prompt(t('passphrase.prompt'), passphrase ?? '')
    if (typed === null) return

    passphrase = typed.trim().length > 0 ? typed.trim() : null
    renderPassphrase()
  })

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
    show('outgoing-block', false)
    setText('exchange-title', t('exchange.joinTitle'))
    setText('exchange-hint', t('exchange.joinHint'))
    screen('screen-exchange')
  })

  on('action-exchange-back', 'click', () => {
    session?.hangUp()
    session = null
    lastPhase = null
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

  on('action-copy-code', 'click', () => {
    void copy(el<HTMLTextAreaElement>('outgoing-code').value, 'toast.codeCopied')
  })
  on('action-qr-code', 'click', () => {
    void toggleQr('qr-code-canvas', el<HTMLTextAreaElement>('outgoing-code').value)
  })

  on('action-add-server', 'click', openSettings)
  on('action-edit-server', 'click', openSettings)
  on('action-start-session', 'click', () => {
    void withBusy('action-start-session', 'server.starting', async () => {
      const created = newSession()
      await created.prepare()
      await created.createLink()
    })
  })

  for (const id of ['action-copy-link', 'action-copy-link-2']) {
    on(id, 'click', () => void copy(inviteLink, 'toast.linkCopied'))
  }
  on('action-qr-link', 'click', () => void toggleQr('qr-canvas', inviteLink))
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
    session = null
    lastPhase = null
    screen('screen-home')
    // Заодно открываем ту вкладку, с которой звонок и начинался: без сервера
    // это обмен кодами, с сервером — ссылка.
    setTab(settings.signalingServer === null ? 'direct' : 'server')
  })
  on('action-hangup', 'click', () => {
    session?.hangUp()
    session = null
  })

  on('quality-select', 'change', (event) => {
    const value = (event.currentTarget as HTMLSelectElement).value
    if (!isQualityPreset(value)) return

    settings = { ...settings, quality: value }
    saveSettings(localStorage, settings)
    void session?.setQuality(value)
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
  exposeDiagnostics()
  applyTranslations()
  fillQuality()
  renderLangs()
  renderPassphrase()
  setTab('direct')
  renderChecks()
  renderServerPanel()
  wire()
  screen('screen-home')
  renderIcons()

  if (detectTransformSupport() === 'none') toast(t('notice.noFrameEncryption'))

  void startPreview()
  void runDiagnostics()

  // Страница открыта по ссылке-приглашению — подключаемся, ничего не спрашивая.
  if (parseInviteLink(location.href) !== null) {
    void (async () => {
      await startPreview()
      const created = newSession()
      await created.prepare()
      await created.joinLink(location.href)
      // Секрет комнаты не должен остаться в истории браузера.
      history.replaceState(null, '', location.pathname)
    })()
  }
}

start()
