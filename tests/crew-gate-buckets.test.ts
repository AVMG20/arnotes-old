// Rate-limit buckets of the crew API gate: a local caller and the remote clients have separate maps,
// a remote bucket never answers 429, and each map is bounded so one cannot evict the other.
// The live case needs a dev server that sees a loopback peer (CREW_TEST_LOCAL_PEER=loopback)
// and CREW_GATE_LIVE=1.
//   node --env-file-if-exists=.env --import tsx --test tests/crew-gate-buckets.test.ts
import { after, test } from 'node:test'
import { like } from 'drizzle-orm'
import { db } from '../server/db'
import { crewApiAudit } from '../server/db/schema'
import assert from 'node:assert/strict'
import {
  auditPeer, clientAddress, denialKeyCount, DENIALS_PER_MINUTE, limitedStatus, MAX_RATE_KEYS,
  noteDenial, overDenialLimit, rateKey
} from '../server/utils/crewGatePolicy'

const UNIX = { kind: 'unix' as const }
const LOOPBACK = { kind: 'tcp' as const, address: '127.0.0.1' }
const real = (ip: string) => new Headers({ 'X-Real-IP': ip })

test('a remote client is keyed by the X-Real-IP nginx passed on, so two clients have two buckets', () => {
  const a = rateKey(false, UNIX, real('203.0.113.7'))
  const b = rateKey(false, UNIX, real('198.51.100.2'))
  assert.notEqual(a, b)
  assert.equal(a, '203.0.113.7')
})

test('a remote call without X-Real-IP falls back to its peer; an empty header counts as absent', () => {
  assert.equal(rateKey(false, LOOPBACK, new Headers()), '127.0.0.1')
  assert.equal(rateKey(false, UNIX, real('   ')), 'unix')
})

test('a local caller is keyed by its peer, whatever headers it carries', () => {
  assert.equal(rateKey(true, UNIX, real('203.0.113.7')), 'unix')
  assert.equal(rateKey(true, LOOPBACK, new Headers()), '127.0.0.1')
})

test('the client address is cleaned to hex, colons and dots, lower-cased and capped at 45 characters', () => {
  assert.equal(clientAddress(real(' 2001:DB8::1 ')), '2001:db8::1')
  assert.equal(clientAddress(real('<script>203.0.113.7</script>')), 'c203.0.113.7c')
  assert.equal(clientAddress(real('a'.repeat(80)))?.length, 45)
  assert.equal(clientAddress(new Headers()), null)
})

test('the audit peer shows the proxied client next to the socket', () => {
  assert.equal(auditPeer(UNIX, real('203.0.113.7')), 'unix (client 203.0.113.7)')
  assert.equal(auditPeer(UNIX, new Headers()), 'unix')
})

test('ten refusals from one remote client do not limit the local caller', () => {
  const remote = rateKey(false, UNIX, real('203.0.113.99'))
  const local = rateKey(true, UNIX, new Headers())
  const now = Date.now()
  for (let i = 0; i < DENIALS_PER_MINUTE; i++) noteDenial('remote', remote, now)
  assert.equal(overDenialLimit('remote', remote, now), true, 'the remote bucket is full')
  assert.equal(overDenialLimit('local', local, now), false, 'the local bucket is untouched')
})

test('a full remote bucket answers 404, never 429; a full local bucket answers 429', () => {
  assert.equal(limitedStatus(false), 404)
  assert.equal(limitedStatus(true), 429)
})

test('two remote clients fill their own buckets independently', () => {
  const now = Date.now() + 1_000_000
  const a = rateKey(false, UNIX, real('192.0.2.1'))
  const b = rateKey(false, UNIX, real('192.0.2.2'))
  for (let i = 0; i < DENIALS_PER_MINUTE; i++) noteDenial('remote', a, now)
  assert.equal(overDenialLimit('remote', a, now), true)
  assert.equal(overDenialLimit('remote', b, now), false)
})

test('a flood in the remote map never evicts the local map', () => {
  const now = Date.now() + 2_000_000
  for (let i = 0; i < DENIALS_PER_MINUTE; i++) noteDenial('local', 'unix', now)
  assert.equal(overDenialLimit('local', 'unix', now), true, 'the local bucket is full before the flood')
  for (let i = 0; i < MAX_RATE_KEYS + 500; i++) noteDenial('remote', `flood-${i}`, now)
  assert.ok(denialKeyCount('remote') <= MAX_RATE_KEYS, `remote map capped, got ${denialKeyCount('remote')}`)
  assert.equal(overDenialLimit('local', 'unix', now), true, 'the local bucket survived the flood')
})

test('the remote map is bounded and drops the least recently refused keys first', () => {
  const now = Date.now() + 3_000_000
  for (let i = 0; i < MAX_RATE_KEYS + 500; i++) noteDenial('remote', `bounded-${i}`, now)
  assert.ok(denialKeyCount('remote') <= MAX_RATE_KEYS)
  // The newest key survived; the first one was dropped to make room.
  assert.equal(overDenialLimit('remote', `bounded-${MAX_RATE_KEYS + 499}`, now), false)
  noteDenial('remote', 'bounded-after', now)
  assert.ok(denialKeyCount('remote') <= MAX_RATE_KEYS)
})

test('a refusal is counted for its minute only: after a minute the bucket is clear again', () => {
  const key = 'expires-1'
  for (let i = 0; i < DENIALS_PER_MINUTE; i++) noteDenial('remote', key, 1_000)
  assert.equal(overDenialLimit('remote', key, 1_000), true)
  assert.equal(overDenialLimit('remote', key, 1_000 + 61_000), false)
})

// Live: ten refused remote calls from one client, then a local call. The local call must not be 429.
// Every call carries this run's tag in its path, and the audit rows with that tag are deleted after.
const LIVE = process.env.CREW_GATE_LIVE === '1'
const LOOPBACK_SERVER = process.env.CREW_TEST_LOCAL_PEER === 'loopback'
const TAG = `b${Date.now().toString(36)}`
const TEST_PATH = `/api/crews/bucket-test-${TAG}`

function bucketSkip(): string | false {
  if (!LIVE) return 'set CREW_GATE_LIVE=1 (with the crew gate schema applied) to run live cases'
  if (!LOOPBACK_SERVER) return 'needs a dev server that sees a loopback peer: set CREW_TEST_LOCAL_PEER=loopback'
  return false
}

// Closes the database client so the test process can exit after a live run.
async function closeDb(): Promise<void> {
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end()
}

after(async () => {
  if (!LIVE) return
  // The dev server writes its audit rows once a second; wait for its last batch before deleting them.
  await new Promise(resolve => setTimeout(resolve, 1_500))
  await db.delete(crewApiAudit).where(like(crewApiAudit.path, `/api/crews/bucket-test-${TAG}%`))
  await closeDb()
})

test('live: ten remote 404s from one client do not lock out the local caller', { skip: bucketSkip() }, async () => {
  const base = process.env.CREW_TEST_BASE ?? 'http://localhost:3000'
  for (let i = 0; i < DENIALS_PER_MINUTE + 2; i++) {
    const res = await fetch(`${base}${TEST_PATH}-${i}`, { headers: { 'X-Forwarded-For': '198.51.100.50', 'X-Real-IP': '198.51.100.50' } })
    assert.equal(res.status, 404, 'a remote refusal is always 404, never 429')
  }
  const local = await fetch(`${base}${TEST_PATH}-local`)
  assert.notEqual(local.status, 429, 'the local bucket is untouched')
  assert.equal(local.status, 401)
})
