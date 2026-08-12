import QRCode from 'qrcode'
import { CallSession } from './call/session.js'
import type { SessionView } from './call/session.js'
import { describeMissing, listDevices, requestMedia, stopStream } from './call/media.js'
import { detectTransformSupport } from './call/transform.js'
import { LOCALES, createTranslator, detectLocale, localeName } from './i18n/index.js'
import type { Locale } from './i18n/index.js'
import { isQualityPreset } from './media/quality.js'
import { buildChecks } from './net/checks.js'
import type { NetworkCheck } from './net/checks.js'
import { probeNetwork } from './net/probe.js'
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
import { renderIcons } from './ui/icons.js'

const SCREENS = ['screen-home', 'screen-exchange', 'screen-call'] as const

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
let callStartedAt: number | null = null
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

  if (media.ignoredSavedDevice) {
    settings = { ...settings, cameraId: null, microphoneId: null }
    saveSettings(localStorage, settings)
    toast(t('toast.savedDeviceGone'))
  }

  const problem = media.problem?.message ?? describeMissing(media.missing)
  if (problem !== null) setText('preview-hint', problem)

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

  setDisabled('toggle-mic', !hasAudio, t('controls.micUnavailable'))
  setDisabled('toggle-cam', !hasVideo, t('controls.camUnavailable'))
}

/**
 * Микрофон и камера переключаются одной ручкой и на главном экране, и в звонке.
 * Источник правды — дорожки локального потока, поэтому состояние берём из них.
 */
function toggleTrack(kind: 'audio' | 'video'): void {
  const stream = session?.media.local ?? previewStream
  const tracks = kind === 'audio' ? stream?.getAudioTracks() : stream?.getVideoTracks()
  if (tracks === undefined || tracks.length === 0) return

  const enabled = !(tracks[0]?.enabled ?? false)
  for (const track of tracks) track.enabled = enabled

  session?.setMuted(kind, !enabled)
  setPressed(kind === 'audio' ? 'toggle-mic' : 'toggle-cam', enabled)
  setPressed(kind === 'audio' ? 'call-mic' : 'call-cam', enabled)
  renderPreviewState()
  show('pip-off', kind === 'video' ? !enabled : el('pip-off').hidden === false)
}

async function fillDevices(): Promise<void> {
  const devices = await listDevices()
  const auto = { value: '', label: t('devices.default') }

  fillSelect(
    'select-camera',
    [auto, ...devices.cameras.map((item) => ({ value: item.deviceId, label: item.label }))],
    settings.cameraId ?? '',
  )
  fillSelect(
    'select-microphone',
    [auto, ...devices.microphones.map((item) => ({ value: item.deviceId, label: item.label }))],
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

  const created = new CallSession({
    quality: settings.quality,
    passphrase,
    cameraId: settings.cameraId,
    microphoneId: settings.microphoneId,
    signalingServer: settings.signalingServer,
    pageUrl: `${location.origin}${location.pathname}`,
    network,
  })

  created.subscribe(render)
  session = created
  return created
}

function render(view: SessionView): void {
  if (view.notice !== null && view.notice !== lastNotice) {
    lastNotice = view.notice
    toast(view.notice)
  }
  if (view.phase === 'failed' && view.error !== null) toast(view.error)

  if (view.outgoingCode !== null) {
    el<HTMLTextAreaElement>('outgoing-code').value = view.outgoingCode
    show('outgoing-block', true)
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

function onPhase(view: SessionView): void {
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
    case 'ended':
      stopTimer()
      screen('screen-home')
      break
  }
}

function renderCall(view: SessionView): void {
  setBadge('badge-connection', describeConnection(view.stats?.kind ?? null))

  const encryption = el('badge-encryption')
  encryption.classList.toggle('badge--ok', view.frameEncryption)
  encryption.classList.toggle('badge--warn', !view.frameEncryption)
  setBadge('badge-encryption', t(view.frameEncryption ? 'encryption.e2ee' : 'encryption.transportOnly'))

  if (view.sas !== null) {
    setText('sas-words', view.sas.join(' · '))
    show('sas-block', true)
  }

  show('call-off', view.peerMuted.video)
  show('pip-off', view.muted.video)
  setPressed('call-mic', !view.muted.audio)
  setPressed('call-cam', !view.muted.video)
  setDisabled('call-mic', !view.canSend.audio, t('controls.micUnavailable'))
  setDisabled('call-cam', !view.canSend.video, t('controls.camUnavailable'))

  renderStats(view)
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
    ['stats.outbound', formatBitrate(stats.outboundBitrate)],
    ['stats.inbound', formatBitrate(stats.inboundBitrate)],
    ['stats.latency', formatRoundTrip(stats.roundTripMs)],
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

function startTimer(): void {
  callStartedAt = Date.now()

  const tick = () => {
    const seconds = Math.floor((Date.now() - (callStartedAt ?? Date.now())) / 1000)
    const minutes = String(Math.floor(seconds / 60)).padStart(2, '0')
    setBadge('badge-timer', `${minutes}:${String(seconds % 60).padStart(2, '0')}`)
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
      setText(error, check.error)
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
    const check = validateServerUrl(el<HTMLInputElement>('setting-server').value)
    toast(check.ok ? t('settings.checkOk') : check.error)
  })
  on('action-remove-server', 'click', () => {
    el<HTMLInputElement>('setting-server').value = ''
    inviteLink = ''
    el<HTMLInputElement>('invite-link').value = ''
    settings = { ...settings, signalingServer: null }
    saveSettings(localStorage, settings)
    renderServerPanel()
  })

  on('toggle-mic', 'click', () => toggleTrack('audio'))
  on('toggle-cam', 'click', () => toggleTrack('video'))
  on('call-mic', 'click', () => toggleTrack('audio'))
  on('call-cam', 'click', () => toggleTrack('video'))

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
    void (async () => {
      const created = newSession()
      await created.prepare()
      await created.createCode()
    })()
  })

  on('action-open-join', 'click', () => {
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
    void (async () => {
      const input = el<HTMLTextAreaElement>('incoming-code').value.trim()
      if (input.length === 0) return toast(t('toast.pasteCode'))

      const created = session ?? newSession()
      if (created.media.local === null) await created.prepare()

      // Ссылка и код различаются структурно — спрашивать пользователя незачем.
      if (parseInviteLink(input) !== null) await created.joinLink(input)
      else await created.acceptCode(input)
    })()
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
    void (async () => {
      const created = newSession()
      await created.prepare()
      await created.createLink()
    })()
  })

  for (const id of ['action-copy-link', 'action-copy-link-2']) {
    on(id, 'click', () => void copy(inviteLink, 'toast.linkCopied'))
  }
  on('action-qr-link', 'click', () => void toggleQr('qr-canvas', inviteLink))
  on('action-join-own-link', 'click', () => void session?.joinLink(inviteLink))

  on('action-sas-ok', 'click', () => show('sas-block', false))
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

function start(): void {
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
      const created = newSession()
      await created.prepare()
      await created.joinLink(location.href)
      // Секрет комнаты не должен остаться в истории браузера.
      history.replaceState(null, '', location.pathname)
    })()
  }
}

start()
