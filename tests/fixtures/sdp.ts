import type { IceCandidateInfo } from '../../src/signaling/types.js'

/** Отпечаток из OFFER_SDP в виде hex — 32 байта SHA-256. */
export const OFFER_FINGERPRINT_HEX =
  '75745aa6a4e552f4a7674c01c7ee913f213da2e3537b6f3086f230aa65fb0424'

/** Реалистичный offer от Chrome: audio + video, host- и srflx-кандидаты. */
export const OFFER_SDP = `v=0
o=- 4611731400430051336 2 IN IP4 127.0.0.1
s=-
t=0 0
a=group:BUNDLE 0 1
a=extmap-allow-mixed
a=msid-semantic: WMS stream
m=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0 8 13 110 126
c=IN IP4 0.0.0.0
a=rtcp:9 IN IP4 0.0.0.0
a=candidate:1510613869 1 udp 2113937151 192.168.1.5 54321 typ host generation 0 network-cost 999
a=candidate:842163049 1 udp 1677729535 203.0.113.7 41234 typ srflx raddr 192.168.1.5 rport 54321 generation 0 network-cost 999
a=ice-ufrag:4ZcD
a=ice-pwd:2/1muCWoOi3uLifh0NuRHlgh
a=ice-options:trickle
a=fingerprint:sha-256 75:74:5A:A6:A4:E5:52:F4:A7:67:4C:01:C7:EE:91:3F:21:3D:A2:E3:53:7B:6F:30:86:F2:30:AA:65:FB:04:24
a=setup:actpass
a=mid:0
a=sendrecv
a=rtcp-mux
a=rtpmap:111 opus/48000/2
a=fmtp:111 minptime=10;useinbandfec=1
a=rtpmap:63 red/48000/2
a=rtpmap:9 G722/8000
a=rtpmap:0 PCMU/8000
a=rtpmap:8 PCMA/8000
m=video 9 UDP/TLS/RTP/SAVPF 96 97 98 99
c=IN IP4 0.0.0.0
a=rtcp:9 IN IP4 0.0.0.0
a=candidate:1510613869 1 udp 2113937151 192.168.1.5 54322 typ host generation 0 network-cost 999
a=ice-ufrag:4ZcD
a=ice-pwd:2/1muCWoOi3uLifh0NuRHlgh
a=ice-options:trickle
a=fingerprint:sha-256 75:74:5A:A6:A4:E5:52:F4:A7:67:4C:01:C7:EE:91:3F:21:3D:A2:E3:53:7B:6F:30:86:F2:30:AA:65:FB:04:24
a=setup:actpass
a=mid:1
a=sendrecv
a=rtcp-mux
a=rtpmap:96 VP8/90000
a=rtpmap:97 rtx/90000
a=rtpmap:98 VP9/90000
a=rtpmap:99 H264/90000
`

/** SDP без строки fingerprint — такой код мы обязаны отвергнуть. */
export const SDP_WITHOUT_FINGERPRINT = OFFER_SDP.split('\n')
  .filter((line) => !line.startsWith('a=fingerprint:'))
  .join('\n')

/** SDP со старым SHA-1 отпечатком: для SAS не годится. */
export const SDP_WITH_SHA1_FINGERPRINT = OFFER_SDP.replace(
  /a=fingerprint:sha-256 .*/g,
  'a=fingerprint:sha-1 12:34:56:78:9A:BC:DE:F0:12:34:56:78:9A:BC:DE:F0:12:34:56:78',
)

/** Собирает IceCandidateInfo с разумными умолчаниями — чтобы тесты не тонули в полях. */
export function candidate(patch: Partial<IceCandidateInfo> = {}): IceCandidateInfo {
  return {
    foundation: '1',
    component: 1,
    protocol: 'udp',
    priority: 2113937151,
    address: '192.168.1.5',
    port: 54321,
    type: 'host',
    ...patch,
  }
}
