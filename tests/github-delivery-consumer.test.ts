/* eslint-disable @typescript-eslint/no-explicit-any -- the route is called with a fake H3 event, as in github-cards.test.ts */
// The consumer of GitHub deliveries, the failed table and the PM's functions, run on the in-memory queue (its
// manual clock and crash switches) with a fake card store, a fake ledger and fake failure rows that keep the same
// rules as the Drizzle store. Real processGithubDelivery is not run here: its decisions are in
// github-cards.test.ts. The route tests reach the database only through the link refresh, as in that file.
//   node --import tsx --test tests/github-delivery-consumer.test.ts
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import type { H3Event } from 'h3'
import { DeliveryAborted, DeliveryError, processGithubDelivery } from '../server/utils/githubCards'
import type { DeliveryJob, GithubCardStore } from '../server/utils/githubCards'
import { createDeliveryConsumer, MAX_ATTEMPTS, MAX_BUSY_DEFERRALS } from '../server/utils/githubDeliveryConsumer'
import type { DeliveryLedger } from '../server/utils/githubDeliveryConsumer'
import { createMemoryDeliveryQueue } from '../server/utils/githubDeliveryQueueMemory'
import type { MemoryDeliveryQueue } from '../server/utils/githubDeliveryQueueMemory'
import { DELIVERY_LIMIT, decide } from '../server/utils/githubDeliveryQueueTypes'
import type { DeliveryQueue, HandedMessage } from '../server/utils/githubDeliveryQueueTypes'
import { closeDeliveryQueue, getDeliveryQueue } from '../server/utils/githubDeliveryQueue'
import {
  discardFailedDelivery, failedCount, FAILURE_REASON_MAX, getFailedDelivery, listFailedDeliveries, PAYLOAD_RETENTION_MS, RETRY_CLAIM_MS,
  purgeDeliveryPayloads, retryFailedDelivery
} from '../server/utils/githubDeliveryFailures'
import type { FailureClass, FailureRow, FailureRows, FailureState, NewFailure } from '../server/utils/githubDeliveryFailures'
import webhook from '../server/api/github/webhook.post'
import { db } from '../server/db'

const DAY = 24 * 60 * 60 * 1000
const REPO = 'example-owner/consumer-test'

function fixture(name: string, repo = REPO): string {
  const payload = JSON.parse(readFileSync(new URL(`./fixtures/github/${name}.json`, import.meta.url), 'utf8'))
  payload.repository.full_name = repo
  return JSON.stringify(payload)
}

interface Stored {
  deliveryId: string
  event: string
  owner: string | null
  repo: string | null
  repoId: number | null
  attempts: number
  class: FailureClass
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

/** The failure rows with the rules of the Drizzle implementation: one row per delivery, guarded updates, history kept. */
function fakeRows() {
  const stored = new Map<string, Stored>()
  const view = (row: Stored): FailureRow => {
    const { payload, ...rest } = row
    return { ...rest, hasPayload: payload !== null }
  }
  const fake = {
    stored,
    /** Tests: runs after a row is written, to stand in for a process that dies right there. */
    afterUpsert: null as (() => void) | null,
    /** Tests: makes the next write fail, to stand in for a broken database. */
    failNextWrite: false,
    writable(): void {
      if (fake.failNextWrite) {
        fake.failNextWrite = false
        throw new Error('database write failed')
      }
    },
    async exists(deliveryId: string) {
      return stored.has(deliveryId)
    },
    async find(deliveryId: string) {
      const row = stored.get(deliveryId)
      return row ? { ...view(row), payload: row.payload } : null
    },
    async upsertFailed(row: NewFailure) {
      fake.writable()
      const existing = stored.get(row.deliveryId)
      if (!existing) {
        stored.set(row.deliveryId, { ...row, retriedCount: 0, state: 'failed', handledBy: null, handledAt: null, handledReason: null })
      } else if (existing.state === 'retried') {
        // The PM's history stays; only the failure itself is new.
        Object.assign(existing, { attempts: row.attempts, class: row.class, reason: row.reason, payload: row.payload, failedAt: row.failedAt, state: 'failed' })
      }
      fake.afterUpsert?.()
    },
    async claimForRetry(deliveryId: string, actor: string, at: number) {
      const row = stored.get(deliveryId)
      if (!row) return { ok: false as const, reason: 'missing' as const }
      const expired = row.state === 'retried' && (row.handledAt ?? 0) < at - RETRY_CLAIM_MS
      if (row.state === 'retried' && !expired) return { ok: false as const, reason: 'already retried' as const }
      if (row.state !== 'failed' && !expired) return { ok: false as const, reason: 'not failed' as const }
      if (row.payload === null) return { ok: false as const, reason: 'payload expired' as const }
      Object.assign(row, { state: 'retried', retriedCount: row.retriedCount + 1, handledBy: actor, handledAt: at, handledReason: expired ? 'claim expired' : null })
      return { ok: true as const, event: row.event, payload: row.payload, takeover: expired }
    },
    async releaseRetry(deliveryId: string) {
      const row = stored.get(deliveryId)
      if (row?.state === 'retried') {
        row.state = 'failed'
        row.retriedCount = Math.max(0, row.retriedCount - 1)
      }
    },
    async markResolved(deliveryId: string) {
      const row = stored.get(deliveryId)
      if (!row || (row.state !== 'retried' && row.state !== 'failed')) return false
      row.state = 'resolved'
      return true
    },
    async setDiscarded(deliveryId: string, actor: string, reason: string, at: number) {
      const row = stored.get(deliveryId)
      // A failed row, or a retried one whose claim has expired (the same rule as the Drizzle store).
      const expired = row?.state === 'retried' && (row.handledAt ?? 0) < at - RETRY_CLAIM_MS
      if (!row || (row.state !== 'failed' && !expired)) return false
      Object.assign(row, { state: 'discarded', handledBy: actor, handledAt: at, handledReason: reason.slice(0, FAILURE_REASON_MAX) })
      return true
    },
    async list(limit: number) {
      return [...stored.values()].map(view).slice(0, limit)
    },
    async count() {
      return [...stored.values()].filter(row => row.state === 'failed').length
    },
    /** The rule: the later of failed_at and handled_at is older than the retention. Batches are not needed to test it. */
    async stripPayloads(now: number) {
      let stripped = 0
      for (const row of stored.values()) {
        const latest = Math.max(row.failedAt, row.handledAt ?? 0)
        if (row.payload !== null && latest < now - PAYLOAD_RETENTION_MS) {
          row.payload = null
          stripped += 1
        }
      }
      return stripped
    }
  }
  return fake as typeof fake & FailureRows
}

function fakeLedger() {
  const applied = new Map<string, { event: string, owner: string, repo: string }>()
  const ledger = {
    /** Tests: a read or write that does not answer (true), or fails (throws). */
    hang: false,
    broken: false,
    async succeeded(deliveryId: string) {
      if (ledger.broken) throw new Error('ledger read failed')
      if (ledger.hang) return new Promise<boolean>(() => {})
      return applied.has(deliveryId)
    },
    async recordSucceeded(entry: { deliveryId: string, event: string, owner: string, repo: string }) {
      if (ledger.broken) throw new Error('ledger write failed')
      if (!applied.has(entry.deliveryId)) applied.set(entry.deliveryId, { event: entry.event, owner: entry.owner, repo: entry.repo })
    }
  }
  return { applied, ledger: ledger as DeliveryLedger & typeof ledger }
}

type Work = (job: DeliveryJob, call: number) => unknown

interface HarnessOptions {
  workLimitMs?: number
  dbLimitMs?: number
  holdMaxAgeMs?: number
  handlerTimeoutMs?: number
  beforeFail?: (message: HandedMessage, reason: string) => Promise<void>
}

function harness(work: Work, options: HarnessOptions = {}) {
  const time = { ms: 0 }
  const queue: MemoryDeliveryQueue = createMemoryDeliveryQueue({ manualClock: true })
  // The consumer and the queue run on the same clock: advancing the queue advances the holds' age too.
  const advanceQueue = queue.advance.bind(queue)
  queue.advance = (ms: number) => {
    time.ms += ms
    advanceQueue(ms)
  }
  const rows = fakeRows()
  const { applied, ledger } = fakeLedger()
  const calls: string[] = []
  let count = 0
  const consumer = createDeliveryConsumer(queue, {
    ledger,
    failures: rows,
    apply: async (job) => {
      count += 1
      calls.push(`${job.deliveryId}:${job.attempt}`)
      return work(job, count)
    },
    log: () => {},
    budgetMs: options.workLimitMs,
    dbLimitMs: options.dbLimitMs,
    holdMaxAgeMs: options.holdMaxAgeMs,
    now: () => time.ms
  })
  let stop: (() => Promise<void>) | null = null
  return {
    queue,
    rows,
    applied,
    ledger,
    calls,
    consumer,
    async start() {
      stop = await queue.consume(consumer.handle, {
        prefetch: 1,
        handlerTimeoutMs: options.handlerTimeoutMs,
        beforeFail: options.beforeFail ?? consumer.beforeFail
      })
    },
    async stopNow() {
      await stop?.()
      stop = null
    },
    publish(deliveryId: string, body: string, event = 'issues') {
      return queue.publish('main', { deliveryId, event, attempt: 0, body: Buffer.from(body, 'utf8') })
    }
  }
}

/** Lets the handler and the queue run until nothing is in hand and main is empty. Retry queues are not waited for. */
async function drain(queue: MemoryDeliveryQueue) {
  for (let i = 0; i < 500; i++) {
    await new Promise(resolve => setTimeout(resolve, 2))
    if (queue.unackedCount() === 0 && (await queue.depth()) === 0) return
  }
  throw new Error('the queue did not settle')
}

const transient = (reason = 'database busy') => new DeliveryError('transient', reason)
const permanent = (reason = 'the board has no column') => new DeliveryError('permanent', reason)

describe('the consumer: outcomes', () => {
  test('an opened issue is applied once, recorded as applied, and acked', async () => {
    const h = harness(() => 'done')
    await h.start()
    await h.publish('d-1', fixture('issues-opened'))
    await drain(h.queue)
    assert.deepEqual(h.calls, ['d-1:0'])
    assert.equal(h.applied.has('d-1'), true)
    assert.equal(h.queue.unackedCount(), 0)
    assert.equal(h.rows.stored.size, 0)
    assert.equal(h.queue.peek('retry30s').length + h.queue.peek('retry2m').length, 0)
    await h.stopNow()
  })

  test('a transient failure is retried after 30 s, and the second attempt succeeds', async () => {
    const h = harness((_job, call) => {
      if (call === 1) throw transient()
      return 'done'
    })
    await h.start()
    await h.publish('d-2', fixture('issues-opened'))
    await drain(h.queue)
    const waiting = h.queue.peek('retry30s')
    assert.equal(waiting.length, 1)
    assert.equal(waiting[0]!.attempt, 1)
    h.queue.advance(30_000)
    await drain(h.queue)
    assert.deepEqual(h.calls, ['d-2:0', 'd-2:1'])
    assert.equal(h.applied.has('d-2'), true)
    assert.equal(h.rows.stored.size, 0)
    await h.stopNow()
  })

  test('three transient failures end in the failed table and the failed queue, with the waits 30 s then 2 min', async () => {
    const h = harness(() => {
      throw transient('database busy')
    })
    await h.start()
    await h.publish('d-3', fixture('issues-opened'))
    await drain(h.queue)
    h.queue.advance(30_000)
    await drain(h.queue)
    assert.equal(h.queue.peek('retry2m').length, 1)
    assert.equal(h.queue.peek('retry2m')[0]!.attempt, 2)
    h.queue.advance(120_000)
    await drain(h.queue)
    assert.deepEqual(h.calls, ['d-3:0', 'd-3:1', 'd-3:2'])
    const row = h.rows.stored.get('d-3')!
    assert.equal(row.state, 'failed')
    assert.equal(row.attempts, MAX_ATTEMPTS)
    assert.equal(row.class, 'transient')
    assert.equal(row.reason, 'database busy')
    assert.notEqual(row.payload, null)
    assert.equal(h.queue.peek('failed').length, 1)
    assert.equal(h.applied.has('d-3'), false)
    await h.stopNow()
  })

  test('a permanent failure goes to the failed table and the failed queue at once', async () => {
    const h = harness(() => {
      throw permanent()
    })
    await h.start()
    await h.publish('d-4', fixture('issues-opened'))
    await drain(h.queue)
    assert.deepEqual(h.calls, ['d-4:0'])
    assert.equal(h.rows.stored.get('d-4')!.class, 'permanent')
    assert.equal(h.rows.stored.get('d-4')!.attempts, 1)
    assert.equal(h.queue.peek('failed').length, 1)
    assert.equal(h.queue.peek('retry30s').length, 0)
    await h.stopNow()
  })

  test('a poison body (not JSON) is permanent, never applied, and kept with its raw body for the PM', async () => {
    const h = harness(() => 'done')
    await h.start()
    await h.publish('d-5', 'not json {')
    await drain(h.queue)
    assert.deepEqual(h.calls, [])
    const row = h.rows.stored.get('d-5')!
    assert.equal(row.class, 'permanent')
    assert.equal(row.reason, 'the body is not JSON')
    assert.equal(row.payload, 'not json {')
    assert.equal(h.queue.peek('failed').length, 1)
    await h.stopNow()
  })

  test('the reason kept on a row is cut to 300 characters and carries no line breaks', async () => {
    const h = harness(() => {
      throw permanent(`${'x'.repeat(400)}\nmore`)
    })
    await h.start()
    await h.publish('d-13', fixture('issues-opened'))
    await drain(h.queue)
    const row = h.rows.stored.get('d-13')!
    assert.equal(row.reason!.length, FAILURE_REASON_MAX)
    assert.equal(row.reason!.includes('\n'), false)
    await h.stopNow()
  })

  test('any other error is transient, not permanent', async () => {
    const h = harness((_job, call) => {
      if (call === 1) throw new TypeError('a bug in the syncer')
      return 'done'
    })
    await h.start()
    await h.publish('d-14', fixture('issues-opened'))
    await drain(h.queue)
    assert.equal(h.queue.peek('retry30s').length, 1)
    assert.equal(h.queue.peek('failed').length, 0)
    await h.stopNow()
  })
})

describe('the consumer: database limits, holds and the broker count', () => {
  test('a database error while reading the ledger is a transient failure: retried, no row, no work lost', async () => {
    const h = harness(() => 'done')
    h.ledger.broken = true
    await h.start()
    await h.publish('d-db1', fixture('issues-opened'))
    await drain(h.queue)
    assert.deepEqual(h.calls, [])
    assert.equal(h.rows.stored.size, 0)
    assert.equal(h.queue.peek('retry30s').length, 1)
    assert.equal(h.queue.peek('failed').length, 0)
    await h.stopNow()
  })

  test('a hung database is cut by its limit: the delivery is retried, and the repository is not stuck', async () => {
    const h = harness(() => 'done', { dbLimitMs: 20, holdMaxAgeMs: 60_000 })
    h.ledger.hang = true
    await h.start()
    await h.publish('d-hang', fixture('issues-opened', 'example-owner/hang-test'))
    await drain(h.queue)
    assert.equal(h.queue.peek('retry30s').length, 1)
    h.ledger.hang = false
    h.queue.advance(30_000)
    await drain(h.queue)
    assert.equal(h.applied.has('d-hang'), true)
    assert.equal(h.rows.stored.size, 0)
    await h.stopNow()
  })

  test('a repository hold does not last past its maximum age, so a stuck retry cannot block the repository for good', async () => {
    const h = harness((job, call) => {
      if (job.deliveryId === 'd-hold-a' && call === 1) throw transient()
      return 'done'
    }, { holdMaxAgeMs: 10_000 })
    await h.start()
    await h.publish('d-hold-a', fixture('issues-opened', 'example-owner/hold-test'))
    await drain(h.queue)
    // The retry of a is held for 30 s, and b is put behind it. Past the maximum age, b is applied on its own.
    await h.publish('d-hold-b', fixture('issues-edited', 'example-owner/hold-test'))
    await drain(h.queue)
    assert.deepEqual(h.calls, ['d-hold-a:0'])
    h.queue.advance(11_000)
    await h.publish('d-hold-c', fixture('issues-edited', 'example-owner/hold-test'))
    await drain(h.queue)
    assert.equal(h.calls.includes('d-hold-c:0'), true)
    await h.stopNow()
  })

  test('the hold is cleared on every outcome: a permanent failure after a retry lets the repository move on', async () => {
    const h = harness((job, call) => {
      if (call === 1) throw transient()
      if (job.deliveryId === 'd-clear-a') throw permanent()
      return 'done'
    })
    await h.start()
    await h.publish('d-clear-a', fixture('issues-opened', 'example-owner/clear-test'))
    await drain(h.queue)
    h.queue.advance(30_000)
    await drain(h.queue)
    assert.equal(h.rows.stored.get('d-clear-a')!.class, 'permanent')
    await h.publish('d-clear-b', fixture('issues-edited', 'example-owner/clear-test'))
    await drain(h.queue)
    assert.equal(h.applied.has('d-clear-b'), true)
    await h.stopNow()
  })

  test('a failed write of the failure row is retried, never copied to failed without its row', async () => {
    const h = harness(() => {
      throw permanent()
    })
    h.rows.failNextWrite = true
    await h.start()
    await h.publish('d-w1', fixture('issues-opened'))
    await drain(h.queue)
    assert.equal(h.rows.stored.size, 0)
    assert.equal(h.queue.peek('failed').length, 0)
    assert.equal(h.queue.peek('retry30s').length, 1)
    h.queue.advance(30_000)
    await drain(h.queue)
    assert.equal(h.rows.stored.get('d-w1')!.class, 'permanent')
    assert.equal(h.queue.peek('failed').length, 1)
    await h.stopNow()
  })

  test('a delivery the broker has handed out nearly its limit times is recorded and failed without work', async () => {
    const h = harness(() => 'done')
    const body = Buffer.from(fixture('issues-opened'))
    const result = await h.consumer.handle({ deliveryId: 'd-limit', event: 'issues', attempt: 0, body, redelivered: true, deliveries: DELIVERY_LIMIT - 1 }, { signal: new AbortController().signal })
    assert.equal(typeof result === 'object' && 'fail' in result, true)
    assert.equal(h.calls.length, 0)
    assert.equal(h.rows.stored.get('d-limit')!.state, 'failed')
    assert.match(h.rows.stored.get('d-limit')!.reason!, /handed out/)
  })

  test('an oversize body is recorded through beforeFail, and copied at once', async () => {
    const recorded: string[] = []
    const oversize = await decide(() => 'ack', { deliveryId: 'd-ta', event: 'issues', attempt: 0, body: Buffer.alloc(32), redelivered: false, deliveries: 1 }, {
      timeoutMs: 1_000,
      maxBodyBytes: 16,
      beforeFail: async (_message, reason) => {
        recorded.push(reason)
      }
    }, () => {})
    assert.deepEqual(oversize, { fail: 'body over size cap' })
    assert.deepEqual(recorded, ['body over size cap'])
  })
  test('if the record of an adapter failure cannot be written, the delivery is retried, not copied', async () => {
    const h = harness(() => new Promise<void>(() => {}), {
      handlerTimeoutMs: 20,
      beforeFail: async () => {
        throw new Error('database write failed')
      }
    })
    await h.start()
    await h.queue.publish('main', { deliveryId: 'd-bf', event: 'issues', attempt: 2, body: Buffer.from(fixture('issues-opened'), 'utf8') })
    await drain(h.queue)
    assert.equal(h.queue.peek('failed').length, 0)
    assert.equal(h.queue.peek('retry2m').length, 1)
    await h.stopNow()
  })
  test('a hung apply past the work limit is retried, and idle waits for it to settle (no orphan is forgotten)', async () => {
    let release: () => void = () => {}
    const h = harness(() => new Promise<void>((resolve) => {
      release = resolve
    }), { workLimitMs: 20 })
    await h.start()
    await h.publish('d-orphan', fixture('issues-opened', 'example-owner/orphan-test'))
    await drain(h.queue)
    assert.equal(h.queue.peek('retry30s').length, 1)
    assert.equal(await h.consumer.idle(10), false)
    release()
    assert.equal(await h.consumer.idle(500), true)
    await h.stopNow()
  })
})

describe('the consumer: dedupe, ordering and shutdown', () => {
  test('the same delivery twice: applied once, the second is acked without work', async () => {
    const h = harness(() => 'done')
    await h.start()
    await h.publish('d-dup', fixture('issues-opened'))
    await drain(h.queue)
    await h.publish('d-dup', fixture('issues-opened'))
    await drain(h.queue)
    assert.deepEqual(h.calls, ['d-dup:0'])
    assert.equal(h.queue.unackedCount(), 0)
    await h.stopNow()
  })

  test('an edited delivery waiting behind an opened one that is retrying is not applied before it', async () => {
    const h = harness((job, call) => {
      if (job.deliveryId === 'd-order-a' && call === 1) throw transient()
      return 'done'
    })
    await h.publish('d-order-a', fixture('issues-opened', 'example-owner/order-test'))
    await h.publish('d-order-b', fixture('issues-edited', 'example-owner/order-test'))
    await h.start()
    await drain(h.queue)
    assert.deepEqual(h.calls, ['d-order-a:0'])
    h.queue.advance(30_000)
    await drain(h.queue)
    assert.deepEqual(h.calls, ['d-order-a:0', 'd-order-a:1', 'd-order-b:0'])
    assert.equal(h.applied.has('d-order-b'), true)
    await h.stopNow()
  })

  test('shutdown during work requeues the unfinished delivery with its attempt count unchanged', async () => {
    let release: () => void = () => {}
    const h = harness(() => new Promise<void>((resolve) => {
      release = resolve
    }), { workLimitMs: 60_000 })
    await h.start()
    await h.publish('d-shut', fixture('issues-opened'))
    while (h.calls.length === 0) await new Promise(resolve => setImmediate(resolve))
    assert.equal(await h.consumer.idle(10), false)
    await h.stopNow()
    const main = h.queue.peek('main')
    assert.equal(main.length, 1)
    assert.equal(main[0]!.attempt, 0)
    assert.equal(main[0]!.redelivered, true)
    release()
    await h.queue.close()
  })

  test('idle reports true once nothing is in hand', async () => {
    const h = harness(() => 'done')
    await h.start()
    await h.publish('d-idle', fixture('issues-opened'))
    await drain(h.queue)
    assert.equal(await h.consumer.idle(10), true)
    await h.stopNow()
  })
})

describe('the consumer: crash windows (the redelivery ends in the same place)', () => {
  test('crash after the success is recorded and before the ack: the redelivery is acked without work', async () => {
    const h = harness(() => 'done')
    await h.start()
    h.queue.crashAfter('ack')
    await h.publish('d-c1', fixture('issues-opened'))
    await drain(h.queue).catch(() => {})
    await h.stopNow()
    await h.start()
    await drain(h.queue)
    assert.deepEqual(h.calls, ['d-c1:0'])
    assert.equal(h.applied.has('d-c1'), true)
    assert.equal(h.queue.unackedCount(), 0)
    await h.stopNow()
  })

  test('crash after the retry is published and before the ack: the original runs again (known at-least-once window)', async () => {
    const h = harness((_job, call) => {
      if (call === 1) throw transient()
      return 'done'
    })
    await h.start()
    h.queue.crashAfter('ack')
    await h.publish('d-c2', fixture('issues-opened'))
    await drain(h.queue).catch(() => {})
    await h.stopNow()
    await h.start()
    await drain(h.queue)
    // The redelivered original (attempt 0) ran a second time and succeeded; the retry copy is then acked without work.
    assert.deepEqual(h.calls, ['d-c2:0', 'd-c2:0'])
    assert.equal(h.applied.has('d-c2'), true)
    assert.equal(h.rows.stored.size, 0)
    await h.stopNow()
  })

  test('crash after the failure row is written and before the failed copy: the redelivery completes the failed step once', async () => {
    const h = harness(() => {
      throw permanent()
    })
    h.rows.afterUpsert = () => {
      h.rows.afterUpsert = null
      h.queue.dropConnection()
    }
    await h.start()
    await h.publish('d-c3', fixture('issues-opened'))
    await drain(h.queue).catch(() => {})
    assert.equal(h.queue.peek('failed').length, 0)
    await h.start()
    await drain(h.queue)
    assert.deepEqual(h.calls, ['d-c3:0'])
    assert.equal(h.rows.stored.size, 1)
    assert.equal(h.queue.peek('failed').length, 1)
    await h.stopNow()
  })

  test('crash after the failed copy and before the ack: one row; the failed queue may hold a second copy (known)', async () => {
    const h = harness(() => {
      throw permanent()
    })
    await h.start()
    h.queue.crashAfter('ack')
    await h.publish('d-c4', fixture('issues-opened'))
    await drain(h.queue).catch(() => {})
    await h.stopNow()
    await h.start()
    await drain(h.queue)
    assert.equal(h.rows.stored.size, 1)
    assert.equal(h.rows.stored.get('d-c4')!.state, 'failed')
    assert.equal(h.queue.peek('failed').length, 2)
    await h.stopNow()
  })
})

describe('the consumer: given-up attempts, late answers and busy repositories', () => {
  /** Waits in real time until the condition holds (the timers of the limits are real), or fails. */
  async function waitFor(condition: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 200; i++) {
      if (condition()) return
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error(`timed out waiting for ${what}`)
  }

  test('an adapter timeout takes the retry ladder: retried on attempt 1, and the same ladder to the third attempt', async () => {
    const h = harness(() => new Promise<void>(() => {}), { handlerTimeoutMs: 20, holdMaxAgeMs: 1_000 })
    await h.start()
    await h.publish('d-tb', fixture('issues-opened', 'example-owner/timeout-test'))
    await drain(h.queue)
    assert.equal(h.rows.stored.size, 0, 'the first timeout is not a failure')
    assert.equal(h.queue.peek('failed').length, 0)
    assert.equal(h.queue.peek('retry30s').length, 1)
    assert.equal(h.queue.peek('retry30s')[0]!.attempt, 1)
    // The orphan keeps running. Later attempts wait behind it until it is older than the hold age, then they count.
    for (let i = 0; i < 20 && !h.rows.stored.has('d-tb'); i++) {
      h.queue.advance(30_000)
      await drain(h.queue)
    }
    assert.equal(h.calls.filter(call => call.startsWith('d-tb')).length, 1, 'the orphan is never overlapped')
    assert.equal(h.rows.stored.get('d-tb')!.state, 'failed')
    assert.equal(h.rows.stored.get('d-tb')!.attempts, 3)
    assert.equal(h.queue.peek('failed').length, 1)
    await h.stopNow()
  })

  test('a late success after its attempt was given up is discarded while a retry copy runs the work again', async () => {
    let finish: (value: unknown) => void = () => {}
    const h = harness((_job, call) => {
      if (call !== 1) return 'done'
      return new Promise((resolve) => {
        finish = resolve
      })
    }, { handlerTimeoutMs: 30 })
    await h.start()
    await h.publish('d-late-a', fixture('issues-opened', 'example-owner/late-a'))
    await drain(h.queue)
    assert.equal(h.queue.peek('retry30s').length, 1)
    finish('done')
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(h.applied.has('d-late-a'), false, 'no success row from the late answer')
    assert.equal(h.rows.stored.size, 0)
    h.queue.advance(30_000)
    await drain(h.queue)
    assert.deepEqual(h.calls, ['d-late-a:0', 'd-late-a:1'])
    assert.equal(h.applied.has('d-late-a'), true)
    await h.stopNow()
  })

  test('a late success after the last attempt was given up is recorded, and its failed row goes to resolved', async () => {
    let finish: (value: unknown) => void = () => {}
    const h = harness(() => new Promise((resolve) => {
      finish = resolve
    }), { handlerTimeoutMs: 30 })
    await h.start()
    await h.queue.publish('main', { deliveryId: 'd-late-b', event: 'issues', attempt: 2, body: Buffer.from(fixture('issues-opened'), 'utf8') })
    await drain(h.queue)
    assert.equal(h.rows.stored.get('d-late-b')!.state, 'failed')
    assert.equal(h.queue.peek('failed').length, 1)
    finish('done')
    await waitFor(() => h.applied.has('d-late-b'), 'the late success')
    assert.equal(h.rows.stored.get('d-late-b')!.state, 'resolved')
    assert.equal(h.queue.peek('retry30s').length + h.queue.peek('retry2m').length, 0)
    await h.stopNow()
  })

  test('a late failure after its attempt was given up is discarded: no row, and no hold on the repository', async () => {
    let fail: (reason: unknown) => void = () => {}
    const h = harness((_job, call) => {
      if (call !== 1) return 'done'
      return new Promise((_resolve, reject) => {
        fail = reject
      })
    }, { handlerTimeoutMs: 30 })
    await h.start()
    await h.publish('d-late-c', fixture('issues-opened', 'example-owner/late-c'))
    await drain(h.queue)
    fail(permanent('late'))
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(h.rows.stored.size, 0)
    await h.publish('d-late-d', fixture('issues-edited', 'example-owner/late-c'))
    await drain(h.queue)
    assert.equal(h.applied.has('d-late-d'), true, 'applied at once: nothing holds the repository')
    await h.stopNow()
  })

  test('a delivery whose repository still has an apply running is waited in the 30 s queue, with no attempt used', async () => {
    const h = harness((_job, call) => (call === 1 ? new Promise(() => {}) : 'done'), { handlerTimeoutMs: 30 })
    await h.start()
    await h.publish('d-busy-a', fixture('issues-opened', 'example-owner/busy-test'))
    await drain(h.queue)
    await h.publish('d-busy-b', fixture('issues-edited', 'example-owner/busy-test'))
    await drain(h.queue)
    const waiting = h.queue.peek('retry30s').map(message => [message.deliveryId, message.attempt])
    assert.deepEqual(waiting, [['d-busy-a', 1], ['d-busy-b', 0]])
    assert.equal(h.calls.includes('d-busy-b:0'), false)
    await h.stopNow()
  })

  test('a failed copy whose publish is not confirmed is requeued: one row, and the redelivery copies it again without a second run', async () => {
    const h = harness(() => {
      throw permanent()
    })
    await h.start()
    h.queue.failNextFailedCopy()
    await h.publish('d-fc', fixture('issues-opened'))
    await drain(h.queue)
    assert.equal(h.rows.stored.size, 1)
    assert.equal(h.rows.stored.get('d-fc')!.state, 'failed')
    assert.equal(h.queue.peek('failed').length, 1)
    assert.deepEqual(h.calls, ['d-fc:0'])
    assert.equal(h.queue.unackedCount(), 0)
    await h.stopNow()
  })

  test('a retry the broker did not take gives its count back and leaves the row failed', async () => {
    const rows = fakeRows()
    rows.stored.set('d-rc', {
      deliveryId: 'd-rc', event: 'issues', owner: null, repo: null, repoId: null, attempts: 3, class: 'transient', reason: 'x',
      payload: '{}', firstSeenAt: 1, failedAt: 2, state: 'failed', retriedCount: 0, handledBy: null, handledAt: null, handledReason: null
    })
    const queue = { publish: async () => {
      throw new Error('not confirmed')
    } } as unknown as DeliveryQueue
    await assert.rejects(retryFailedDelivery('d-rc', 'pm', { rows, queue: () => queue }))
    assert.equal(rows.stored.get('d-rc')!.state, 'failed')
    assert.equal(rows.stored.get('d-rc')!.retriedCount, 0)
  })
})
describe('the PM functions', () => {
  function seededRows(failedAt = 2) {
    const rows = fakeRows()
    rows.stored.set('d-pm', {
      deliveryId: 'd-pm',
      event: 'issues',
      owner: 'example-owner',
      repo: 'consumer-test',
      repoId: 7,
      attempts: 3,
      class: 'transient',
      reason: 'database busy',
      payload: '{"action":"opened"}',
      firstSeenAt: 1,
      failedAt,
      state: 'failed',
      retriedCount: 0,
      handledBy: null,
      handledAt: null,
      handledReason: null
    })
    return rows
  }

  function fakeQueue() {
    const published: Array<{ queue: string, deliveryId: string, attempt: number, body: string }> = []
    let failNext = false
    const queue = {
      async publish(name: string, message: { deliveryId: string, attempt: number, body: Buffer }) {
        if (failNext) {
          failNext = false
          throw new Error('publish not confirmed')
        }
        published.push({ queue: name, deliveryId: message.deliveryId, attempt: message.attempt, body: message.body.toString('utf8') })
      }
    }
    return { published, queue: queue as unknown as DeliveryQueue, failNext: () => {
      failNext = true
    } }
  }

  test('a retry republishes the stored payload as a fresh attempt 0 to main, once', async () => {
    const rows = seededRows()
    const q = fakeQueue()
    const deps = { rows, queue: () => q.queue, now: () => 100 }
    const first = await retryFailedDelivery('d-pm', 'pm-key', deps)
    const second = await retryFailedDelivery('d-pm', 'pm-key', deps)
    assert.deepEqual(first, { ok: true, takeover: false })
    assert.deepEqual(second, { ok: false, reason: 'already retried' })
    assert.equal(q.published.length, 1)
    assert.deepEqual(q.published[0], { queue: 'main', deliveryId: 'd-pm', attempt: 0, body: '{"action":"opened"}' })
    assert.equal(rows.stored.get('d-pm')!.state, 'retried')
    assert.equal(rows.stored.get('d-pm')!.handledBy, 'pm-key')
  })

  test('a retry whose publish is not confirmed puts the row back to failed and throws', async () => {
    const rows = seededRows()
    const q = fakeQueue()
    q.failNext()
    await assert.rejects(retryFailedDelivery('d-pm', 'pm-key', { rows, queue: () => q.queue }))
    assert.equal(rows.stored.get('d-pm')!.state, 'failed')
    assert.equal(q.published.length, 0)
  })

  test('a retry of a row whose payload has expired is refused', async () => {
    const rows = seededRows()
    rows.stored.get('d-pm')!.payload = null
    const q = fakeQueue()
    assert.deepEqual(await retryFailedDelivery('d-pm', 'pm-key', { rows, queue: () => q.queue }), { ok: false, reason: 'payload expired' })
    assert.equal(q.published.length, 0)
  })

  test('discard works once on a failed row, with the reason', async () => {
    const rows = seededRows()
    assert.equal(await discardFailedDelivery('d-pm', 'pm-key', 'a duplicate of an older failure', { rows }), true)
    assert.equal(await discardFailedDelivery('d-pm', 'pm-key', 'again', { rows }), false)
    assert.equal(rows.stored.get('d-pm')!.state, 'discarded')
    assert.equal(rows.stored.get('d-pm')!.handledReason, 'a duplicate of an older failure')
  })

  test('the list, the single view and the count never return the payload', async () => {
    const rows = seededRows()
    const listed = await listFailedDeliveries(10, { rows })
    assert.equal(listed.length, 1)
    assert.equal(listed[0]!.hasPayload, true)
    assert.equal('payload' in listed[0]!, false)
    const one = await getFailedDelivery('d-pm', { rows })
    assert.equal(one !== null && 'payload' in one, false)
    assert.equal(await failedCount({ rows }), 1)
    assert.equal(await getFailedDelivery('missing', { rows }), null)
  })

  test('the full cycle: fail, PM retry, fail again, PM retry, success: the PM history survives and the row ends resolved', async () => {
    const h = harness((_job, call) => {
      if (call <= 2) throw permanent()
      return 'done'
    })
    await h.start()
    await h.publish('d-cycle', fixture('issues-opened'))
    await drain(h.queue)
    assert.equal(h.rows.stored.get('d-cycle')!.state, 'failed')
    const first = await retryFailedDelivery('d-cycle', 'pm-one', { rows: h.rows, queue: () => h.queue as unknown as DeliveryQueue })
    assert.deepEqual(first, { ok: true, takeover: false })
    await drain(h.queue)
    const failedAgain = h.rows.stored.get('d-cycle')!
    assert.equal(failedAgain.state, 'failed')
    assert.equal(failedAgain.handledBy, 'pm-one')
    assert.equal(failedAgain.retriedCount, 1)
    const second = await retryFailedDelivery('d-cycle', 'pm-two', { rows: h.rows, queue: () => h.queue as unknown as DeliveryQueue })
    assert.deepEqual(second, { ok: true, takeover: false })
    await drain(h.queue)
    const done = h.rows.stored.get('d-cycle')!
    assert.equal(done.state, 'resolved')
    assert.equal(done.retriedCount, 2)
    assert.equal(done.handledBy, 'pm-two')
    assert.equal(h.applied.has('d-cycle'), true)
    await h.stopNow()
  })

  test('the janitor clears the payload only when the later of failed_at and handled_at is over 30 days, for every state', async () => {
    const rows = fakeRows()
    const now = 100 * DAY
    const base = (id: string, state: FailureState, failedAt: number, handledAt: number | null): void => {
      rows.stored.set(id, {
        deliveryId: id, event: 'issues', owner: 'o', repo: 'r', repoId: 1, attempts: 3, class: 'transient', reason: 'x',
        payload: 'body', firstSeenAt: 1, failedAt, state, retriedCount: 0, handledBy: handledAt ? 'pm' : null, handledAt, handledReason: null
      })
    }
    base('unhandled-old', 'failed', now - 31 * DAY, null)
    base('unhandled-new', 'failed', now - 29 * DAY, null)
    base('handled-recently', 'discarded', now - 60 * DAY, now - 1 * DAY)
    base('handled-old', 'discarded', now - 60 * DAY, now - 31 * DAY)
    base('retried-handled-recent', 'retried', now - 40 * DAY, now - 10 * DAY)
    base('resolved-old', 'resolved', now - 40 * DAY, now - 35 * DAY)
    assert.equal(await purgeDeliveryPayloads({ rows, now: () => now }), 3)
    const kept = ['unhandled-new', 'handled-recently', 'retried-handled-recent']
    for (const id of kept) assert.equal(rows.stored.get(id)!.payload, 'body', id)
    for (const id of ['unhandled-old', 'handled-old', 'resolved-old']) assert.equal(rows.stored.get(id)!.payload, null, id)
    assert.equal(rows.stored.get('unhandled-old')!.failedAt, now - 31 * DAY)
  })

  test('an expired failed row shows as payload expired and cannot be retried; its metadata stays', async () => {
    const rows = seededRows(1)
    const q = fakeQueue()
    await purgeDeliveryPayloads({ rows, now: () => 1 + 31 * DAY })
    const listed = await listFailedDeliveries(10, { rows })
    assert.equal(listed[0]!.hasPayload, false)
    assert.equal(listed[0]!.reason, 'database busy')
    assert.deepEqual(await retryFailedDelivery('d-pm', 'pm-key', { rows, queue: () => q.queue }), { ok: false, reason: 'payload expired' })
  })
})

describe('the webhook route and the queue', () => {
  const SECRET = 'consumer-test-secret'

  function routeEvent(headers: Record<string, string>, chunks: (Buffer | string)[]): H3Event {
    const req: any = Readable.from(chunks)
    req.headers = headers
    req.method = 'POST'
    req.url = '/api/github/webhook'
    const sent: Record<string, string> = {}
    const res = {
      statusCode: 200,
      setHeader: (name: string, value: string) => {
        sent[name.toLowerCase()] = value
      },
      sent
    }
    return { method: 'POST', context: {}, node: { req, res } } as unknown as H3Event
  }

  function signed(body: string): string {
    return `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`
  }

  async function refusal(promise: Promise<unknown>): Promise<number | undefined> {
    try {
      await promise
    } catch (error: any) {
      return error.statusCode
    }
    return undefined
  }

  /** Runs with the in-memory queue (NODE_ENV test, no broker) and the webhook secret set. */
  async function withRoute(nodeEnv: string, run: () => Promise<void>) {
    const saved = { env: process.env.NODE_ENV, url: process.env.RABBITMQ_URL, secret: process.env.GITHUB_WEBHOOK_SECRET }
    process.env.NODE_ENV = nodeEnv
    delete process.env.RABBITMQ_URL
    process.env.GITHUB_WEBHOOK_SECRET = SECRET
    await closeDeliveryQueue()
    try {
      await run()
    } finally {
      await closeDeliveryQueue()
      if (saved.env === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = saved.env
      if (saved.url !== undefined) process.env.RABBITMQ_URL = saved.url
      if (saved.secret === undefined) delete process.env.GITHUB_WEBHOOK_SECRET
      else process.env.GITHUB_WEBHOOK_SECRET = saved.secret
    }
  }

  test('a wrong signature is refused with 401 before anything is queued', async () => {
    await withRoute('test', async () => {
      const body = fixture('issues-opened', 'example-owner/route-401')
      const event = routeEvent({ 'x-hub-signature-256': 'sha256=00', 'x-github-event': 'issues', 'x-github-delivery': 'd-401' }, [body])
      assert.equal(await refusal((webhook as any)(event)), 401)
      assert.equal((getDeliveryQueue() as MemoryDeliveryQueue).peek('main').length, 0)
    })
  })

  test('a body the queue will not take is answered 413, and nothing is queued', async () => {
    await withRoute('test', async () => {
      const queue = getDeliveryQueue() as MemoryDeliveryQueue
      queue.setMaxBodyBytes(16)
      const body = fixture('issues-opened', 'example-owner/route-413')
      const event = routeEvent({ 'x-hub-signature-256': signed(body), 'x-github-event': 'issues', 'x-github-delivery': 'd-413' }, [body])
      assert.equal(await refusal((webhook as any)(event)), 413)
      assert.equal(queue.peek('main').length, 0)
    })
  })

  test('the queue refusing the publish is answered 503', async () => {
    await withRoute('test', async () => {
      const queue = getDeliveryQueue() as MemoryDeliveryQueue
      queue.crashAfter('publish')
      const body = fixture('issues-opened', 'example-owner/route-503')
      const event = routeEvent({ 'x-hub-signature-256': signed(body), 'x-github-event': 'issues', 'x-github-delivery': 'd-503b' }, [body])
      assert.equal(await refusal((webhook as any)(event)), 503)
    })
  })

  test('a delivery id that is not a plain id of at most 100 characters is refused with 400', async () => {
    await withRoute('test', async () => {
      const body = fixture('issues-opened', 'example-owner/route-400')
      for (const id of ['x'.repeat(101), 'bad id', 'a/b']) {
        const event = routeEvent({ 'x-hub-signature-256': signed(body), 'x-github-event': 'issues', 'x-github-delivery': id }, [body])
        assert.equal(await refusal((webhook as any)(event)), 400, id)
      }
      assert.equal((getDeliveryQueue() as MemoryDeliveryQueue).peek('main').length, 0)
    })
  })
})

describe('the consumer: stuck claims, the card syncer abort, and the busy bound', () => {
  /** Waits in real time until the condition holds, or fails. */
  async function waitFor(condition: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 200; i++) {
      if (condition()) return
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error(`timed out waiting for ${what}`)
  }

  function seed(rows: ReturnType<typeof fakeRows>, id: string): void {
    rows.stored.set(id, {
      deliveryId: id, event: 'issues', owner: 'o', repo: 'r', repoId: 1, attempts: 3, class: 'transient', reason: 'x',
      payload: '{"action":"opened"}', firstSeenAt: 1, failedAt: 2, state: 'failed', retriedCount: 0, handledBy: null, handledAt: null, handledReason: null
    })
  }

  test('a claim whose republish crashed: the PM can discard the row once the claim has expired, not before', async () => {
    const rows = fakeRows()
    seed(rows, 'd-stuck')
    const t0 = 1_000
    // The PM's claim, then the process dies before the republish: nothing is in flight.
    assert.equal((await rows.claimForRetry('d-stuck', 'pm-1', t0)).ok, true)
    assert.equal(await discardFailedDelivery('d-stuck', 'pm-2', 'gone', { rows, now: () => t0 + 5 * 60_000 }), false)
    assert.equal(await discardFailedDelivery('d-stuck', 'pm-2', 'gone', { rows, now: () => t0 + RETRY_CLAIM_MS + 1 }), true)
    assert.equal(rows.stored.get('d-stuck')!.state, 'discarded')
    assert.equal(rows.stored.get('d-stuck')!.handledBy, 'pm-2')
  })

  test('a double retry inside the window runs once; after the window a retry takes the expired claim over', async () => {
    const rows = fakeRows()
    seed(rows, 'd-twice')
    const published: string[] = []
    const queue = { publish: async (_name: string, message: { deliveryId: string }) => {
      published.push(message.deliveryId)
    } } as unknown as DeliveryQueue
    const t0 = 5_000
    const first = await retryFailedDelivery('d-twice', 'pm-1', { rows, queue: () => queue, now: () => t0 })
    const double = await retryFailedDelivery('d-twice', 'pm-2', { rows, queue: () => queue, now: () => t0 + 1_000 })
    assert.deepEqual(first, { ok: true, takeover: false })
    assert.deepEqual(double, { ok: false, reason: 'already retried' })
    assert.deepEqual(published, ['d-twice'])
    const later = await retryFailedDelivery('d-twice', 'pm-3', { rows, queue: () => queue, now: () => t0 + RETRY_CLAIM_MS + 1 })
    assert.deepEqual(later, { ok: true, takeover: true })
    assert.deepEqual(published, ['d-twice', 'd-twice'])
    assert.equal(rows.stored.get('d-twice')!.retriedCount, 2)
    assert.equal(rows.stored.get('d-twice')!.handledBy, 'pm-3')
  })

  test('the retry count is given back once: a second give-back matches nothing and cannot go below the real count', async () => {
    const rows = fakeRows()
    seed(rows, 'd-count')
    await rows.claimForRetry('d-count', 'pm', 1)
    await rows.releaseRetry('d-count')
    await rows.releaseRetry('d-count')
    assert.equal(rows.stored.get('d-count')!.retriedCount, 0)
    assert.equal(rows.stored.get('d-count')!.state, 'failed')
  })

  test('an abort stops the card syncer at its next store call: the hung call is left behind and no later step runs', async () => {
    const calls: string[] = []
    const repoRow = {
      id: 'p1', projectId: 'proj-1', owner: 'example-owner', repo: 'consumer-test', syncEnabled: true, syncColumn: 'Backlog',
      syncVisibility: 'internal', acceptedLogins: ['example-owner'], completeOnClose: false
    }
    const store = {
      async linkedRepos() {
        calls.push('linkedRepos')
        return [repoRow]
      },
      async recordIgnored() {
        calls.push('recordIgnored')
      },
      issueCard() {
        calls.push('issueCard')
        return new Promise(() => {})
      },
      async resolveColumn() {
        calls.push('resolveColumn')
        return null
      },
      async createIssueCard() {
        calls.push('createIssueCard')
        throw new Error('not reached')
      },
      async updateCard() {
        calls.push('updateCard')
      },
      async hasUpdate() {
        calls.push('hasUpdate')
        return false
      },
      async addUpdate() {
        calls.push('addUpdate')
      }
    } as unknown as GithubCardStore
    const ac = new AbortController()
    const job: DeliveryJob = {
      deliveryId: 'd-abort', event: 'issues', repoOwner: 'example-owner', repoName: 'consumer-test', repoId: 1,
      payload: JSON.parse(fixture('issues-opened', 'example-owner/consumer-test')), receivedAt: 1, firstSeenAt: 1, attempt: 0
    }
    const run = processGithubDelivery(job, { store, signal: ac.signal, markerKey: 'test-marker-key', echoCommentIds: new Set() })
    await waitFor(() => calls.includes('issueCard'), 'the second store call')
    ac.abort()
    await assert.rejects(run, (error: Error) => error instanceof DeliveryAborted && error.name === 'AbortError')
    assert.deepEqual(calls, ['linkedRepos', 'issueCard'])
  })

  test('a delivery deferred behind a hung orphan takes an attempt after MAX_BUSY_DEFERRALS deferrals: the repository is not starved', async () => {
    const h = harness((job, call) => (job.deliveryId === 'd-orphan' && call === 1 ? new Promise(() => {}) : 'done'), {
      handlerTimeoutMs: 30,
      holdMaxAgeMs: 1e9
    })
    await h.start()
    await h.publish('d-orphan', fixture('issues-opened', 'example-owner/bound-test'))
    await drain(h.queue)
    await h.publish('d-bound', fixture('issues-edited', 'example-owner/bound-test'))
    await drain(h.queue)
    for (let i = 0; i < MAX_BUSY_DEFERRALS + 2; i++) {
      h.queue.advance(30_000)
      await drain(h.queue)
    }
    const waiting = [...h.queue.peek('retry30s'), ...h.queue.peek('retry2m')].find(message => message.deliveryId === 'd-bound')
    assert.ok(waiting, 'd-bound waits for a retry')
    assert.equal(waiting.attempt, 1, 'it took an attempt once the deferrals ran out')
    assert.equal(h.calls.includes('d-bound:0'), false, 'and the orphan was never overlapped')
    await h.stopNow()
  })
})
after(async () => {
  await closeDeliveryQueue()
  await db.$client.end({ timeout: 1 })
})
