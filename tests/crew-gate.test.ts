// The crew API gate (BRIEF-crew-feature 2b). The policy cases run on their own; the live
// cases need the crew_api_gate and crew_api_audit tables and a dev server:
//   node --env-file-if-exists=.env --import tsx --test tests/crew-gate.test.ts
// Set CREW_GATE_LIVE=1 to run the live cases (CREW_TEST_BASE, default http://localhost:3000).
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { eq, like } from 'drizzle-orm'
import { db } from '../server/db'
import { apiKeys, crewApiAudit, user } from '../server/db/schema'
import {
  decide, isCrewApiPath, isLocalRequest, isLoopback, hasForwardingHeader, peerOf, overDenialLimit, noteDenial, DENIALS_PER_MINUTE
} from '../server/utils/crewGatePolicy'

const LOOPBACK = { kind: 'tcp' as const, address: '127.0.0.1' }
const REMOTE = { kind: 'tcp' as const, address: '203.0.113.7' }
const UNIX = { kind: 'unix' as const }
const headers = (init: Record<string, string> = {}) => new Headers(init)

// ── Policy: where a request comes from ────────────────────────────────

test('loopback peers are local, other addresses are not', () => {
  assert.ok(isLoopback('127.0.0.1'))
  assert.ok(isLoopback('127.9.9.9'))
  assert.ok(isLoopback('::1'))
  assert.ok(isLoopback('::ffff:127.0.0.1'))
  assert.ok(!isLoopback('203.0.113.7'))
  assert.ok(!isLoopback('::ffff:203.0.113.7'))
  assert.equal(isLocalRequest(LOOPBACK, headers(), false), true)
  assert.equal(isLocalRequest(REMOTE, headers(), false), false)
})

test('every forwarding header counts as remote, whatever its casing or value, empty included', () => {
  const names = ['X-Forwarded-For', 'x-forwarded-for', 'X-FORWARDED-FOR', 'X-Real-IP', 'x-real-ip', 'Forwarded']
  for (const name of names) {
    assert.equal(isLocalRequest(LOOPBACK, headers({ [name]: '198.51.100.1' }), false), false, `${name} with a value`)
    assert.equal(isLocalRequest(LOOPBACK, headers({ [name]: '' }), false), false, `${name} empty`)
  }
  assert.equal(hasForwardingHeader(headers({ 'X-Forwarded-For': '' })), true)
  assert.equal(hasForwardingHeader(headers({ 'X-Forwarded-Host': 'x' })), false)
})

test('the unix socket is local only when CREW_API_TRUST_SOCKET is on, and never with a forwarding header', () => {
  assert.equal(isLocalRequest(UNIX, headers(), false), false)
  assert.equal(isLocalRequest(UNIX, headers(), true), true)
  assert.equal(isLocalRequest(UNIX, headers({ 'X-Real-IP': '' }), true), false)
})

test('an unknown peer is treated as remote', () => {
  assert.equal(isLocalRequest({ kind: 'unknown' }, headers(), true), false)
})

test('peerOf reads the node socket and tells a unix socket from a TCP peer', () => {
  const tcp = { node: { req: { socket: { remoteAddress: '127.0.0.1', remotePort: 5000 } } } } as never
  const unix = { node: { req: { socket: { remoteAddress: undefined, remotePort: undefined } } } } as never
  assert.deepEqual(peerOf(tcp), { kind: 'tcp', address: '127.0.0.1' })
  assert.deepEqual(peerOf(unix), { kind: 'unix' })
  assert.deepEqual(peerOf({} as never), { kind: 'unknown' })
})

test('only /api/crews and /api/crews/* are gated', () => {
  assert.ok(isCrewApiPath('/api/crews'))
  assert.ok(isCrewApiPath('/api/crews/blaze-x'))
  assert.ok(isCrewApiPath('/api/crews?x=1'))
  assert.ok(!isCrewApiPath('/api/crewsx'))
  assert.ok(!isCrewApiPath('/api/projects'))
})

// ── Policy: what happens to a call ────────────────────────────────────

const ok = (keyId = 'temp') => ({ ok: true as const, keyId })

test('remote with the window closed: 404, nothing checked, nothing closed', () => {
  const step = decide({ local: false, windowOpen: false, tempKeyId: null, verdict: null })
  assert.deepEqual(step, { pass: false, status: 404, outcome: 'remote, window closed', closeReason: null })
})

test('remote with the window open and its own key: passes', () => {
  assert.deepEqual(decide({ local: false, windowOpen: true, tempKeyId: 'temp', verdict: ok('temp') }), { pass: true })
})

test('remote with the window open and a wrong key: 401 and the window closes with the reason', () => {
  for (const reason of ['bad key', 'expired', 'wrong scope', 'not admin'] as const) {
    const step = decide({ local: false, windowOpen: true, tempKeyId: 'temp', verdict: { ok: false, reason } })
    assert.deepEqual(step, { pass: false, status: 401, outcome: reason, closeReason: reason }, reason)
  }
})

test('remote with the window open and another valid crews:manage key: refused and the window closes', () => {
  const step = decide({ local: false, windowOpen: true, tempKeyId: 'temp', verdict: ok('other') })
  assert.equal(step.pass, false)
  assert.equal(step.status, 401)
  assert.equal(step.closeReason, 'bad key')
})

test('a failed key while the window is closed: 401, audited by the caller, nothing to close', () => {
  const step = decide({ local: true, windowOpen: false, tempKeyId: null, verdict: { ok: false, reason: 'bad key' } })
  assert.deepEqual(step, { pass: false, status: 401, outcome: 'bad key', closeReason: null })
})

test('local with a valid key passes whether or not the window is open', () => {
  assert.deepEqual(decide({ local: true, windowOpen: false, tempKeyId: null, verdict: ok() }), { pass: true })
  assert.deepEqual(decide({ local: true, windowOpen: true, tempKeyId: 'temp', verdict: ok() }), { pass: true })
})

test('a local failure while the window is open closes it too', () => {
  const step = decide({ local: true, windowOpen: true, tempKeyId: 'temp', verdict: { ok: false, reason: 'wrong scope' } })
  assert.equal(step.pass, false)
  assert.equal(step.closeReason, 'wrong scope')
})

test('a request with X-Forwarded-For from loopback is decided as remote', () => {
  const local = isLocalRequest(LOOPBACK, headers({ 'X-Forwarded-For': '' }), false)
  assert.equal(local, false)
  assert.deepEqual(decide({ local, windowOpen: false, tempKeyId: null, verdict: null }).status, 404)
})

test('failed attempts are rate-limited per bucket', () => {
  const now = Date.now()
  const from = `ratelimit-${now}`
  assert.equal(overDenialLimit('remote', from, now), false)
  for (let i = 0; i < DENIALS_PER_MINUTE; i++) noteDenial('remote', from, now)
  assert.equal(overDenialLimit('remote', from, now), true)
  assert.equal(overDenialLimit('remote', from, now + 61_000), false)
})
// ── Live cases ───────────────────────────────────────────────────────
// Each live case runs against the dev server and the real tables, and leaves nothing behind:
// every path it calls carries this run's tag, so its audit rows can be found and deleted; the
// window key it opens is tracked and deleted; the window row is reset in after().

const LIVE = process.env.CREW_GATE_LIVE === '1'
const LOOPBACK_SERVER = process.env.CREW_TEST_LOCAL_PEER === 'loopback'
const BASE = process.env.CREW_TEST_BASE ?? 'http://localhost:3000'
const TAG = `t${Date.now().toString(36)}`
const TEST_PATH = `/api/crews/gate-test-${TAG}`
const createdKeyIds: string[] = []

/** Why a live case is skipped, or false when it may run. */
function liveSkip(needsLoopback = false): string | false {
  if (!LIVE) return 'set CREW_GATE_LIVE=1 (with the crew gate schema applied) to run live cases'
  if (needsLoopback && !LOOPBACK_SERVER) return 'needs a dev server that sees a loopback peer: set CREW_TEST_LOCAL_PEER=loopback'
  return false
}

// Forwarding headers make a request from this machine count as remote.
const asRemote = { 'X-Forwarded-For': '198.51.100.9' }

async function adminId(): Promise<string> {
  const [row] = await db.select({ id: user.id }).from(user).where(eq(user.isInstanceAdmin, true))
  if (!row) throw new Error('no instance admin in this database')
  return row.id
}

async function call(path: string, init: RequestInit = {}) {
  return fetch(`${BASE}${path}`, init)
}

// Reads the window row fresh: the cache of this process is forgotten first, because the dev
// server changes the row in its own process.
async function freshGate() {
  const gate = await import('../server/utils/crewGate')
  gate.forgetGate()
  return gate.readGate()
}

// Closes the database client so the test process can exit; the live cases leave a pool open otherwise.
async function closeDb(): Promise<void> {
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end()
}

// The dev server reads the window row through its own cache of up to two seconds. A change made
// in this process reaches it only after that, so the live cases wait it out after each change.
const CROSS_PROCESS_CACHE_MS = 2_100
const waitForCache = () => new Promise(resolve => setTimeout(resolve, CROSS_PROCESS_CACHE_MS))

after(async () => {
  if (!LIVE) return
  // The dev server writes its audit rows once a second; wait for its last batch before deleting them.
  await new Promise(resolve => setTimeout(resolve, 1_500))
  const gate = await import('../server/utils/crewGate')
  await gate.resetGate()
  for (const id of createdKeyIds) await db.delete(apiKeys).where(eq(apiKeys.id, id))
  await db.delete(crewApiAudit).where(like(crewApiAudit.path, `/api/crews/gate-test-${TAG}%`))
  await closeDb()
})

test('live: remote call with the window closed gets a plain 404', { skip: liveSkip() }, async () => {
  const { resetGate } = await import('../server/utils/crewGate')
  await resetGate()
  const res = await call(`${TEST_PATH}-closed`, { headers: asRemote })
  assert.equal(res.status, 404)
  // The dev server prints a stack for errors, so only the message fields are compared.
  const parsed = JSON.parse(await res.text()) as { message?: string, statusMessage?: string }
  assert.equal(parsed.message, 'Not Found')
  assert.equal(parsed.statusMessage, 'Not Found')
})

test('live: local call with no key is refused 401', { skip: liveSkip(true) }, async () => {
  const res = await call(`${TEST_PATH}-local`)
  assert.equal(res.status, 401)
})

test('live: window open, remote with its key passes; a wrong key closes it and the next call sees it shut', { skip: liveSkip() }, async () => {
  const { openWindow } = await import('../server/utils/crewGate')
  const { token } = await openWindow(await adminId(), Date.now())
  await waitForCache()
  const opened = await freshGate()
  if (opened.tempKeyId) createdKeyIds.push(opened.tempKeyId)

  const passed = await call(`${TEST_PATH}-open`, { headers: { ...asRemote, Authorization: `Bearer ${token}` } })
  assert.notEqual(passed.status, 401, 'the window key is accepted by the gate')

  const refused = await call(`${TEST_PATH}-wrong`, { headers: { ...asRemote, Authorization: 'Bearer arn_wrong' } })
  assert.equal(refused.status, 401)
  const closed = await freshGate()
  assert.equal(closed.openUntil, null, 'the window closed')
  assert.equal(closed.closedReason, 'bad key')
  assert.ok(closed.closedFrom, 'the closing caller is recorded')

  // The very next call, with the same key that worked a moment ago, is already refused.
  const next = await call(`${TEST_PATH}-after`, { headers: { ...asRemote, Authorization: `Bearer ${token}` } })
  assert.equal(next.status, 404, 'a close is visible to the next call')
})

test('live: after the window time has passed the temporary key is dead and the window is closed', { skip: liveSkip() }, async () => {
  const { openWindow, readGate, expireWindowIfDue } = await import('../server/utils/crewGate')
  // Opened ten minutes and a bit in the past: its time has already run out.
  const { token } = await openWindow(await adminId(), Date.now() - 11 * 60_000)
  await waitForCache()
  const opened = await readGate()
  if (opened.tempKeyId) createdKeyIds.push(opened.tempKeyId)
  const gate = await expireWindowIfDue(opened, Date.now())
  assert.equal(gate.openUntil, null)
  assert.equal(gate.closedReason, 'timed out')
  const res = await call(`${TEST_PATH}-expired`, { headers: { ...asRemote, Authorization: `Bearer ${token}` } })
  assert.equal(res.status, 404, 'remote with the window shut is 404 again')
})
