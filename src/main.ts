import QRCode from 'qrcode'
import { CallSession } from './call/session.js'
import type { SessionView } from './call/session.js'
import { describeMissing, listDevices, requestMedia, stopStream } from './call/media.js'
import { detectTransformSupport } from './call/transform.js'
import { isQualityPreset } from './media/quality.js'
import type { QualityPreset } from './media/quality.js'
import { parseInviteLink } from './signaling/link.js'
import {
  loadSettings,
  qualityOptions,
  saveSettings,
  validateServerUrl,
} from './settings.js'
import type { Settings } from './settings.js'
import {
  describeConnection,
  describeEncryption,
  formatBitrate,
  formatLoss,
  formatResolution,
  formatRoundTrip,
} from './ui/format.js'

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (node === null) throw new Error(`нет элемента #${id}`)
  return node as T
}

const screens = {
  start: el('screen-start'),
  exchange: el('screen-exchange'),
  invite: el('screen-invite'),
  call: el('screen-call'),
  settings: el('screen-settings'),
}

type ScreenName = keyof typeof screens

function show(name: ScreenName): void {
  for (const [key, node] of Object.entries(screens)) node.hidden = key !== name
}

let toastTimer: ReturnType<typeof setTimeout> | null = null

function toast(message: string): void {
  const node = el('toast')
  node.textContent = message
  node.hidden = false

  if (toastTimer !== null) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    node.hidden = true
  }, 4000)
}

async function renderQr(canvas: HTMLCanvasElement, text: string): Promise<void> {
  try {
    await QRCode.toCanvas(canvas, text, { margin: 1, width: 260, errorCorrectionLevel: 'L' })
    canvas.hidden = false
  } catch {
    toast('Не удалось построить QR — слишком длинный код.')
  }
}

// --- состояние приложения ---------------------------------------------------

let settings: Settings = loadSettings(localStorage)
let passphrase: string | null = null
let session: CallSession | null = null
let previewStream: MediaStream | null = null

function newSession(): CallSession {
  session?.hangUp()

  const created = new CallSession({
    quality: settings.quality,
    passphrase,
    cameraId: settings.cameraId,
    microphoneId: settings.microphoneId,
    signalingServer: settings.signalingServer,
    pageUrl: `${location.origin}${location.pathname}`,
  })

  created.subscribe(render)
  session = created
  return created
}

// --- отрисовка --------------------------------------------------------------

let lastPhase: SessionView['phase'] | null = null
let lastNotice: string | null = null

function render(view: SessionView): void {
  if (view.error !== null && view.phase === 'failed') toast(view.error)

  if (view.outgoingCode !== null) {
    el<HTMLTextAreaElement>('outgoing-code').value = view.outgoingCode
    el('outgoing-block').hidden = false
  }

  if (view.inviteLink !== null) {
    el<HTMLInputElement>('invite-link').value = view.inviteLink
  }

  renderSas(view)
  renderBadges(view)
  renderStats(view)
  renderPeerState(view)
  renderControls(view)

  if (view.notice !== null && view.notice !== lastNotice) {
    lastNotice = view.notice
    toast(view.notice)
  }

  if (view.phase !== lastPhase) {
    lastPhase = view.phase
    onPhase(view)
  }
}

function onPhase(view: SessionView): void {
  switch (view.phase) {
    case 'awaiting-exchange':
      el('exchange-title').textContent = 'Передайте код собеседнику'
      el('exchange-hint').textContent =
        'Отправьте свой код любым способом и вставьте сюда тот, что пришлёт он в ответ.'
      show('exchange')
      break

    case 'awaiting-peer':
      el('invite-status').textContent = 'Ожидаем собеседника…'
      show('invite')
      break

    case 'connected':
      attachVideos()
      show('call')
      break

    case 'failed':
    case 'ended':
      stopPreview()
      show('start')
      break
  }
}

function renderSas(view: SessionView): void {
  const block = el('sas-block')
  if (view.sas === null) {
    block.hidden = true
    return
  }
  el('sas-words').textContent = view.sas.join(' · ')
  block.hidden = false
}

function renderBadges(view: SessionView): void {
  const connection = el('badge-connection')
  connection.textContent = describeConnection(view.stats?.kind ?? null)

  const encryption = describeEncryption(view.frameEncryption)
  const badge = el('badge-encryption')
  badge.textContent = encryption.text
  badge.className = `badge ${encryption.ok ? 'badge--ok' : 'badge--warn'}`

  const viewer = el('badge-viewer')
  viewer.hidden = view.canSend.audio || view.canSend.video
}

function renderStats(view: SessionView): void {
  const stats = view.stats
  if (stats === null) return

  el('stats').innerHTML = [
    ['Исходящий', formatBitrate(stats.outboundBitrate)],
    ['Входящий', formatBitrate(stats.inboundBitrate)],
    ['Задержка', formatRoundTrip(stats.roundTripMs)],
    ['Потери', formatLoss(stats.packetLoss)],
    ['Разрешение', formatResolution(stats.frameWidth, stats.frameHeight)],
  ]
    .map(([term, value]) => `<div><dt>${term}</dt><dd>${value}</dd></div>`)
    .join('')
}

/**
 * Кнопки, за которыми ничего нет, надо гасить.
 *
 * Участник без камеры и микрофона — законный участник: он смотрит и слушает.
 * Но живая кнопка «Микрофон», которая ничего не делает, — обман.
 */
function renderControls(view: SessionView): void {
  const buttons: [string, boolean, string][] = [
    ['action-mic', view.canSend.audio, 'Микрофон недоступен'],
    ['action-cam', view.canSend.video, 'Камера недоступна'],
  ]

  for (const [id, enabled, reason] of buttons) {
    const button = el<HTMLButtonElement>(id)
    button.disabled = !enabled
    button.title = enabled ? '' : reason
  }
}

function renderPeerState(view: SessionView): void {
  const node = el('peer-state')
  if (view.peerMuted.video) {
    node.textContent = 'Собеседник выключил камеру'
    node.hidden = false
  } else {
    node.hidden = true
  }
}

function attachVideos(): void {
  const media = session?.media
  if (media === undefined) return

  el<HTMLVideoElement>('local-video').srcObject = media.local
  el<HTMLVideoElement>('remote-video').srcObject = media.remote
}

// --- превью на стартовом экране --------------------------------------------

async function startPreview(): Promise<void> {
  if (previewStream !== null) return

  try {
    const media = await requestMedia({
      preset: settings.quality,
      cameraId: settings.cameraId,
      microphoneId: settings.microphoneId,
    })
    previewStream = media.stream

    el<HTMLVideoElement>('preview-video').srcObject = previewStream
    // Без видеодорожки показывать чёрный прямоугольник бессмысленно.
    el('preview-hint').hidden = media.stream.getVideoTracks().length > 0

    // Ни одно из этих состояний не мешает подключиться — кнопка «Создать
    // звонок» остаётся доступной.
    const problem = media.problem?.message ?? describeMissing(media.missing)
    if (problem !== null) el('preview-hint').textContent = problem

    if (media.ignoredSavedDevice) {
      toast('Сохранённое устройство больше не подключено — взяли то, что есть.')
      settings = { ...settings, cameraId: null, microphoneId: null }
      saveSettings(localStorage, settings)
    }

    await fillDeviceLists()
  } catch (error) {
    // requestMedia не бросает исключений, но защита от неожиданностей уместна.
    el('preview-hint').textContent =
      error instanceof Error ? error.message : 'Не удалось получить камеру.'
  }
}

function stopPreview(): void {
  stopStream(previewStream)
  previewStream = null
  el('preview-hint').hidden = false
}

// --- настройки --------------------------------------------------------------

function fillQualityLists(): void {
  const options = qualityOptions()
    .map((option) => `<option value="${option.value}">${option.label}</option>`)
    .join('')

  for (const id of ['setting-quality', 'quality-select']) {
    const select = el<HTMLSelectElement>(id)
    select.innerHTML = options
    select.value = settings.quality
  }
}

async function fillDeviceLists(): Promise<void> {
  const devices = await listDevices()

  const fill = (id: string, list: { deviceId: string; label: string }[], selected: string | null) => {
    const select = el<HTMLSelectElement>(id)
    select.innerHTML = ['<option value="">По умолчанию</option>']
      .concat(list.map((item) => `<option value="${item.deviceId}">${item.label}</option>`))
      .join('')
    select.value = selected ?? ''
  }

  fill('setting-camera', devices.cameras, settings.cameraId)
  fill('setting-microphone', devices.microphones, settings.microphoneId)
}

function openSettings(): void {
  fillQualityLists()
  void fillDeviceLists()
  el<HTMLInputElement>('setting-server').value = settings.signalingServer ?? ''
  el<HTMLInputElement>('setting-passphrase').value = passphrase ?? ''
  el('server-error').hidden = true
  show('settings')
}

function saveFromForm(): boolean {
  const rawServer = el<HTMLInputElement>('setting-server').value.trim()
  const error = el('server-error')

  let signalingServer: string | null = null
  if (rawServer.length > 0) {
    const check = validateServerUrl(rawServer)
    if (!check.ok) {
      error.textContent = check.error
      error.hidden = false
      return false
    }
    signalingServer = rawServer
  }
  error.hidden = true

  const quality = el<HTMLSelectElement>('setting-quality').value
  const camera = el<HTMLSelectElement>('setting-camera').value
  const microphone = el<HTMLSelectElement>('setting-microphone').value

  settings = {
    signalingServer,
    quality: isQualityPreset(quality) ? quality : settings.quality,
    cameraId: camera.length > 0 ? camera : null,
    microphoneId: microphone.length > 0 ? microphone : null,
  }
  saveSettings(localStorage, settings)

  // Фразу намеренно не сохраняем: она живёт только в этой вкладке.
  const typed = el<HTMLInputElement>('setting-passphrase').value
  passphrase = typed.length > 0 ? typed : null

  return true
}

// --- обработчики ------------------------------------------------------------

el('action-create').addEventListener('click', () => {
  void (async () => {
    const created = newSession()
    await created.prepare()
    if (settings.signalingServer !== null) await created.createLink()
    else await created.createCode()
  })()
})

el('action-join').addEventListener('click', () => {
  el('outgoing-block').hidden = true
  el('exchange-title').textContent = 'Вставьте код или ссылку'
  el('exchange-hint').textContent =
    'Подойдёт и код подключения, и ссылка-приглашение — приложение разберётся само.'
  show('exchange')
})

el('action-accept').addEventListener('click', () => {
  void (async () => {
    const input = el<HTMLTextAreaElement>('incoming-code').value.trim()
    if (input.length === 0) return toast('Вставьте код собеседника.')

    const created = session ?? newSession()
    if (created.media.local === null) await created.prepare()

    // Ссылка и код различаются структурно, спрашивать пользователя незачем.
    if (parseInviteLink(input) !== null) await created.joinLink(input)
    else await created.acceptCode(input)
  })()
})

el('action-copy').addEventListener('click', () => {
  void copy(el<HTMLTextAreaElement>('outgoing-code').value, 'Код скопирован.')
})

el('action-copy-link').addEventListener('click', () => {
  void copy(el<HTMLInputElement>('invite-link').value, 'Ссылка скопирована.')
})

el('action-qr').addEventListener('click', () => {
  void renderQr(el<HTMLCanvasElement>('qr-canvas'), el<HTMLTextAreaElement>('outgoing-code').value)
})

el('action-qr-link').addEventListener('click', () => {
  void renderQr(el<HTMLCanvasElement>('qr-link-canvas'), el<HTMLInputElement>('invite-link').value)
})

el('action-settings').addEventListener('click', openSettings)

el('action-close-settings').addEventListener('click', () => show('start'))

el('action-save-settings').addEventListener('click', () => {
  if (!saveFromForm()) return
  stopPreview()
  void startPreview()
  show('start')
  toast('Настройки сохранены.')
})

el('action-mic').addEventListener('click', (event) => {
  const button = event.currentTarget as HTMLButtonElement
  const muted = button.getAttribute('aria-pressed') !== 'true'
  button.setAttribute('aria-pressed', String(muted))
  session?.setMuted('audio', muted)
})

el('action-cam').addEventListener('click', (event) => {
  const button = event.currentTarget as HTMLButtonElement
  const muted = button.getAttribute('aria-pressed') !== 'true'
  button.setAttribute('aria-pressed', String(muted))
  session?.setMuted('video', muted)
})

el('quality-select').addEventListener('change', (event) => {
  const value = (event.currentTarget as HTMLSelectElement).value
  if (isQualityPreset(value)) void session?.setQuality(value as QualityPreset)
})

el('action-sas-ok').addEventListener('click', () => {
  el('sas-block').hidden = true
})

el('action-hangup').addEventListener('click', () => {
  session?.hangUp()
  session = null
})

async function copy(text: string, message: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast(message)
  } catch {
    toast('Скопируйте вручную: буфер обмена недоступен.')
  }
}

// --- запуск -----------------------------------------------------------------

fillQualityLists()
show('start')
void startPreview()

if (detectTransformSupport() === 'none') {
  const notice = el('network-report')
  notice.textContent =
    'Этот браузер не поддерживает сквозное шифрование кадров. Звонок будет защищён только штатным транспортным шифрованием WebRTC.'
  notice.className = 'notice notice--warn'
  notice.hidden = false
}

// Страница открыта по ссылке-приглашению — подключаемся, ничего не спрашивая.
const incoming = parseInviteLink(location.href)
if (incoming !== null) {
  void (async () => {
    const created = newSession()
    await created.prepare()
    await created.joinLink(location.href)
    // Ссылку из адресной строки убираем: незачем оставлять секрет в истории.
    history.replaceState(null, '', location.pathname)
  })()
}

window.addEventListener('beforeunload', () => session?.hangUp())
