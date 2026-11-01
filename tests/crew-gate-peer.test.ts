// Peer detection for the crew API gate, with faked events (no live socket needed).
//   node --import tsx --test tests/crew-gate-peer.test.ts
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import type { H3Event } from 'h3'
import { isLocalRequest, peerOf, peerLabel, trustSocket } from '../server/utils/crewGatePolicy'

// Every socket variable the gate reads is put back after each test, so none leaks into another.
const SOCKET_ENV = ['CREW_API_TRUST_SOCKET', 'SOCKET', 'NITRO_UNIX_SOCKET', 'BLAZE_UNIX_LISTENER']
const SAVED = Object.fromEntries(SOCKET_ENV.map(name => [name, process.env[name]]))
afterEach(() => {
  for (const name of SOCKET_ENV) {
    if (SAVED[name] === undefined) Reflect.deleteProperty(process.env, name)
    else process.env[name] = SAVED[name]
  }
})

// Node: the request's socket carries the peer. A unix socket has no address and no port.
const nodeEvent = (socket: { remoteAddress?: string, remotePort?: number }) =>
  ({ node: { req: { socket } } }) as unknown as H3Event
const noHeaders = new Headers()

test('no remoteAddress and no port: a unix socket peer', () => {
  const peer = peerOf(nodeEvent({}))
  assert.deepEqual(peer, { kind: 'unix' })
  assert.equal(peerLabel(peer), 'unix')
})

test('no remoteAddress but a port: not a unix socket, so unknown and remote', () => {
  const peer = peerOf(nodeEvent({ remotePort: 4000 }))
  assert.deepEqual(peer, { kind: 'unknown' })
  assert.equal(isLocalRequest(peer, noHeaders, true), false)
})

test('IPv4-mapped loopback ::ffff:127.0.0.1 is local', () => {
  const peer = peerOf(nodeEvent({ remoteAddress: '::ffff:127.0.0.1', remotePort: 4000 }))
  assert.equal(peerLabel(peer), '::ffff:127.0.0.1')
  assert.equal(isLocalRequest(peer, noHeaders, false), true)
})

test('IPv6 loopback ::1 is local', () => {
  const peer = peerOf(nodeEvent({ remoteAddress: '::1', remotePort: 4000 }))
  assert.equal(isLocalRequest(peer, noHeaders, false), true)
})

test('IPv4 loopback 127.0.0.1 is local', () => {
  const peer = peerOf(nodeEvent({ remoteAddress: '127.0.0.1', remotePort: 4000 }))
  assert.equal(isLocalRequest(peer, noHeaders, false), true)
})

test('a public IP is remote even with a trusted socket setting', () => {
  const peer = peerOf(nodeEvent({ remoteAddress: '203.0.113.7', remotePort: 4000 }))
  assert.equal(isLocalRequest(peer, noHeaders, true), false)
})

test('unix socket without CREW_API_TRUST_SOCKET is remote', () => {
  delete process.env.CREW_API_TRUST_SOCKET
  assert.equal(trustSocket(), false)
  const peer = peerOf(nodeEvent({}))
  assert.equal(isLocalRequest(peer, noHeaders, trustSocket()), false)
})

test('unix socket with CREW_API_TRUST_SOCKET=true is local, and only the literal "true" opts in', () => {
  process.env.CREW_API_TRUST_SOCKET = 'true'
  process.env.SOCKET = '/run/app.sock'
  assert.equal(trustSocket(), true)
  const peer = peerOf(nodeEvent({}))
  assert.equal(isLocalRequest(peer, noHeaders, trustSocket()), true)

  for (const value of ['1', 'yes', 'TRUE', ' true']) {
    process.env.CREW_API_TRUST_SOCKET = value
    assert.equal(trustSocket(), false, `"${value}" does not opt in`)
  }
})

test('unix socket with the trust switch on still counts as remote when a forwarding header is present', () => {
  process.env.CREW_API_TRUST_SOCKET = 'true'
  const peer = peerOf(nodeEvent({}))
  assert.equal(isLocalRequest(peer, new Headers({ 'X-Forwarded-For': '' }), trustSocket()), false)
})
