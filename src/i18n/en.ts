/**
 * Английский перевод. Набор ключей обязан совпадать с `ru.ts` — это проверяется
 * тестом, потому что забытый ключ иначе всплывает уже в интерфейсе.
 */
export const en: Record<string, string> = {
  // --- главный экран --------------------------------------------------------
  'home.title': 'Encrypted call',
  'home.subtitle':
    'The conversation goes directly between two browsers. The keys never leave your devices.',
  'home.settings': 'Settings',

  'preview.off': 'Camera and microphone are off',

  'devices.camera': 'Camera',
  'devices.microphone': 'Microphone',
  'devices.default': 'Default',
  'devices.cameraFallback': 'Camera {index}',
  'devices.microphoneFallback': 'Microphone {index}',

  'tabs.direct': 'Direct',
  'tabs.server': 'Via server',

  // --- вкладка «Напрямую» ---------------------------------------------------
  'verdict.pending.title': 'Checking the network',
  'verdict.pending.note': 'Querying two STUN servers, this takes a couple of seconds.',
  'verdict.open.title': 'Direct connection is available',
  'verdict.cone.title': 'Nothing blocks you on your side',
  'verdict.symmetric.title': 'Your router gets in the way',
  'verdict.blocked.title': 'UDP is blocked',
  'verdict.unknown.title': 'Could not determine the network',

  // Таблица проверок сети (src/net/checks.ts).
  'checks.reachability.title': 'STUN servers',
  'checks.reachability.ok': 'responding, outbound UDP passes',
  'checks.reachability.blocked': 'none responded — UDP appears to be blocked on this network',
  'checks.reachability.pending': 'not checked',

  'checks.reflexive.title': 'External address',
  'checks.reflexive.ok': 'seen from outside as {address}:{port}',
  'checks.reflexive.blocked': 'could not be determined: STUN did not respond',
  'checks.reflexive.pending': 'not checked',

  'checks.nat.title': 'NAT type',
  'checks.nat.open': 'a public address, no NAT at all',
  'checks.nat.cone': 'the external port is kept — NAT traversal will work',
  'checks.nat.symmetric':
    'a new external port for every peer (symmetric NAT): with an ordinary router on the other side the connection may still work, with the same kind it will not',
  'checks.nat.blocked': 'cannot be determined: STUN did not respond',
  'checks.nat.unknown':
    'only one STUN responded — a single probe cannot tell an ordinary NAT from a symmetric one',
  'checks.nat.pending': 'not checked',

  'checks.ipv6.title': 'IPv6',
  'checks.ipv6.ok': 'a global address is available — NAT can be bypassed',
  'checks.ipv6.missing': 'unavailable, only IPv4 through NAT is left',
  'checks.ipv6.pending': 'not checked',

  'checks.verdict.ok.title': 'Nothing blocks you on your side',
  'checks.verdict.warn.title': 'The connection may not go through',
  'checks.verdict.fail.title': 'A direct connection will not work',
  'checks.verdict.pending.title': 'Checking the network',
  'checks.verdict.open.note':
    'You have a public address with no NAT: anyone can reach you, whatever their router.',
  'checks.verdict.cone.note':
    'Your NAT keeps the external port — nothing blocks you on your side. Whether the connection works also depends on the router of the other person.',
  'checks.verdict.symmetric.note':
    'Your router hands out a new external port for every peer (symmetric NAT). With an ordinary router on the other side the connection may still work — that cannot be checked in advance, it takes an attempt.',
  'checks.verdict.blocked.note':
    'UDP is blocked on this network: a direct connection will not work with anyone. A relay server is required.',
  'checks.verdict.unknown.note':
    'Only one STUN server responded: a single probe cannot tell an ordinary NAT from a symmetric one. That does not prevent you from trying to connect.',
  'checks.verdict.pending.note': 'Querying two STUN servers, this takes a couple of seconds.',

  'passphrase.label': 'Shared phrase',
  'passphrase.unset': 'not set',
  'passphrase.set': 'set',

  'direct.create': 'Create a call',
  'direct.goServer': 'Set up your own server',
  'direct.join': 'I have a code',

  // --- вкладка «Через сервер» -----------------------------------------------
  'server.empty.title': 'No server of your own is connected',
  'server.empty.note':
    'Needed when a direct connection does not go through. Deploys with a single command and stays under your control.',
  'server.empty.b1': 'Joining by link, without exchanging codes',
  'server.empty.b2': 'Works where NAT cannot be traversed',
  'server.empty.b3': 'The server sees neither the SDP nor the call keys',
  'server.ready.status': 'Verified · signaling and TURN respond',
  'server.add': 'Add a server',
  'server.start': 'Start a session',

  'link.label': 'Link for the other person',
  'link.copy': 'Copy',
  'link.waiting': 'The other person has not joined yet',
  'link.join': 'Join',

  // --- обмен кодами ---------------------------------------------------------
  'exchange.title': 'Pass the code to the other person',
  'exchange.hint': 'Send your code any way you like and paste the one you get back here.',
  'exchange.joinTitle': 'Paste a code or a link',
  'exchange.joinHint': 'Both a connection code and an invite link will do — the app will figure it out.',
  'exchange.yourCode': 'Your code',
  'exchange.peerCode': "The other person's code",
  'exchange.placeholder': "Paste the other person's code here",
  'exchange.connect': 'Connect',

  // --- экран звонка ---------------------------------------------------------
  'call.peerCameraOff': 'The other person turned the camera off',
  'call.e2ee': 'end-to-end encryption',
  'call.sasLabel': 'Read the phrase out loud to compare',
  'call.sasOk': 'It matches',
  'call.hangUp': 'Hang up',
  'call.you': 'you',

  'controls.micUnavailable': 'Microphone is unavailable',
  'controls.camUnavailable': 'Camera is unavailable',

  'stats.outbound': 'Outbound',
  'stats.inbound': 'Inbound',
  'stats.latency': 'Latency',
  'stats.loss': 'Loss',
  'stats.resolution': 'Resolution',

  // --- настройки ------------------------------------------------------------
  'settings.title': 'Settings',
  'settings.server': 'SIGNALING SERVER',
  'settings.address': 'Address',
  'settings.check': 'Check',
  'settings.remove': 'Remove',
  'settings.serverHint':
    'The server is only needed when a direct connection does not go through. See DEPLOY.md in the repository for how to deploy it.',
  'settings.language': 'LANGUAGE',
  'settings.save': 'Save',
  'settings.error.empty': 'Enter the address of the signaling server.',
  'settings.error.insecure': 'Unencrypted ws:// is allowed on localhost only. Use wss://',
  'settings.error.scheme': 'The address must start with wss:// — for example, wss://call.example.com/ws',

  'quality.auto': 'Automatic',
  'quality.360p': '360p — light',
  'quality.720p': '720p — normal',
  'quality.1080p': '1080p — maximum',

  // --- камера и микрофон (src/call/media.ts) --------------------------------
  'media.insecure':
    'The browser hands over the camera only over HTTPS or on localhost. For now you can only watch and listen.',
  'media.denied':
    'The browser did not let us reach the camera and microphone. Check the permission in the address bar, and on macOS also the browser access to the camera in system settings.',
  'media.absent':
    'Neither a camera nor a microphone was found. Make sure the device is plugged in and not disabled in the system.',
  'media.overconstrained':
    'The selected device is no longer available. Open settings and pick the camera and microphone again.',
  'media.busy':
    'The camera or microphone is busy in another program. Close it — on Windows that is usually Zoom or Teams — and try again.',
  'media.unsupported': 'This browser cannot provide a camera and microphone.',
  'media.unknown': 'Could not get the camera and microphone.',
  'media.deviceCount': 'The browser sees {cameras} camera(s) and {microphones} microphone(s).',
  'media.missing.both': 'There is no camera and no microphone — you will join in watch-only mode.',
  'media.missing.video': 'The camera is unavailable — the other person will only hear you.',
  'media.missing.audio': 'The microphone is unavailable — the other person will only see you.',

  // --- диагностика NAT (src/net/nat.ts) ------------------------------------
  'nat.pending.reason': 'The network has not been checked yet.',
  'nat.blocked.reason':
    'Not a single STUN server responded: UDP appears to be blocked on this network. A direct connection will not work with anyone — a relay server is required.',
  'nat.open.reason':
    'You have a public address with no NAT. Nothing blocks you on your side: anyone can reach you, whatever their router.',
  'nat.cone.reason':
    'Your NAT keeps the external port — nothing blocks you on your side. Whether the connection works also depends on the router of the other person.',
  'nat.symmetric.reason':
    'Your router hands out a new external port for every peer (symmetric NAT). With the same kind of router on the other side a direct connection will not work at all, with an ordinary one it is a matter of luck. This cannot be checked in advance: it takes an attempt.',
  'nat.unknown.reason':
    'Only one STUN server responded: a single probe cannot tell an ordinary NAT from a symmetric one.',

  // --- состояние соединения (src/ui/format.ts) -----------------------------
  'connection.local': 'direct, local network',
  'connection.direct': 'direct connection',
  'connection.relay': 'through a relay',
  'connection.pending': 'connecting…',

  'encryption.e2ee': 'end-to-end encryption',
  'encryption.transportOnly': 'transport encryption only',

  'format.none': '—',
  'format.kbps': '{value} kbit/s',
  'format.mbps': '{value} Mbit/s',
  'format.ms': '{value} ms',

  // --- ход звонка (src/call/session.ts) ------------------------------------
  'session.prepareFailed': 'Could not prepare the call.',
  'session.notReady': 'The connection is not ready yet.',
  'session.wrongCodeRole': "This is the caller's code, but the answering code is needed.",
  'session.codeUnreadable': 'The code was not recognised. Check that you copied all of it.',
  'session.noServer': 'First set the address of your signaling server in the settings.',
  'session.badLink': 'The invite link was not recognised.',
  'session.peerLeft': 'The other person disconnected.',
  'session.peerHungUp': 'The other person ended the call.',
  'session.signalingClosed': 'The connection to the signaling server was lost.',
  'session.noFingerprint': 'The SDP has no SHA-256 fingerprint: it is not safe to continue.',
  'session.unknownError': 'Unknown error.',
  'session.unreachable':
    'Could not establish a direct connection. Try switching from mobile internet to Wi-Fi, turning off the VPN — or deploying your own server, one of you is enough.',
  'session.unreachable.symmetric':
    'Your router hands out a new external port for every peer (symmetric NAT).',
  'session.unreachable.blocked': 'UDP is blocked on your network.',

  // --- сигналинг (src/signaling/client.ts) ---------------------------------
  'signaling.unreachable': 'Could not reach the signaling server.',
  'signaling.tampered':
    'The message from the other person failed authentication. Make sure you both opened the same link.',
  'signaling.roomFull': 'This room already has two participants. Create a new link.',
  'signaling.rateLimited': 'The server limited the message rate and closed the connection.',
  'signaling.serverError': 'The server is overloaded: too many active rooms.',

  // --- уведомления ----------------------------------------------------------
  'toast.codeCopied': 'Code copied.',
  'toast.linkCopied': 'Link copied.',
  'toast.copyFailed': 'Copy it by hand: the clipboard is unavailable.',
  'toast.pasteCode': "Paste the other person's code.",
  'toast.qrFailed': 'Could not build the QR code — it is too long.',
  'toast.settingsSaved': 'Settings saved.',
  'toast.savedDeviceGone': 'The saved device is no longer connected — we took what is available.',
  'notice.noFrameEncryption':
    'This browser does not support end-to-end frame encryption. The call will be protected by the standard WebRTC transport encryption only.',
  'passphrase.prompt': "A shared phrase you agreed on in advance, over a separate channel. Leave empty if you did not.",
  'format.resolution': '{width}×{height}',
  'preview.requesting': 'Requesting access to the camera and microphone…',
  'direct.creating': 'Preparing the code…',
  'server.starting': 'Creating a room…',
  'exchange.connecting': 'Connecting…',
  'link.joining': 'Connecting…',
  'status.preparing': 'Preparing the call…',
  'status.gathering': 'Collecting network addresses — this takes up to five seconds.',
  'status.connecting': 'Establishing the connection. Usually a couple of seconds, sometimes up to half a minute.',
  'status.waitingCode': 'Waiting for the code from the other side.',
  'link.peerJoined': 'The other person joined, establishing the connection…',
  'settings.checking': 'Checking the server…',
  'settings.checkReachable': 'The server responds.',
  'settings.checkUnreachable': 'No response. Check the address and that the server is running.',
  'settings.checkTimeout': 'The server did not respond in time.',
  'error.title': 'Could not connect',
  'error.needServer': 'This connection will not go through without a relay server. It is enough for one of you to have one.',
  'error.dismiss': 'Got it',
  'exchange.answerCode': 'Your reply code — send it back',
  'status.sendAnswer': 'The reply code is ready — send it back and wait until the other side pastes it.',
  'session.unreachable.sameHost': 'Both sides are on the same machine and their candidate addresses match, so the obstacle is not NAT but something local: a firewall, a VPN, or a security policy that drops UDP between processes. A relay server gets around it, but the real cause is in the machine or network settings.',
  'ended.local.title': 'Call ended',
  'ended.local.note': 'You hung up. The connection is closed and the keys are gone.',
  'ended.peer.title': 'The other person ended the call',
  'ended.peer.note': 'They hung up properly — nothing broke.',
  'ended.lost.title': 'The connection dropped',
  'ended.lost.note': 'The connection disappeared without warning: the other side may have closed the tab or lost the network. No goodbye arrived.',
  'ended.duration': 'The call lasted {value}',
  'ended.back': 'Home',
  'session.codeTruncated': 'The code was copied incompletely — the end is missing. Select all of it, or use the copy button.',
  'session.codeVersion': 'The code was made by a different version of the app. Reload both tabs and exchange codes again.',
  'session.answerWithoutOffer': 'This is a reply code, but your call is already closed — it probably timed out. Start a new call and exchange codes again.',
  'exchange.chars': '{count} characters',
  'call.peerMicOff': "the other person's microphone is off",
}
