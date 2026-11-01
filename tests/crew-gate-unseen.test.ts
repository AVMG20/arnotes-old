// The 'unseen' peer: under Bun the app is not handed the socket, so a request has no peer the app
// can read. It is local only when CREW_API_TRUST_SOCKET is the literal "true", either the listener
// marker BLAZE_UNIX_LISTENER=1 or a socket path is set (SOCKET or NITRO_UNIX_SOCKET, non-blank),
// and no forwarding header is present. Otherwise remote. Node TCP peers are unchanged.
// Offline; the events and the environment are faked.
//   node --import tsx --test tests/crew-gate-unseen.test.ts
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import type { H3Event } from 'h3'
import { isLocalRequest, listenerMarker, peerLabel, peerOf, socketPathConfigured, socketTrustStartupLines, trustSocket, type Peer } from '../server/utils/crewGatePolicy'

const SOCKET_ENV = ['CREW_API_TRUST_SOCKET', 'SOCKET', 'NITRO_UNIX_SOCKET', 'BLAZE_UNIX_LISTENER', 'PORT', 'NITRO_PORT', 'HOST', 'NITRO_HOST']
const SAVED = Object.fromEntries(SOCKET_ENV.map(name => [name, process.env[name]]))

// Puts the variables back as they were before the test ran.
function restoreEnv() {
  for (const name of SOCKET_ENV) {
    if (SAVED[name] === undefined) Reflect.deleteProperty(process.env, name)
    else process.env[name] = SAVED[name]
  }
}
afterEach(restoreEnv)

const UNSEEN: Peer = { kind: 'unseen' }
const headers = (init: Record<string, string> = {}) => new Headers(init)
const nodeEvent = (socket: { remoteAddress?: string, remotePort?: number }) =>
  ({ node: { req: { socket } } }) as unknown as H3Event
const bunEvent = () => ({ runtime: { name: 'bun' } }) as unknown as H3Event
const FORWARDING = [
  ['X-Forwarded-For', '198.51.100.1'], ['x-forwarded-for', '198.51.100.1'], ['X-FORWARDED-FOR', ''],
  ['X-Real-IP', '198.51.100.1'], ['x-real-ip', ''], ['X-REAL-IP', '198.51.100.1'],
  ['Forwarded', 'for=198.51.100.1'], ['forwarded', ''], ['FORWARDED', 'by=x']
] as const

// The decision the middleware makes, from the environment it would read. Clears the socket
// variables first, so each case sees only what it names.
const localFor = (peer: Peer, h: Headers, env: Record<string, string | undefined>) => {
  restoreEnv()
  for (const name of SOCKET_ENV) Reflect.deleteProperty(process.env, name)
  Object.assign(process.env, env)
  return isLocalRequest(peer, h, trustSocket())
}

// ── Which peer a Bun request gets ─────────────────────────────────────

test('under Bun with no socket the peer is unseen, not unknown', () => {
  assert.deepEqual(peerOf(bunEvent(), true), { kind: 'unseen' })
  assert.equal(peerLabel(UNSEEN), 'unseen')
})

test('outside Bun with no socket the peer stays unknown', () => {
  assert.deepEqual(peerOf({} as H3Event, false), { kind: 'unknown' })
})

test('a node socket with a port but no address is still unknown, even when Bun is detected', () => {
  assert.deepEqual(peerOf(nodeEvent({ remotePort: 4000 }), true), { kind: 'unknown' })
})

test('node TCP peers keep their address and their rule whatever the socket settings', () => {
  const env = { CREW_API_TRUST_SOCKET: 'true', SOCKET: '/run/app.sock' }
  assert.deepEqual(peerOf(nodeEvent({ remoteAddress: '127.0.0.1', remotePort: 1 }), false), { kind: 'tcp', address: '127.0.0.1' })
  assert.equal(localFor({ kind: 'tcp', address: '127.0.0.1' }, headers(), env), true)
  assert.equal(localFor({ kind: 'tcp', address: '203.0.113.7' }, headers(), env), false, 'a public address is remote')
  assert.equal(localFor({ kind: 'tcp', address: '::ffff:127.0.0.1' }, headers(), {}), true, 'loopback is local with no switch at all')
})

// ── The rule for an unseen request ────────────────────────────────────

test('switch off, unseen, no headers: remote', () => {
  assert.equal(localFor(UNSEEN, headers(), {}), false)
})

test('switch on but no socket path and no marker: unseen is remote, and the startup error says why', () => {
  const env = { CREW_API_TRUST_SOCKET: 'true' }
  assert.equal(localFor(UNSEEN, headers(), env), false)
  const lines = socketTrustStartupLines(env)
  assert.equal(lines.length, 1)
  assert.equal(lines[0]?.level, 'error')
  assert.match(lines[0]?.text ?? '', /\] error: CREW_API_TRUST_SOCKET=true but no socket path is set \(SOCKET or NITRO_UNIX_SOCKET\)/)
})

test('switch on with SOCKET: unseen with no forwarding header is local', () => {
  assert.equal(localFor(UNSEEN, headers(), { CREW_API_TRUST_SOCKET: 'true', SOCKET: '/run/app.sock' }), true)
})

test('switch on with NITRO_UNIX_SOCKET: unseen with no forwarding header is local', () => {
  assert.equal(localFor(UNSEEN, headers(), { CREW_API_TRUST_SOCKET: 'true', NITRO_UNIX_SOCKET: '/run/app.sock' }), true)
})

test('switch on with NITRO_UNIX_SOCKET and each forwarding header, in any casing or empty: remote', () => {
  const env = { CREW_API_TRUST_SOCKET: 'true', NITRO_UNIX_SOCKET: '/run/app.sock' }
  for (const [name, value] of FORWARDING) {
    assert.equal(localFor(UNSEEN, headers({ [name]: value }), env), false, `${name}: ${value}`)
  }
})

test('switch on with SOCKET and each forwarding header, in any casing or empty: remote', () => {
  const env = { CREW_API_TRUST_SOCKET: 'true', SOCKET: '/run/app.sock' }
  for (const [name, value] of FORWARDING) {
    assert.equal(localFor(UNSEEN, headers({ [name]: value }), env), false, `${name}: ${value}`)
  }
})

test('a unix peer with NITRO_UNIX_SOCKET and the switch is local; without the switch it is not', () => {
  assert.equal(localFor({ kind: 'unix' }, headers(), { CREW_API_TRUST_SOCKET: 'true', NITRO_UNIX_SOCKET: '/run/app.sock' }), true)
  assert.equal(localFor({ kind: 'unix' }, headers(), { NITRO_UNIX_SOCKET: '/run/app.sock' }), false)
})

test('an empty NITRO_UNIX_SOCKET is not a socket path', () => {
  assert.equal(socketPathConfigured({ NITRO_UNIX_SOCKET: '' }), false)
  assert.equal(localFor(UNSEEN, headers(), { CREW_API_TRUST_SOCKET: 'true', NITRO_UNIX_SOCKET: '' }), false)
})

test('a blank NITRO_UNIX_SOCKET is not a socket path', () => {
  assert.equal(socketPathConfigured({ NITRO_UNIX_SOCKET: '   ' }), false)
  assert.equal(localFor(UNSEEN, headers(), { CREW_API_TRUST_SOCKET: 'true', NITRO_UNIX_SOCKET: '   ' }), false)
})

test('an empty or blank SOCKET is not a socket path, and the startup error still says so', () => {
  assert.equal(socketPathConfigured({ SOCKET: '' }), false)
  assert.equal(socketPathConfigured({ SOCKET: ' ' }), false)
  assert.equal(localFor(UNSEEN, headers(), { CREW_API_TRUST_SOCKET: 'true', SOCKET: ' ' }), false)
  for (const SOCKET of ['', ' ']) {
    const lines = socketTrustStartupLines({ CREW_API_TRUST_SOCKET: 'true', SOCKET })
    assert.equal(lines[0]?.level, 'error', `SOCKET="${SOCKET}"`)
  }
})

test('switch on with PORT and SOCKET: unseen is local, and the startup warning says the socket must replace the listener', () => {
  const env = { CREW_API_TRUST_SOCKET: 'true', SOCKET: '/run/app.sock', PORT: '3000' }
  assert.equal(localFor(UNSEEN, headers(), env), true)
  const warnings = socketTrustStartupLines(env).filter(line => line.level === 'warning')
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0]?.text, '[crew-api] warning: the switch is on and a TCP port is configured (PORT); local trust relies on the unix socket replacing the listener')
})

test('a blank PORT gives no warning', () => {
  const warnings = socketTrustStartupLines({ CREW_API_TRUST_SOCKET: 'true', SOCKET: '/run/app.sock', PORT: '  ' }).filter(line => line.level === 'warning')
  assert.equal(warnings.length, 0)
})

test('only the literal "true" enables the switch; other values leave unseen remote', () => {
  for (const value of ['1', 'yes', 'TRUE', ' true', 'true ', 'on']) {
    assert.equal(localFor(UNSEEN, headers(), { CREW_API_TRUST_SOCKET: value, SOCKET: '/run/app.sock' }), false, `"${value}"`)
  }
  assert.deepEqual(socketTrustStartupLines({ CREW_API_TRUST_SOCKET: 'true ', SOCKET: '/run/app.sock' }), [])
})

test('a unix peer follows the same rule as unseen', () => {
  const env = { CREW_API_TRUST_SOCKET: 'true', SOCKET: '/run/app.sock' }
  assert.equal(localFor({ kind: 'unix' }, headers(), env), true)
  assert.equal(localFor({ kind: 'unix' }, headers(), {}), false)
  assert.equal(localFor({ kind: 'unix' }, headers({ Forwarded: '' }), env), false)
})

test('unknown stays remote even with the switch and a socket path set', () => {
  assert.equal(localFor({ kind: 'unknown' }, headers(), { CREW_API_TRUST_SOCKET: 'true', SOCKET: '/run/app.sock' }), false)
})

// ── The listener marker (Blaze preload, Bun.serve only) ───────────────

test('marker present, switch on, no socket path: unseen is local', () => {
  assert.equal(listenerMarker({ BLAZE_UNIX_LISTENER: '1' }), true)
  assert.equal(localFor(UNSEEN, headers(), { CREW_API_TRUST_SOCKET: 'true', BLAZE_UNIX_LISTENER: '1' }), true)
})

test('marker present with a forwarding header: remote', () => {
  assert.equal(localFor(UNSEEN, headers({ 'X-Real-IP': '' }), { CREW_API_TRUST_SOCKET: 'true', BLAZE_UNIX_LISTENER: '1' }), false)
})

test('marker present: no info line about the marker', () => {
  const lines = socketTrustStartupLines({ CREW_API_TRUST_SOCKET: 'true', SOCKET: '/run/app.sock', BLAZE_UNIX_LISTENER: '1' })
  assert.deepEqual(lines, [])
})

test('marker absent, switch on, socket path set: one info line, and the socket is still trusted', () => {
  const env = { CREW_API_TRUST_SOCKET: 'true', SOCKET: '/run/app.sock' }
  const lines = socketTrustStartupLines(env)
  assert.equal(lines.length, 1)
  assert.equal(lines[0]?.level, 'info')
  assert.match(lines[0]?.text ?? '', /listener marker BLAZE_UNIX_LISTENER=1 is absent/)
  assert.equal(localFor(UNSEEN, headers(), env), true)
})

test('marker "0": not a proof; with no socket path it stays remote', () => {
  assert.equal(listenerMarker({ BLAZE_UNIX_LISTENER: '0' }), false)
  assert.equal(localFor(UNSEEN, headers(), { CREW_API_TRUST_SOCKET: 'true', BLAZE_UNIX_LISTENER: '0' }), false)
  assert.equal(socketTrustStartupLines({ CREW_API_TRUST_SOCKET: 'true', BLAZE_UNIX_LISTENER: '0' })[0]?.level, 'error')
})

test('marker blank: not a proof; with no socket path it stays remote', () => {
  assert.equal(listenerMarker({ BLAZE_UNIX_LISTENER: '  ' }), false)
  assert.equal(localFor(UNSEEN, headers(), { CREW_API_TRUST_SOCKET: 'true', BLAZE_UNIX_LISTENER: '  ' }), false)
})

test('marker "0" or blank with a socket path: the socket path still counts, and the info line is logged', () => {
  for (const marker of ['0', '  ']) {
    const env = { CREW_API_TRUST_SOCKET: 'true', SOCKET: '/run/app.sock', BLAZE_UNIX_LISTENER: marker }
    assert.equal(localFor(UNSEEN, headers(), env), true, `marker "${marker}"`)
    assert.equal(socketTrustStartupLines(env)[0]?.level, 'info', `marker "${marker}"`)
  }
})

test('the marker alone does nothing without the switch', () => {
  assert.equal(localFor(UNSEEN, headers(), { BLAZE_UNIX_LISTENER: '1' }), false)
})

// ── The startup lines ─────────────────────────────────────────────────

test('no startup line when the switch is off, whatever else is set', () => {
  assert.deepEqual(socketTrustStartupLines({ PORT: '3000', SOCKET: '/run/app.sock' }), [])
})

test('switch on with a socket path, the marker and no TCP port: no line', () => {
  assert.deepEqual(socketTrustStartupLines({ CREW_API_TRUST_SOCKET: 'true', SOCKET: '/run/app.sock', BLAZE_UNIX_LISTENER: '1' }), [])
})

test('switch on with a socket path and a host or port named: a warning naming them, and the info line', () => {
  const lines = socketTrustStartupLines({ CREW_API_TRUST_SOCKET: 'true', SOCKET: '/run/app.sock', NITRO_PORT: '3000', HOST: '0.0.0.0' })
  const warnings = lines.filter(line => line.level === 'warning')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0]?.text ?? '', /\(NITRO_PORT, HOST\)/)
  assert.equal(lines.filter(line => line.level === 'info').length, 1)
})

test('the switch set to a non-literal value produces no line at all', () => {
  assert.deepEqual(socketTrustStartupLines({ CREW_API_TRUST_SOCKET: 'yes', PORT: '3000' }), [])
})

test('marker values " 1", "01", "true" and "1 " do not count: not a marker, and unseen stays remote with no socket path', () => {
  for (const value of [' 1', '01', 'true', '1 ']) {
    assert.equal(listenerMarker({ BLAZE_UNIX_LISTENER: value }), false, `"${value}"`)
    assert.equal(localFor(UNSEEN, headers(), { CREW_API_TRUST_SOCKET: 'true', BLAZE_UNIX_LISTENER: value }), false, `"${value}"`)
  }
})

test('marker alone, with PORT and no socket path: unseen is local, and the warning names PORT', () => {
  const env = { CREW_API_TRUST_SOCKET: 'true', BLAZE_UNIX_LISTENER: '1', PORT: '3000' }
  assert.equal(localFor(UNSEEN, headers(), env), true)
  const warnings = socketTrustStartupLines(env).filter(line => line.level === 'warning')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0]?.text ?? '', /\(PORT\)/)
})
