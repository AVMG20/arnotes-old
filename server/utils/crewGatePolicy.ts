import type { H3Event } from 'h3'

// The crew API gate's rules, free of database access so they can be tested on their own.
// BRIEF-crew-feature section 2b: /api/crews answers only a request that really comes from
// this machine. Anything behind a proxy carries a forwarding header and counts as remote.

export const CREW_API_PATH = '/api/crews'
export const CREW_KEY_SCOPE = 'crews:manage'
// Headers nginx sets on a proxied request. Presence counts, whatever the value or casing.
export const FORWARDING_HEADERS = ['x-forwarded-for', 'x-real-ip', 'forwarded'] as const

export type Peer = { kind: 'tcp', address: string } | { kind: 'unix' } | { kind: 'unseen' } | { kind: 'unknown' }

export type KeyVerdict = { ok: true, keyId: string } | { ok: false, reason: 'bad key' | 'expired' | 'wrong scope' | 'not admin' }

export function isCrewApiPath(path: string): boolean {
  const bare = path.split('?')[0] ?? ''
  return bare === CREW_API_PATH || bare.startsWith(`${CREW_API_PATH}/`)
}

export function isLoopback(address: string): boolean {
  return address === '::1' || /^127\./.test(address) || /^::ffff:127\./.test(address)
}

// Headers.has is case-insensitive and true for an empty value, which is what we want:
// a proxy that sends an empty X-Forwarded-For still went through the proxy.
export function hasForwardingHeader(headers: Headers): boolean {
  return FORWARDING_HEADERS.some(name => headers.has(name))
}

/**
 * The unix socket path the platform provides, from the environment: SOCKET, or NITRO_UNIX_SOCKET.
 * Only a non-empty value counts.
 */
export function socketPathConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return [env.SOCKET, env.NITRO_UNIX_SOCKET].some(value => (value ?? '').trim() !== '')
}

/**
 * The listener marker the Blaze preload sets (BLAZE_UNIX_LISTENER=1) once it has wrapped Bun.serve
 * onto the unix socket. An environment signal from the preload: nothing verifies it. It covers
 * Bun.serve only; any other listener the process opens is not covered by it.
 */
export function listenerMarker(env: Record<string, string | undefined> = process.env): boolean {
  return env.BLAZE_UNIX_LISTENER === '1'
}

/**
 * Whether socket-only peers (unix, or unseen under Bun) are trusted as local. Needs the operator's
 * switch, the literal "true", AND either the listener marker (BLAZE_UNIX_LISTENER=1) or a socket
 * path in the environment (SOCKET or NITRO_UNIX_SOCKET). Without either, such peers stay remote.
 */
export function trustSocket(env: Record<string, string | undefined> = process.env): boolean {
  return env.CREW_API_TRUST_SOCKET === 'true' && (listenerMarker(env) || socketPathConfigured(env))
}

/** Whether this process runs under Bun. The Bun preset does not hand the app the socket it was called on. */
export function runningUnderBun(event?: H3Event): boolean {
  if (typeof (process.versions as { bun?: string }).bun === 'string') return true
  return (event as unknown as { runtime?: { name?: string } } | undefined)?.runtime?.name === 'bun'
}

/**
 * Where the request really came from, read from the socket and never from a header.
 * 'unseen' is a request under Bun that carries no socket the app can read: the runtime passed
 * on the headers only. It is treated like a unix socket, see isLocalRequest.
 */
export function peerOf(event: H3Event, bun = runningUnderBun(event)): Peer {
  const socket = (event as unknown as { node?: { req?: { socket?: { remoteAddress?: string, remotePort?: number } } } }).node?.req?.socket
  if (socket) {
    if (typeof socket.remoteAddress === 'string' && socket.remoteAddress) {
      return { kind: 'tcp', address: socket.remoteAddress }
    }
    // A unix socket has neither an address nor a port.
    return socket.remotePort === undefined ? { kind: 'unix' } : { kind: 'unknown' }
  }
  // A Bun runtime that exposes its server: the TCP peer is known; no address means a unix socket.
  type BunServer = { requestIP(request: unknown): { address: string } | null }
  const bunRuntime = (event as unknown as { runtime?: { bun?: { server?: BunServer } } }).runtime?.bun
  if (bunRuntime?.server) {
    const info = bunRuntime.server.requestIP((event as unknown as { req: unknown }).req)
    return info ? { kind: 'tcp', address: info.address } : { kind: 'unix' }
  }
  return bun ? { kind: 'unseen' } : { kind: 'unknown' }
}

export function peerLabel(peer: Peer): string {
  if (peer.kind === 'tcp') return peer.address
  return peer.kind
}

/**
 * Local means: a loopback TCP peer, or a socket-only peer (unix, or unseen under Bun) when the
 * operator has set CREW_API_TRUST_SOCKET to the literal true, and in every case no forwarding
 * header. A request with a forwarding header came through a proxy and is always remote.
 * Why a socket-only peer is trusted on the operator's word: see the README, Crew API.
 */
export function isLocalRequest(peer: Peer, headers: Headers, socketTrusted: boolean): boolean {
  if (hasForwardingHeader(headers)) return false
  if (peer.kind === 'tcp') return isLoopback(peer.address)
  if (peer.kind === 'unix' || peer.kind === 'unseen') return socketTrusted
  return false
}

export type StartupLevel = 'error' | 'warning' | 'info'
export interface StartupLine {
  level: StartupLevel
  text: string
}

/**
 * The lines to log once at startup about the socket-trust switch. Never a refusal to start: a
 * platform may set PORT or HOST while its own preload swaps the listener for a unix socket.
 * - Switch on, no socket path and no marker: an error line. Unseen and unix peers stay remote.
 * - Switch on with a socket path but no marker: an info line; the marker is absent.
 * - Switch on with a socket path and a TCP port or host also set: a warning that local trust
 *   relies on the unix socket replacing the listener.
 * It reads the environment only, and logs variable names, never values.
 */
export function socketTrustStartupLines(env: Record<string, string | undefined> = process.env): StartupLine[] {
  if (env.CREW_API_TRUST_SOCKET !== 'true') return []
  const marker = listenerMarker(env)
  if (!socketPathConfigured(env) && !marker) {
    return [{
      level: 'error',
      text: '[crew-api] error: CREW_API_TRUST_SOCKET=true but no socket path is set (SOCKET or NITRO_UNIX_SOCKET) and no listener marker (BLAZE_UNIX_LISTENER=1). Requests without a peer address are treated as remote.'
    }]
  }
  const lines: StartupLine[] = []
  if (!marker) {
    lines.push({ level: 'info', text: '[crew-api] info: the listener marker BLAZE_UNIX_LISTENER=1 is absent; the socket path is taken on trust' })
  }
  const given = ['PORT', 'NITRO_PORT', 'HOST', 'NITRO_HOST'].filter(name => (env[name] ?? '').trim() !== '')
  if (given.length) {
    lines.push({
      level: 'warning',
      text: `[crew-api] warning: the switch is on and a TCP port is configured (${given.join(', ')}); local trust relies on the unix socket replacing the listener`
    })
  }
  return lines
}

export interface GateInput {
  local: boolean
  windowOpen: boolean
  /** The window's temporary key, the only key a remote caller may use while it is open. */
  tempKeyId: string | null
  verdict: KeyVerdict | null
}

export type GateStep = { pass: true } | { pass: false, status: 401 | 404, outcome: string, closeReason: string | null }

/**
 * The decision for one call on /api/crews. A closed window answers a remote caller 404
 * with no hint and checks nothing. An open window (or a local caller) must present a
 * crews:manage key; a failed key answers 401 and, while the window is open, closes it.
 */
export function decide(input: GateInput): GateStep {
  if (!input.local && !input.windowOpen) {
    return { pass: false, status: 404, outcome: 'remote, window closed', closeReason: null }
  }
  const verdict = input.verdict
  if (!verdict) {
    return { pass: false, status: 401, outcome: 'no key check', closeReason: null }
  }
  if (verdict.ok) {
    if (input.local || verdict.keyId === input.tempKeyId) return { pass: true }
    // A remote caller with some other crews:manage key is not the window's key.
    return { pass: false, status: 401, outcome: 'bad key', closeReason: input.windowOpen ? 'bad key' : null }
  }
  return {
    pass: false,
    status: 401,
    outcome: verdict.reason,
    closeReason: input.windowOpen ? verdict.reason : null
  }
}

// Refused calls are counted per caller over a minute, in two separate maps: one for local callers
// (keyed by peer) and one for remote callers (keyed by the client address nginx passed on in
// X-Real-IP). An eviction in one map never touches the other. A local bucket past its limit gets
// 429; a remote bucket past its limit keeps getting the plain 404 and is not counted further, so
// remote traffic can never lock out the local caller.
export type Bucket = 'local' | 'remote'
export const DENIALS_PER_MINUTE = 10
export const MAX_RATE_KEYS = 10_000
const MINUTE = 60_000
const maps: Record<Bucket, Map<string, number[]>> = { local: new Map(), remote: new Map() }

export function bucketOf(local: boolean): Bucket {
  return local ? 'local' : 'remote'
}

/** The caller's key inside its bucket: the peer for a local caller, the client for a remote one. */
export function rateKey(local: boolean, peer: Peer, headers: Headers): string {
  return local ? peerLabel(peer) : (clientAddress(headers) ?? peerLabel(peer))
}

/** The client address nginx passed on, cleaned to [0-9a-f:.] and capped; null when absent or empty. */
export function clientAddress(headers: Headers): string | null {
  const raw = headers.get('x-real-ip')
  if (raw === null) return null
  const clean = raw.trim().toLowerCase().replace(/[^0-9a-f:.]/g, '').slice(0, 45)
  return clean || null
}

/** The audit's peer column: the peer, and for a proxied call the client it passed on. */
export function auditPeer(peer: Peer, headers: Headers): string {
  const client = clientAddress(headers)
  return client ? `${peerLabel(peer)} (client ${client})` : peerLabel(peer)
}

/** The answer when a caller is over its limit: 429 for a local caller, the plain 404 for a remote one. */
export function limitedStatus(local: boolean): 429 | 404 {
  return local ? 429 : 404
}

function recentIn(map: Map<string, number[]>, key: string, now: number): number[] {
  return (map.get(key) ?? []).filter(t => now - t < MINUTE)
}

function sweep(map: Map<string, number[]>, now: number): void {
  for (const [key, times] of map) {
    const recent = times.filter(t => now - t < MINUTE)
    if (recent.length) map.set(key, recent)
    else map.delete(key)
  }
}

export function overDenialLimit(bucket: Bucket, key: string, now: number): boolean {
  const map = maps[bucket]
  const recent = recentIn(map, key, now)
  if (recent.length) map.set(key, recent)
  else map.delete(key)
  return recent.length >= DENIALS_PER_MINUTE
}

export function noteDenial(bucket: Bucket, key: string, now: number): void {
  const map = maps[bucket]
  const recent = recentIn(map, key, now)
  recent.push(now)
  // Re-inserting moves the key to the end, so the first keys are the least recently refused.
  map.delete(key)
  map.set(key, recent)
  if (map.size > MAX_RATE_KEYS) {
    sweep(map, now)
    while (map.size > MAX_RATE_KEYS) {
      const oldest = map.keys().next().value
      if (oldest === undefined) break
      map.delete(oldest)
    }
  }
}

export function denialKeyCount(bucket: Bucket): number {
  return maps[bucket].size
}
