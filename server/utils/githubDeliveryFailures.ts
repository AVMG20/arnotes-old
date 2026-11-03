// The database record of GitHub deliveries that gave up. The consumer writes a row here BEFORE it copies the
// delivery to the failed queue, so the row is the record the PM works from; the failed queue is only a
// safety net and nothing here reads it. The PM's functions (list, retry, discard) and the janitor live here
// too. Every change to a row is guarded by its state, so a double call does one thing. The row keeps the latest PM
// action (handled_by, handled_at, handled_reason) and the retry count; the full trail (every action, its actor and
// time) is the agent audit written by the GH6c tools. There is no history column, by decision.
//
// The PM's tools (GH6c) are the pm* functions at the end. A key sees only the repositories of the projects it
// manages as the team (linkedProjectsOf, audienceOf): a delivery of any other repository is refused with the same
// words as one that does not exist, and a list or count never includes one. Output is metadata; the payload is read
// only to decide a retry, and get shows a short preview of it (previewOf), never the body.
import { and, asc, eq, inArray, isNotNull, lt, or, sql } from 'drizzle-orm'
import { db } from '../db'
import { githubDeliveryFailures, projectGithubRepos, projects } from '../db/schema'
import type { ApiKeyContext } from './api-keys'
import { audienceOf, boardFilter } from './mcpAccess'
import { McpToolError } from './mcpToolKit'
import { githubDatabaseLookups } from './agentEvents'
import { deliveryQueueHealth, getDeliveryQueue } from './githubDeliveryQueue'
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

/** What the PM is told when a key cannot act on a delivery: the same words for a missing one and one it does not manage. */
const NOT_LINKED = 'not linked to a project you can manage'
/** What a worker key is told when it tries to retry or discard: those are the crew pm's. */
const PM_ONLY = 'retrying and discarding are for the crew\'s pm key'

const cutTo = (text: string): string => text.replace(/[\r\n\t]+/g, ' ')
/** Text from GitHub or a request, stripped of control and line-separator characters and cut. */
const plain = (text: string, max: number): string => Array.from(text.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')).slice(0, max).join('')

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
  /** Whether a row exists for the delivery. Reads no payload. */
  exists(deliveryId: string): Promise<boolean>
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

/** A repository as the PM names it: its owner and its name, in any letter case. */
export interface RepoKey { owner: string, repo: string }

/** The PM's reads: rows of the repositories a key manages. An empty repos list matches nothing. */
export interface FailureReads {
  /** Newest first. A null state is every state. */
  list(query: { limit: number, state: FailureState | null, repos: RepoKey[] }): Promise<FailureRow[]>
  /** How many rows of these repositories are in each state. */
  countByState(repos: RepoKey[]): Promise<Partial<Record<FailureState, number>>>
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

/** Drizzle implementation of FailureRows, for the app's database handle. */
export function makeFailureRows(database: typeof db): FailureRows {
  return {
    async exists(deliveryId) {
      const [row] = await database.select({ id: table.id })
        .from(table)
        .where(eq(table.deliveryId, deliveryId))
        .limit(1)
      return row !== undefined
    },

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

/** A repository's rows matching any of the keys (case-insensitive). No keys matches nothing. */
function reposFilter(repos: RepoKey[]) {
  if (!repos.length) return sql`false`
  return or(...repos.map(key => and(
    sql`lower(${table.owner}) = ${key.owner.toLowerCase()}`,
    sql`lower(${table.repo}) = ${key.repo.toLowerCase()}`
  )))
}

/** Drizzle implementation of FailureReads. */
export function makeFailureReads(database: typeof db): FailureReads {
  return {
    async list({ limit, state, repos }) {
      const rows = await database.select(columns)
        .from(table)
        .where(and(state ? eq(table.state, state) : undefined, reposFilter(repos)))
        .orderBy(sql`${table.failedAt} desc`)
        .limit(limit)
      return rows.map(metadataOf)
    },

    async countByState(repos) {
      const rows = await database.select({ state: table.state, count: sql<number>`count(*)::int` })
        .from(table)
        .where(reposFilter(repos))
        .groupBy(table.state)
      return Object.fromEntries(rows.map(row => [row.state, row.count])) as Partial<Record<FailureState, number>>
    }
  }
}

export const databaseFailureReads: FailureReads = makeFailureReads(db)

/** The short code of a reason: the only word about a failure that a notice to the PM carries. Never the reason text. */
const FAILURE_CODES: [RegExp, string][] = [
  [/over size cap/, 'size'],
  [/not JSON/, 'not-json'],
  [/handed out/, 'broker-limit'],
  [/attempts are used up/, 'attempts-used'],
  [/earlier attempt/, 'busy'],
  [/budget|took longer|timeout|timed out/, 'timeout'],
  [/could not (wait|publish)/, 'queue'],
  [/could not|records/, 'storage'],
  [/handler/, 'handler']
]

export function failureCode(reason: string): string {
  return FAILURE_CODES.find(([pattern]) => pattern.test(reason))?.[1] ?? 'other'
}

export interface LinkedProject {
  owner: string
  repo: string
  project: { id: string, name: string, userId: string, teamId: string | null, customerId: string | null }
}

export interface PmDeps {
  rows?: FailureRows
  reads?: FailureReads
  queue?: () => DeliveryQueue
  now?: () => number
  /** The linked repositories among the boards the key can open: all of them, or only one repository's. */
  linked?: (context: ApiKeyContext, only: RepoKey | null) => Promise<LinkedProject[]>
  /** The queue's state and depths (deliveryQueueHealth). */
  health?: () => ReturnType<typeof deliveryQueueHealth>
  /** The people of a team's crew with their keys (githubDatabaseLookups.crewPeople). */
  crewPeople?: (teamId: string) => Promise<{ userId: string, key: string }[]>
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

// ---- The PM's tools (GH6c) ----

/** The linked repositories among the boards a key can open, with their projects. A null repository means all of them. */
export async function linkedProjectsOf(context: ApiKeyContext, only: RepoKey | null): Promise<LinkedProject[]> {
  const match = only
    ? and(
        sql`lower(${projectGithubRepos.owner}) = ${only.owner.toLowerCase()}`,
        sql`lower(${projectGithubRepos.repo}) = ${only.repo.toLowerCase()}`
      )
    : undefined
  const rows = await db.select({
    owner: projectGithubRepos.owner,
    repo: projectGithubRepos.repo,
    id: projects.id,
    name: projects.name,
    userId: projects.userId,
    teamId: projects.teamId,
    customerId: projects.customerId
  })
    .from(projectGithubRepos)
    .innerJoin(projects, eq(projects.id, projectGithubRepos.projectId))
    .where(and(await boardFilter(context), match))
    .orderBy(asc(projectGithubRepos.createdAt))
  return rows.map(row => ({
    owner: row.owner,
    repo: row.repo,
    project: { id: row.id, name: row.name, userId: row.userId, teamId: row.teamId, customerId: row.customerId }
  }))
}

/** The repositories a key manages: linked to a project it works on as its team (a customer's board never counts). */
export async function managedRepos(context: ApiKeyContext, deps: PmDeps = {}): Promise<RepoKey[]> {
  const rows = await (deps.linked ?? linkedProjectsOf)(context, null)
  const seen = new Map<string, RepoKey>()
  for (const row of rows) {
    if (audienceOf(context, row.project) === 'staff') seen.set(`${row.owner}/${row.repo}`.toLowerCase(), { owner: row.owner, repo: row.repo })
  }
  return [...seen.values()]
}

/** The project a key acts through for one delivery's repository. Anything else is refused with the same words. */
async function managedProject(context: ApiKeyContext, row: FailureRow | null, deps: PmDeps): Promise<LinkedProject['project']> {
  if (!row || !row.owner || !row.repo) throw new McpToolError(NOT_LINKED)
  const linked = await (deps.linked ?? linkedProjectsOf)(context, { owner: row.owner, repo: row.repo })
  const staff = linked.find(entry => audienceOf(context, entry.project) === 'staff')
  if (!staff) throw new McpToolError(NOT_LINKED)
  return staff.project
}

/**
 * Retry and discard are the crew's pm key's: the key of the pm of the team's crew. A personal board has no crew, so no one
 * else may change a row there. The list, the reads and the status stay open to every staff key.
 */
async function requireCrewPm(context: ApiKeyContext, project: LinkedProject['project'], deps: PmDeps): Promise<void> {
  const people = project.teamId ? await (deps.crewPeople ?? githubDatabaseLookups.crewPeople)(project.teamId) : []
  if (!people.some(person => person.userId === context.userId && person.key === 'pm')) throw new McpToolError(PM_ONLY)
}

/** A row as a tool shows it: metadata only. */
export function itemOf(row: FailureRow) {
  return {
    id: row.deliveryId,
    event: row.event,
    repo: row.owner && row.repo ? `${row.owner}/${row.repo}` : null,
    class: row.class,
    attempts: row.attempts,
    state: row.state,
    reason: row.reason,
    failedAt: row.failedAt,
    retriedCount: row.retriedCount,
    handledBy: row.handledBy,
    handledAt: row.handledAt,
    handledReason: row.handledReason,
    hasPayload: row.hasPayload
  }
}

export interface PayloadPreview { event: string, action: string | null, repository: string | null, number: number | null, title: string | null }

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a GitHub payload is read loosely, field by field
type Loose = Record<string, any>

/** A short preview of a stored payload: the action, the repository, the number and the title (cut, no body). Null when expired. */
export function previewOf(event: string, payload: string | null): PayloadPreview | null {
  if (payload === null) return null
  let body: Loose
  try {
    body = JSON.parse(payload) as Loose
  } catch {
    return { event, action: null, repository: null, number: null, title: null }
  }
  const text = (value: unknown, max: number): string | null => typeof value === 'string' ? plain(value, max) : null
  const item = body.pull_request ?? body.issue ?? null
  const target = item ?? body.check_run ?? body.workflow_run ?? null
  return {
    event,
    action: text(body.action, 40),
    repository: text(body.repository?.full_name, 120),
    number: typeof item?.number === 'number' ? item.number : null,
    title: text(target?.title ?? target?.name, 120)
  }
}

/** The result of retry or discard, as the tool returns it (and the audit reads it). */
export interface PmActionResult {
  deliveryId: string
  outcome: string
  message: string
  board: { id: string, name: string }
}

const RETRY_MESSAGES: Partial<Record<ClaimFailure, string>> = {
  'already retried': 'already retried',
  'payload expired': 'payload expired',
  'not failed': 'not failed'
}

/** The list: the failed count, and the rows (newest first) of the repositories the key manages. */
export async function pmList(context: ApiKeyContext, args: { limit: number, state: FailureState | 'all' }, deps: PmDeps = {}) {
  const repos = await managedRepos(context, deps)
  const reads = deps.reads ?? databaseFailureReads
  const limit = Math.min(Math.max(1, Math.trunc(args.limit)), 200)
  const [items, counts] = await Promise.all([
    reads.list({ limit, state: args.state === 'all' ? null : args.state, repos }),
    reads.countByState(repos)
  ])
  return { failed: counts.failed ?? 0, items: items.map(itemOf) }
}

/** One delivery: its metadata and a short preview of the payload. Never the payload itself. */
export async function pmGet(context: ApiKeyContext, deliveryId: string, deps: PmDeps = {}) {
  const row = await (deps.rows ?? databaseFailureRows).find(deliveryId)
  const project = await managedProject(context, row ? metadataOf({ ...row }) : null, deps)
  return {
    board: { id: project.id, name: project.name },
    item: itemOf(metadataOf({ ...row! })),
    preview: previewOf(row!.event, row!.payload)
  }
}

/** Sends a failed delivery back to main once. A second call, or one inside the claim window, changes nothing. */
export async function pmRetry(context: ApiKeyContext, deliveryId: string, deps: PmDeps = {}): Promise<PmActionResult> {
  const row = await (deps.rows ?? databaseFailureRows).find(deliveryId)
  const project = await managedProject(context, row ? metadataOf({ ...row }) : null, deps)
  await requireCrewPm(context, project, deps)
  const board = { id: project.id, name: project.name }
  let outcome: RetryOutcome
  try {
    outcome = await retryFailedDelivery(deliveryId, context.keyName, deps)
  } catch {
    return { deliveryId, outcome: 'not sent', message: 'could not republish: the broker did not confirm, the row is failed again', board }
  }
  if (outcome.ok) {
    return { deliveryId, outcome: 'retried', message: outcome.takeover ? 'claim expired — retried again' : 'retried', board }
  }
  return { deliveryId, outcome: 'not retried', message: RETRY_MESSAGES[outcome.reason] ?? NOT_LINKED, board }
}

/** Drops a failed delivery with the PM's reason. The payload stays in the row for the audit. */
export async function pmDiscard(context: ApiKeyContext, deliveryId: string, reason: string, deps: PmDeps = {}): Promise<PmActionResult> {
  const row = await (deps.rows ?? databaseFailureRows).find(deliveryId)
  const project = await managedProject(context, row ? metadataOf({ ...row }) : null, deps)
  await requireCrewPm(context, project, deps)
  const board = { id: project.id, name: project.name }
  const done = await discardFailedDelivery(deliveryId, context.keyName, reason, deps)
  return done
    ? { deliveryId, outcome: 'discarded', message: 'discarded', board }
    : { deliveryId, outcome: 'not discarded', message: 'not failed', board }
}

/** The state of the queue as a fixed code and sentence: never the broker's own detail, which can name a host and a port. */
const QUEUE_STATES: Record<string, string> = {
  unavailable: 'The queue cannot be reached, or the server has no broker address.',
  idle: 'The queue has not been opened yet.',
  connecting: 'The queue is connecting.',
  connected: 'The queue is connected.',
  reconnecting: 'The queue lost its connection and is reconnecting.',
  closed: 'The queue is closed.',
  unknown: 'The queue state is not known.'
}

/** The queue for the PM: its fixed state, its depths and the failed rows of its repositories by state. Never the broker address, the detail or a host or port. */
export async function pmQueueStatus(context: ApiKeyContext, deps: PmDeps = {}) {
  const repos = await managedRepos(context, deps)
  if (!repos.length) throw new McpToolError(NOT_LINKED)
  const health = await (deps.health ?? deliveryQueueHealth)()
  const rows = await (deps.reads ?? databaseFailureReads).countByState(repos)
  const state = health.state in QUEUE_STATES ? health.state : 'unknown'
  return {
    queue: { state, sentence: QUEUE_STATES[state], depth: health.depth, failedDepth: health.failed },
    failedRows: rows
  }
}
