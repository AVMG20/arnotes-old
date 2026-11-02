// The PM's side of failed GitHub deliveries (GH6c): the tools' functions (list, get, retry, discard, queue status),
// the failure code, the payload preview and the tool definitions. Run on fake rows that keep the rules of the Drizzle
// store, a fake queue, and fake linked projects with the audience of mcpAccess. The database is not used here.
//   TSX_TSCONFIG_PATH=.nuxt/tsconfig.server.json node --import tsx --test tests/github-delivery-failures.test.ts
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { ApiKeyContext } from '../server/utils/api-keys'
import { MCP_BOARD_TOOLS } from '../server/utils/mcpBoardTools'
import { McpToolError } from '../server/utils/mcpToolKit'
import type { DeliveryQueue } from '../server/utils/githubDeliveryQueueTypes'
import { toolsForScopes } from '../server/utils/mcpRegistry'
import {
  failureCode, itemOf, managedRepos, pmDiscard, pmGet, pmList, pmQueueStatus, pmRetry, previewOf, RETRY_CLAIM_MS
} from '../server/utils/githubDeliveryFailures'

const NOW = 1_800_000_000_000
const NOT_LINKED = 'not linked to a project you can manage'
const PM_ONLY = 'retrying and discarding are for the crew\'s pm key'
const BODY_SENTINEL = 'SECRET-BODY-TEXT-do-not-show'
const PAYLOAD_SENTINEL = 'PAYLOAD-SENTINEL-do-not-show'

interface Stored {
  deliveryId: string
  event: string
  owner: string | null
  repo: string | null
  repoId: number | null
  attempts: number
  class: 'transient' | 'permanent'
  reason: string | null
  payload: string | null
  firstSeenAt: number
  failedAt: number
  state: FailureState
  retriedCount: number
  handledBy: string | null
  handledAt: number | null
  handledReason: string | null
}

function metadataOf(row: Stored): FailureRow {
  return {
    deliveryId: row.deliveryId,
    event: row.event,
    owner: row.owner,
    repo: row.repo,
    repoId: row.repoId,
    attempts: row.attempts,
    class: row.class,
    reason: row.reason,
    hasPayload: row.payload !== null,
    firstSeenAt: row.firstSeenAt,
    failedAt: row.failedAt,
    state: row.state,
    retriedCount: row.retriedCount,
    handledBy: row.handledBy,
    handledAt: row.handledAt,
    handledReason: row.handledReason
  }
}

function inRepos(row: Stored, repos: RepoKey[]): boolean {
  return repos.some(key => row.owner?.toLowerCase() === key.owner.toLowerCase() && row.repo?.toLowerCase() === key.repo.toLowerCase())
}

/** The rows with the guards of the Drizzle store: a claim and a discard only from failed (or a retry whose claim expired). */
function fakeStore() {
  const stored = new Map<string, Stored>()
  const stale = (row: Stored, at: number) => row.state === 'retried' && (row.handledAt ?? 0) < at - RETRY_CLAIM_MS
  const rows: FailureRows = {
    async exists(deliveryId) {
      return stored.has(deliveryId)
    },
    async find(deliveryId) {
      const row = stored.get(deliveryId)
      return row ? { ...metadataOf(row), payload: row.payload } : null
    },
    async upsertFailed(row: NewFailure) {
      const old = stored.get(row.deliveryId)
      if (old && old.state !== 'retried') return
      stored.set(row.deliveryId, {
        deliveryId: row.deliveryId,
        event: row.event,
        owner: row.owner,
        repo: row.repo,
        repoId: row.repoId,
        attempts: row.attempts,
        class: row.class,
        reason: row.reason,
        payload: row.payload,
        firstSeenAt: old?.firstSeenAt ?? row.firstSeenAt,
        failedAt: row.failedAt,
        state: 'failed',
        retriedCount: old?.retriedCount ?? 0,
        handledBy: old?.handledBy ?? null,
        handledAt: old?.handledAt ?? null,
        handledReason: old?.handledReason ?? null
      })
    },
    async claimForRetry(deliveryId, actor, at) {
      const row = stored.get(deliveryId)
      if (!row) return { ok: false, reason: 'missing' }
      const takeover = stale(row, at)
      if (row.state !== 'failed' && !takeover) return { ok: false, reason: row.state === 'retried' ? 'already retried' : 'not failed' }
      if (row.payload === null) return { ok: false, reason: 'payload expired' }
      row.state = 'retried'
      row.retriedCount += 1
      row.handledBy = actor
      row.handledAt = at
      row.handledReason = takeover ? 'claim expired' : null
      return { ok: true, event: row.event, payload: row.payload, takeover }
    },
    async releaseRetry(deliveryId) {
      const row = stored.get(deliveryId)
      if (row?.state === 'retried') {
        row.state = 'failed'
        row.retriedCount = Math.max(row.retriedCount - 1, 0)
      }
    },
    async markResolved(deliveryId) {
      const row = stored.get(deliveryId)
      if (!row || (row.state !== 'failed' && row.state !== 'retried')) return false
      row.state = 'resolved'
      return true
    },
    async setDiscarded(deliveryId, actor, reason, at) {
      const row = stored.get(deliveryId)
      if (!row || !(row.state === 'failed' || stale(row, at))) return false
      row.state = 'discarded'
      row.handledBy = actor
      row.handledAt = at
      row.handledReason = reason
      return true
    },
    async list(limit) {
      return [...stored.values()].sort((a, b) => b.failedAt - a.failedAt).slice(0, limit).map(metadataOf)
    },
    async count() {
      return [...stored.values()].filter(row => row.state === 'failed').length
    },
    async stripPayloads() {
      return 0
    }
  }
  const reads: FailureReads = {
    async list({ limit, state, repos }) {
      return [...stored.values()]
        .filter(row => (state === null || row.state === state) && inRepos(row, repos))
        .sort((a, b) => b.failedAt - a.failedAt)
        .slice(0, limit)
        .map(metadataOf)
    },
    async countByState(repos) {
      const counts: Partial<Record<FailureState, number>> = {}
      for (const row of stored.values()) {
        if (inRepos(row, repos)) counts[row.state] = (counts[row.state] ?? 0) + 1
      }
      return counts
    }
  }
  return { rows, reads, stored }
}

/** A queue that records each publish, or throws when told to. */
function fakeQueue(failWith: string | null = null) {
  const published: { queue: string, deliveryId: string, attempt: number, body: string }[] = []
  const queue = {
    async publish(name: string, message: { deliveryId: string, attempt: number, body: Buffer }) {
      if (failWith) throw new Error(failWith)
      published.push({ queue: name, deliveryId: message.deliveryId, attempt: message.attempt, body: message.body.toString('utf8') })
    }
  }
  return { published, deps: () => queue as unknown as DeliveryQueue }
}

const CONTACTS: Record<string, string[]> = { 'contact-user': ['acme'] }

// The linked repositories: the team's own, another crew's, and a customer's board the contact can open.
const LINKED: LinkedProject[] = [
  { owner: 'example-owner', repo: 'arnotes', project: { id: 'p-team', name: 'Team board', userId: 'pm-user', teamId: 'team-c', customerId: null } },
  { owner: 'other-owner', repo: 'other', project: { id: 'p-x', name: 'Other crew', userId: 'x-user', teamId: 'team-x', customerId: null } },
  { owner: 'example-owner', repo: 'arnotes-customer', project: { id: 'p-cust', name: 'Customer board', userId: 'pm-user', teamId: null, customerId: 'acme' } }
]

/** The boards a key can open, as boardFilter says: a team key its team's; a personal key its own and its customers'. */
function visibleTo(context: ApiKeyContext, project: LinkedProject['project']): boolean {
  if (context.teamId) return project.teamId === context.teamId
  if (project.teamId === null && project.userId === context.userId) return true
  return project.customerId !== null && (CONTACTS[context.userId] ?? []).includes(project.customerId)
}

async function linked(context: ApiKeyContext, only: RepoKey | null): Promise<LinkedProject[]> {
  return LINKED.filter(entry => visibleTo(context, entry.project)
    && (!only || (entry.owner.toLowerCase() === only.owner.toLowerCase() && entry.repo.toLowerCase() === only.repo.toLowerCase())))
}

const pmKey: ApiKeyContext = { keyId: 'k-pm', keyName: 'pm key', userId: 'pm-user', teamId: 'team-c', scopes: ['boards:read', 'boards:write'] }
const contactKey: ApiKeyContext = { keyId: 'k-contact', keyName: 'contact key', userId: 'contact-user', teamId: null, scopes: ['boards:read'] }
const otherKey: ApiKeyContext = { keyId: 'k-other', keyName: 'other key', userId: 'x-user', teamId: 'team-x', scopes: ['boards:read', 'boards:write'] }

const teamPayload = JSON.stringify({
  action: 'opened',
  repository: { full_name: 'example-owner/arnotes' },
  pull_request: { number: 12, title: 'Fix login\u0007 now\nwith a break', body: BODY_SENTINEL }
}).replace('}', `, "extra": "${PAYLOAD_SENTINEL}"}`)

function seed(store: ReturnType<typeof fakeStore>, extra: Partial<Stored> & { deliveryId: string }) {
  store.stored.set(extra.deliveryId, {
    event: 'pull_request',
    owner: 'example-owner',
    repo: 'arnotes',
    repoId: 1,
    attempts: 3,
    class: 'transient',
    reason: 'timeout: the work took longer than 60 s',
    payload: teamPayload,
    firstSeenAt: NOW - 1000,
    failedAt: NOW - 1000,
    state: 'failed',
    retriedCount: 0,
    handledBy: null,
    handledAt: null,
    handledReason: null,
    ...extra
  })
}

const CREW_PEOPLE = [{ userId: 'pm-user', key: 'pm' }, { userId: 'w1-user', key: 'w1' }]

function deps(store: ReturnType<typeof fakeStore>, queue = fakeQueue()): PmDeps {
  return { rows: store.rows, reads: store.reads, linked, queue: queue.deps, now: () => NOW, crewPeople: async () => CREW_PEOPLE }
}

async function refusedWith(work: () => Promise<unknown>, message: string) {
  await assert.rejects(work, (error: unknown) => error instanceof McpToolError && error.message === message)
}

describe('the PM lists and reads: staff only, metadata only', () => {
  test('a team key sees and manages only the repository of its team\'s project', async () => {
    const store = fakeStore()
    seed(store, { deliveryId: 'd-team' })
    seed(store, { deliveryId: 'd-other', owner: 'other-owner', repo: 'other', failedAt: NOW - 500 })
    seed(store, { deliveryId: 'd-customer', owner: 'example-owner', repo: 'arnotes-customer', failedAt: NOW - 400 })
    assert.deepEqual(await managedRepos(pmKey, deps(store)), [{ owner: 'example-owner', repo: 'arnotes' }])
    const listed = await pmList(pmKey, { limit: 50, state: 'failed' }, deps(store))
    assert.deepEqual(listed.items.map(item => item.id), ['d-team'])
    assert.equal(listed.failed, 1)
  })

  test('the list is newest first, carries no payload, and the item names the repository', async () => {
    const store = fakeStore()
    seed(store, { deliveryId: 'd-old', failedAt: NOW - 5000 })
    seed(store, { deliveryId: 'd-new', failedAt: NOW - 100 })
    const listed = await pmList(pmKey, { limit: 50, state: 'all' }, deps(store))
    assert.deepEqual(listed.items.map(item => item.id), ['d-new', 'd-old'])
    assert.equal(listed.items[0]!.repo, 'example-owner/arnotes')
    const text = JSON.stringify(listed)
    assert.doesNotMatch(text, /payload|PAYLOAD-SENTINEL|SECRET-BODY/)
    assert.ok(!Object.keys(listed.items[0]!).includes('payload'))
  })

  test('get shows the metadata and a short preview, never the body or the payload', async () => {
    const store = fakeStore()
    seed(store, { deliveryId: 'd-team' })
    const one = await pmGet(pmKey, 'd-team', deps(store))
    assert.equal(one.board.name, 'Team board')
    assert.equal(one.item.id, 'd-team')
    assert.deepEqual(one.preview, { event: 'pull_request', action: 'opened', repository: 'example-owner/arnotes', number: 12, title: 'Fix login  now with a break' })
    const text = JSON.stringify(one)
    assert.doesNotMatch(text, /SECRET-BODY|PAYLOAD-SENTINEL/)
  })

  test('a delivery of another crew is refused with the same words as a missing one', async () => {
    const store = fakeStore()
    seed(store, { deliveryId: 'd-other', owner: 'other-owner', repo: 'other' })
    await refusedWith(() => pmGet(pmKey, 'd-other', deps(store)), NOT_LINKED)
    await refusedWith(() => pmGet(pmKey, 'd-missing', deps(store)), NOT_LINKED)
    await refusedWith(() => pmGet(otherKey, 'd-team-missing', deps(store)), NOT_LINKED)
  })

  test('a customer contact sees nothing and is refused on the customer board too', async () => {
    const store = fakeStore()
    seed(store, { deliveryId: 'd-customer', owner: 'example-owner', repo: 'arnotes-customer' })
    assert.deepEqual(await managedRepos(contactKey, deps(store)), [])
    assert.deepEqual((await pmList(contactKey, { limit: 50, state: 'all' }, deps(store))).items, [])
    await refusedWith(() => pmGet(contactKey, 'd-customer', deps(store)), NOT_LINKED)
    await refusedWith(() => pmRetry(contactKey, 'd-customer', deps(store)), NOT_LINKED)
    await refusedWith(() => pmDiscard(contactKey, 'd-customer', 'not for a contact', deps(store)), NOT_LINKED)
    assert.equal(store.stored.get('d-customer')!.state, 'failed')
  })

  test('the status is refused to a key with no repository it manages', async () => {
    const store = fakeStore()
    await refusedWith(() => pmQueueStatus(contactKey, deps(store)), NOT_LINKED)
  })
})

describe('retry and discard: once per row, the claim rules, the messages', () => {
  test('a retry publishes the stored payload once with attempt 0; a second call says already retried', async () => {
    const store = fakeStore()
    const queue = fakeQueue()
    seed(store, { deliveryId: 'd-team' })
    const first = await pmRetry(pmKey, 'd-team', deps(store, queue))
    assert.equal(first.outcome, 'retried')
    assert.equal(first.message, 'retried')
    assert.equal(first.board.name, 'Team board')
    const second = await pmRetry(pmKey, 'd-team', deps(store, queue))
    assert.equal(second.outcome, 'not retried')
    assert.equal(second.message, 'already retried')
    assert.equal(queue.published.length, 1)
    assert.equal(queue.published[0]!.queue, 'main')
    assert.equal(queue.published[0]!.attempt, 0)
    assert.equal(queue.published[0]!.body, teamPayload)
    assert.equal(store.stored.get('d-team')!.retriedCount, 1)
  })

  test('two retries at once, from two sessions, publish once', async () => {
    const store = fakeStore()
    const queue = fakeQueue()
    seed(store, { deliveryId: 'd-team' })
    const results = await Promise.all([pmRetry(pmKey, 'd-team', deps(store, queue)), pmRetry(pmKey, 'd-team', deps(store, queue))])
    assert.deepEqual(results.map(result => result.outcome).sort(), ['not retried', 'retried'])
    assert.equal(queue.published.length, 1)
  })

  test('a retry whose publish is not confirmed puts the row back to failed and says so', async () => {
    const store = fakeStore()
    seed(store, { deliveryId: 'd-team' })
    const result = await pmRetry(pmKey, 'd-team', deps(store, fakeQueue('broker said no')))
    assert.equal(result.outcome, 'not sent')
    assert.match(result.message, /the row is failed again/)
    assert.equal(store.stored.get('d-team')!.state, 'failed')
    assert.equal(store.stored.get('d-team')!.retriedCount, 0)
  })

  test('a retry of a row whose payload expired says so and publishes nothing', async () => {
    const store = fakeStore()
    const queue = fakeQueue()
    seed(store, { deliveryId: 'd-team', payload: null })
    const result = await pmRetry(pmKey, 'd-team', deps(store, queue))
    assert.equal(result.message, 'payload expired')
    assert.equal(queue.published.length, 0)
  })

  test('a retry whose claim went stale is taken over and the result says so', async () => {
    const store = fakeStore()
    const queue = fakeQueue()
    seed(store, { deliveryId: 'd-team', state: 'retried', handledAt: NOW - RETRY_CLAIM_MS - 1000, handledBy: 'pm key', retriedCount: 1 })
    const result = await pmRetry(pmKey, 'd-team', deps(store, queue))
    assert.equal(result.message, 'claim expired — retried again')
    assert.equal(queue.published.length, 1)
  })

  test('a discard needs the row to be failed: the first sets the reason, the second says not failed', async () => {
    const store = fakeStore()
    seed(store, { deliveryId: 'd-team' })
    const done = await pmDiscard(pmKey, 'd-team', 'the payload is for a branch that is gone', deps(store))
    assert.equal(done.outcome, 'discarded')
    assert.equal(store.stored.get('d-team')!.state, 'discarded')
    assert.equal(store.stored.get('d-team')!.handledReason, 'the payload is for a branch that is gone')
    assert.equal(store.stored.get('d-team')!.payload, teamPayload, 'the payload stays for the audit')
    const again = await pmDiscard(pmKey, 'd-team', 'again', deps(store))
    assert.equal(again.outcome, 'not discarded')
    assert.equal(again.message, 'not failed')
  })

  test('a retry or discard of another crew\'s delivery changes nothing', async () => {
    const store = fakeStore()
    const queue = fakeQueue()
    seed(store, { deliveryId: 'd-other', owner: 'other-owner', repo: 'other' })
    await refusedWith(() => pmRetry(pmKey, 'd-other', deps(store, queue)), NOT_LINKED)
    await refusedWith(() => pmDiscard(pmKey, 'd-other', 'not ours to drop', deps(store, queue)), NOT_LINKED)
    assert.equal(store.stored.get('d-other')!.state, 'failed')
    assert.equal(queue.published.length, 0)
  })

  test('a worker key lists and reads its team\'s deliveries, but cannot retry or discard them', async () => {
    const store = fakeStore()
    const queue = fakeQueue()
    seed(store, { deliveryId: 'd-team' })
    const worker: ApiKeyContext = { keyId: 'k-w1', keyName: 'w1 key', userId: 'w1-user', teamId: 'team-c', scopes: ['boards:read', 'boards:write'] }
    assert.equal((await pmGet(worker, 'd-team', deps(store, queue))).item.id, 'd-team')
    assert.equal((await pmList(worker, { limit: 50, state: 'failed' }, deps(store, queue))).items.length, 1)
    await refusedWith(() => pmRetry(worker, 'd-team', deps(store, queue)), PM_ONLY)
    await refusedWith(() => pmDiscard(worker, 'd-team', 'a worker may not drop it', deps(store, queue)), PM_ONLY)
    assert.equal(store.stored.get('d-team')!.state, 'failed')
    assert.equal(queue.published.length, 0)
  })
})

describe('the failure code and the payload preview', () => {
  test('a reason becomes a short code and the reason text is never returned', () => {
    assert.equal(failureCode('timeout: the work took longer than 60 s'), 'timeout')
    assert.equal(failureCode('the body is not JSON'), 'not-json')
    assert.equal(failureCode('handed out 4 times by the broker (limit 5)'), 'broker-limit')
    assert.equal(failureCode('an earlier attempt of this repository is still running'), 'busy')
    assert.equal(failureCode('could not record the failure (Error)'), 'storage')
    assert.equal(failureCode('some reason we did not expect'), 'other')
  })

  test('the preview cuts the title to 120 and strips control characters; a body never appears', () => {
    const payload = JSON.stringify({ action: 'edited', pull_request: { number: 7, title: 'x'.repeat(300) + '\u0007', body: BODY_SENTINEL } })
    const preview = previewOf('pull_request', payload)!
    assert.equal(preview.title!.length, 120)
    assert.equal(preview.number, 7)
    assert.doesNotMatch(JSON.stringify(preview), /SECRET-BODY/)
    assert.equal(previewOf('pull_request', null), null, 'an expired payload has no preview')
    assert.deepEqual(previewOf('issues', 'not json'), { event: 'issues', action: null, repository: null, number: null, title: null })
  })

  test('itemOf keeps metadata and nothing else', () => {
    const store = fakeStore()
    seed(store, { deliveryId: 'd-team' })
    const item = itemOf(metadataOf(store.stored.get('d-team')!))
    assert.equal(item.repo, 'example-owner/arnotes')
    assert.equal(item.hasPayload, true)
    assert.ok(!Object.keys(item).includes('payload'))
  })
})

describe('a key from another crew is refused every delivery action', () => {
  test('a stranger with boards:write cannot retry or discard a team\'s delivery, and nothing changes', async () => {
    const store = fakeStore()
    const queue = fakeQueue()
    seed(store, { deliveryId: 'd-team' })
    const stranger: ApiKeyContext = { keyId: 'k-s', keyName: 'stranger', userId: 'x-user', teamId: 'team-x', scopes: ['boards:read', 'boards:write'] }
    await refusedWith(() => pmRetry(stranger, 'd-team', deps(store, queue)), NOT_LINKED)
    await refusedWith(() => pmDiscard(stranger, 'd-team', 'a stranger drops it', deps(store, queue)), NOT_LINKED)
    assert.equal(store.stored.get('d-team')!.state, 'failed')
    assert.equal(queue.published.length, 0)
  })
})

describe('the queue status: a fixed state, never the broker detail', () => {
  test('the status is a fixed state word and sentence, and never the detail, a host or a port', async () => {
    const store = fakeStore()
    seed(store, { deliveryId: 'd-team' })
    const detail = 'connect ECONNREFUSED 10.1.2.3:5672 (amqp://arnotes:hunter2-password@10.1.2.3:5672/arnotes)'
    const health = { state: 'unavailable' as const, broker: 'amqp://***@10.1.2.3:5672/arnotes', detail, depth: null, failed: null }
    const status = await pmQueueStatus(pmKey, { ...deps(store), health: async () => health })
    assert.deepEqual(Object.keys(status.queue).sort(), ['depth', 'failedDepth', 'sentence', 'state'])
    assert.equal(status.queue.state, 'unavailable')
    assert.match(status.queue.sentence, /cannot be reached/)
    assert.equal(status.queue.depth, null)
    assert.deepEqual(status.failedRows, { failed: 1 })
    assert.doesNotMatch(JSON.stringify(status), /10\.1\.2\.3|5672|hunter2|amqp|ECONNREFUSED/)
  })

  test('a connected queue shows its depths and the connected sentence', async () => {
    const store = fakeStore()
    const health = { state: 'connected' as const, broker: 'amqp://***@127.0.0.1:5672/arnotes', depth: 3, failed: 1 }
    const status = await pmQueueStatus(pmKey, { ...deps(store), health: async () => health })
    assert.equal(status.queue.state, 'connected')
    assert.equal(status.queue.sentence, 'The queue is connected.')
    assert.equal(status.queue.depth, 3)
    assert.equal(status.queue.failedDepth, 1)
    assert.doesNotMatch(JSON.stringify(status), /127\.0\.0\.1|5672|amqp/)
  })

  test('the real health view never shows a password it was not given', async () => {
    const store = fakeStore()
    const status = await pmQueueStatus(pmKey, deps(store))
    assert.doesNotMatch(JSON.stringify(status), /password|amqp:\/\/[^*]/)
  })
})

describe('the tool definitions: scopes and the read-only key', () => {
  const byName = (name: string) => MCP_BOARD_TOOLS.find(tool => tool.name === name)

  test('each tool has its scope and whether it changes data', () => {
    assert.deepEqual(['list_failed_deliveries', 'get_failed_delivery', 'github_queue_status'].map(name => [byName(name)?.scope, byName(name)?.readOnly]), [
      ['boards:read', true], ['boards:read', true], ['boards:read', true]
    ])
    assert.deepEqual(['retry_failed_delivery', 'discard_failed_delivery'].map(name => [byName(name)?.scope, byName(name)?.readOnly]), [
      ['boards:write', false], ['boards:write', false]
    ])
  })

  test('a read-only key is not offered the retry or the discard', () => {
    const offered = toolsForScopes(['boards:read']).map(tool => tool.name)
    assert.ok(offered.includes('list_failed_deliveries'))
    assert.ok(offered.includes('get_failed_delivery'))
    assert.ok(offered.includes('github_queue_status'))
    assert.ok(!offered.includes('retry_failed_delivery'))
    assert.ok(!offered.includes('discard_failed_delivery'))
  })

  test('a read of one delivery is audited; a list and the status are not', () => {
    assert.equal(byName('get_failed_delivery')?.audit, true)
    assert.equal(byName('list_failed_deliveries')?.audit, undefined)
    assert.equal(byName('github_queue_status')?.audit, undefined)
  })

  test('the discard tool requires its reason', () => {
    assert.deepEqual(byName('discard_failed_delivery')?.inputSchema.required, ['id', 'reason'])
  })
})
