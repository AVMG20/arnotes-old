// The database record of GitHub deliveries that gave up. The consumer writes a row here BEFORE it copies the
// delivery to the failed queue, so the row is the record the PM works from; the failed queue is only a
// safety net and nothing here reads it. The PM's functions (list, retry, discard) and the janitor live here
// too. Every change to a row is guarded by its state, so a double call does one thing. The row keeps the latest PM
// action (handled_by, handled_at, handled_reason) and the retry count; the full trail (every action, its actor and
// time) is the agent audit written by the GH6c tools. There is no history column, by decision.
import { and, eq, inArray, isNotNull, lt, or, sql } from 'drizzle-orm'
import { db } from '../db'
import { githubDeliveryFailures } from '../db/schema'
import { getDeliveryQueue } from './githubDeliveryQueue'
import type { DeliveryQueue } from './githubDeliveryQueueTypes'

/** The reason kept on a row: one line, cut to 300, and never payload text (the callers pass class and reason only). */
export const FAILURE_REASON_MAX = 300
/**
 * The customer's answer (GH6, Q2 and Q3): failed deliveries are kept 30 days, then the stored payload is removed and only the metadata stays. Read here as the later of failed_at and handled_at.
 * A row whose payload is gone shows as 'payload expired' and cannot be retried; its metadata stays.
 */
export const PAYLOAD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
/** The janitor clears payloads this many rows per statement, so one pass never holds a long lock. */
export const JANITOR_BATCH = 500

/** A retried row whose claim is older than this can be claimed again or discarded: the republish crashed or never concluded. */
export const RETRY_CLAIM_MS = 10 * 60 * 1000

const cutTo = (text: string): string => text.replace(/[\r\n\t]+/g, ' ')

export type FailureClass = 'transient' | 'permanent'
/**
 * failed: waiting for the PM. retried: sent again by the PM and not yet settled. resolved: sent again and applied.
 * discarded: the PM dropped it with a reason.
 */
export type FailureState = 'failed' | 'retried' | 'discarded' | 'resolved'

/** A row as the PM sees it. Never the payload itself: hasPayload false means the payload expired. */
export interface FailureRow {
  deliveryId: string
  event: string
  owner: string | null
  repo: string | null
  repoId: number | null
  attempts: number
  class: FailureClass
  reason: string | null
  hasPayload: boolean
  firstSeenAt: number
  failedAt: number
  state: FailureState
  retriedCount: number
  handledBy: string | null
  handledAt: number | null
  handledReason: string | null
}

/** What the consumer records when a delivery gives up. */
export interface NewFailure {
  deliveryId: string
  event: string
  owner: string | null
  repo: string | null
  repoId: number | null
  attempts: number
  class: FailureClass
  reason: string
  /** The raw body as received, decoded as UTF-8 text (exact for the JSON the webhook accepts). Capped by the queue (2 MB). */
  payload: string
  firstSeenAt: number
  failedAt: number
}

export type ClaimFailure = 'missing' | 'not failed' | 'already retried' | 'payload expired'
export type ClaimResult = { ok: true, event: string, payload: string, takeover: boolean } | { ok: false, reason: ClaimFailure }
export type RetryOutcome = { ok: true, takeover: boolean } | { ok: false, reason: ClaimFailure }

/** The rows of failed deliveries. The consumer and the PM both use this; tests use a fake with the same semantics. */
export interface FailureRows {
  find(deliveryId: string): Promise<(FailureRow & { payload: string | null }) | null>
  /**
   * Writes the row for a delivery that gave up. A new delivery gets a row in state failed. An existing row is
   * replaced only when it is retried (the PM sent it again and it failed again). Its handling history stays.
   * Failed, resolved and discarded rows are left alone, so a redelivered original never changes what the PM did.
   */
  upsertFailed(row: NewFailure): Promise<void>
  /** Moves a failed row with a stored payload to retried and counts the retry, in one conditional update. */
  claimForRetry(deliveryId: string, actor: string, at: number): Promise<ClaimResult>
  /** Puts a retried row back to failed, when the republish did not reach the broker. */
  releaseRetry(deliveryId: string): Promise<void>
  /** A failed or retried row whose delivery was applied (a late success counts): state resolved. False when there is none. */
  markResolved(deliveryId: string): Promise<boolean>
  /** Moves a failed row to discarded with the reason. False when the row is not failed. */
  setDiscarded(deliveryId: string, actor: string, reason: string, at: number): Promise<boolean>
  list(limit: number): Promise<FailureRow[]>
  count(): Promise<number>
  /** Clears the payloads past their retention, in batches. Returns how many rows lost one. */
  stripPayloads(now: number): Promise<number>
}

function metadataOf(row: Omit<FailureRow, 'class' | 'state'> & { class: string, state: string }): FailureRow {
  return {
    deliveryId: row.deliveryId,
    event: row.event,
    owner: row.owner,
    repo: row.repo,
    repoId: row.repoId,
    attempts: row.attempts,
    class: row.class as FailureClass,
    reason: row.reason,
    hasPayload: row.hasPayload,
    firstSeenAt: row.firstSeenAt,
    failedAt: row.failedAt,
    state: row.state as FailureState,
    retriedCount: row.retriedCount,
    handledBy: row.handledBy,
    handledAt: row.handledAt,
    handledReason: row.handledReason
  }
}

/** Drizzle implementation of FailureRows, for the app's database handle. */
export function makeFailureRows(database: typeof db): FailureRows {
  const table = githubDeliveryFailures
  const columns = {
    deliveryId: table.deliveryId,
    event: table.event,
    owner: table.owner,
    repo: table.repo,
    repoId: table.repoId,
    attempts: table.attempts,
    class: table.class,
    reason: table.reason,
    firstSeenAt: table.firstSeenAt,
    failedAt: table.failedAt,
    state: table.state,
    retriedCount: table.retriedCount,
    handledBy: table.handledBy,
    handledAt: table.handledAt,
    handledReason: table.handledReason,
    hasPayload: sql<boolean>`${table.payload} is not null`
  }

  return {
    async find(deliveryId) {
      const [row] = await database.select({ ...columns, payload: table.payload })
        .from(table)
        .where(eq(table.deliveryId, deliveryId))
        .limit(1)
      return row ? { ...metadataOf(row), payload: row.payload } : null
    },

    async upsertFailed(row) {
      await database.insert(table).values({
        id: row.deliveryId,
        deliveryId: row.deliveryId,
        event: row.event,
        owner: row.owner,
        repo: row.repo,
        repoId: row.repoId,
        attempts: row.attempts,
        class: row.class,
        reason: cutTo(row.reason).slice(0, FAILURE_REASON_MAX),
        payload: row.payload,
        firstSeenAt: row.firstSeenAt,
        failedAt: row.failedAt,
        state: 'failed'
      }).onConflictDoUpdate({
        target: table.deliveryId,
        set: {
          attempts: row.attempts,
          class: row.class,
          reason: cutTo(row.reason).slice(0, FAILURE_REASON_MAX),
          payload: row.payload,
          failedAt: row.failedAt,
          state: 'failed'
        },
        where: eq(table.state, 'retried')
      })
    },

    async claimForRetry(deliveryId, actor, at) {
      // A failed row, or a retried row whose claim has expired (the republish crashed or never concluded). The state
      // guard is in this one UPDATE's WHERE, so a second call inside the window matches nothing and runs nothing.
      const claimExpired = and(eq(table.state, 'retried'), lt(table.handledAt, at - RETRY_CLAIM_MS))
      const [claimed] = await database.update(table)
        .set({
          state: 'retried',
          retriedCount: sql`${table.retriedCount} + 1`,
          handledBy: actor,
          handledAt: at,
          // The old state is read in the SET: an expired claim is marked, so the result can say so.
          handledReason: sql`case when ${table.state} = 'retried' then 'claim expired' else null end`
        })
        .where(and(eq(table.deliveryId, deliveryId), or(eq(table.state, 'failed'), claimExpired), isNotNull(table.payload)))
        .returning({ event: table.event, payload: table.payload, handledReason: table.handledReason })
      if (claimed?.payload) {
        return { ok: true, event: claimed.event, payload: claimed.payload, takeover: claimed.handledReason === 'claim expired' }
      }
      // Nothing changed: say why.
      const [row] = await database.select({ state: table.state, payload: table.payload })
        .from(table)
        .where(eq(table.deliveryId, deliveryId))
        .limit(1)
      if (!row) return { ok: false, reason: 'missing' }
      if (row.state === 'retried') return { ok: false, reason: 'already retried' }
      if (row.state !== 'failed') return { ok: false, reason: 'not failed' }
      return { ok: false, reason: 'payload expired' }
    },

    async releaseRetry(deliveryId) {
      // Gives the count of the retry back, once: the state guard matches only a retried row, so a second call matches
      // nothing and cannot go below the real count. Known undercount: when the publish reached the broker but was not
      // confirmed, the retry may still run, and the count is then one short (README).
      await database.update(table)
        .set({ state: 'failed', retriedCount: sql`greatest(${table.retriedCount} - 1, 0)` })
        .where(and(eq(table.deliveryId, deliveryId), eq(table.state, 'retried')))
    },

    async markResolved(deliveryId) {
      // A success of a delivery that has a row: a retried one, or a failed one whose success came late (see the consumer).
      const updated = await database.update(table)
        .set({ state: 'resolved' })
        .where(and(eq(table.deliveryId, deliveryId), inArray(table.state, ['failed', 'retried'])))
        .returning({ id: table.id })
      return updated.length > 0
    },

    async setDiscarded(deliveryId, actor, reason, at) {
      // A failed row, or a retried row whose claim has expired: a live retry in flight is not discarded under the PM.
      const claimExpired = and(eq(table.state, 'retried'), lt(table.handledAt, at - RETRY_CLAIM_MS))
      const updated = await database.update(table)
        .set({ state: 'discarded', handledBy: actor, handledAt: at, handledReason: cutTo(reason).slice(0, FAILURE_REASON_MAX) })
        .where(and(eq(table.deliveryId, deliveryId), or(eq(table.state, 'failed'), claimExpired)))
        .returning({ id: table.id })
      return updated.length > 0
    },

    async list(limit) {
      const rows = await database.select(columns)
        .from(table)
        .orderBy(sql`${table.failedAt} desc`)
        .limit(limit)
      return rows.map(metadataOf)
    },

    async count() {
      const [row] = await database.select({ count: sql<number>`count(*)::int` })
        .from(table)
        .where(eq(table.state, 'failed'))
      return row?.count ?? 0
    },

    async stripPayloads(now) {
      // Rule: the later of failed_at and handled_at is older than the retention. Batched, oldest first, by id. The greatest() predicate cannot use the failed_at index, so each batch scans from the start: acceptable at this size.
      const cutoff = now - PAYLOAD_RETENTION_MS
      let stripped = 0
      for (;;) {
        const due = await database.select({ id: table.id })
          .from(table)
          .where(and(
            isNotNull(table.payload),
            lt(sql`greatest(${table.failedAt}, coalesce(${table.handledAt}, 0))`, cutoff)
          ))
          .orderBy(table.failedAt)
          .limit(JANITOR_BATCH)
        if (due.length === 0) return stripped
        await database.update(table)
          .set({ payload: null })
          .where(inArray(table.id, due.map(row => row.id)))
        stripped += due.length
        await new Promise(resolve => setTimeout(resolve, 20))
      }
    }
  }
}

export const databaseFailureRows: FailureRows = makeFailureRows(db)

export interface PmDeps {
  rows?: FailureRows
  queue?: () => DeliveryQueue
  now?: () => number
}

/** The failed deliveries, newest first, without payloads. */
export async function listFailedDeliveries(limit = 50, deps: PmDeps = {}): Promise<FailureRow[]> {
  return (deps.rows ?? databaseFailureRows).list(Math.min(Math.max(1, Math.trunc(limit)), 200))
}

/** One failed delivery's metadata. The payload is not returned here. */
export async function getFailedDelivery(deliveryId: string, deps: PmDeps = {}): Promise<FailureRow | null> {
  const row = await (deps.rows ?? databaseFailureRows).find(deliveryId)
  if (!row) return null
  return metadataOf({ ...row })
}

/** How many deliveries wait in state failed. */
export async function failedCount(deps: PmDeps = {}): Promise<number> {
  return (deps.rows ?? databaseFailureRows).count()
}

/**
 * Sends a failed delivery back to main as a fresh job (attempt 0), with confirm. The row moves to retried in one
 * conditional update first, so a second call finds it not failed and does nothing. If the republish fails the row
 * goes back to failed and the error is thrown. A crash between the update and the publish leaves the row retried
 * with no message in flight. After RETRY_CLAIM_MS the claim has expired: the PM can retry again (the result says
 * 'claim expired') or discard the row. Inside the window a second call matches nothing and runs nothing.
 */
export async function retryFailedDelivery(deliveryId: string, actor: string, deps: PmDeps = {}): Promise<RetryOutcome> {
  const rows = deps.rows ?? databaseFailureRows
  const now = deps.now ?? Date.now
  const claim = await rows.claimForRetry(deliveryId, actor, now())
  if (!claim.ok) return { ok: false, reason: claim.reason }
  try {
    const queue = (deps.queue ?? getDeliveryQueue)()
    await queue.publish('main', { deliveryId, event: claim.event, attempt: 0, body: Buffer.from(claim.payload, 'utf8') })
  } catch (error) {
    await rows.releaseRetry(deliveryId)
    throw error
  }
  return { ok: true, takeover: claim.takeover }
}

/** Marks a failed delivery discarded with a reason. The message in the failed queue is left where it is. */
export async function discardFailedDelivery(deliveryId: string, actor: string, reason: string, deps: PmDeps = {}): Promise<boolean> {
  return (deps.rows ?? databaseFailureRows).setDiscarded(deliveryId, actor, reason, (deps.now ?? Date.now)())
}

/** The janitor: clears stored payloads past their retention. Metadata stays. */
export async function purgeDeliveryPayloads(deps: PmDeps = {}): Promise<number> {
  return (deps.rows ?? databaseFailureRows).stripPayloads((deps.now ?? Date.now)())
}
