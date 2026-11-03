// The catch-up of issue sync (GH5): the open issues of a linked repository and their comments are read from
// GitHub and applied through the same processGithubDelivery as a webhook delivery, so the same rules decide
// what becomes a card. A catch-up job is queued (event `catch_up`) when issue sync is switched on, or when the
// owner presses "Catch up now". It is never sent by GitHub, so the webhook does not accept it.
// Running it twice creates nothing twice: a card or a copied comment that is already there is left alone.
import { createHash } from 'node:crypto'
import { githubGet } from '../lib/github'
import { ownerAllowed } from './githubAllow'
import { getDeliveryQueue } from './githubDeliveryQueue'
import type { DeliveryJob, GithubCardStore } from './githubCards'

export const CATCH_UP_EVENT = 'catch_up'
/** The most open issues one run reads. A repository with more gets the first ones, and the run is marked truncated. */
export const MAX_ISSUES = 200
/** The most pages of the issue list one run reads, pull requests included, so PR-only pages cannot read on forever. */
export const MAX_PAGES = 10
/** The most comments of one issue a run copies. */
export const MAX_COMMENTS = 50
const PER_PAGE = 100
/** Reads one repository may make per minute: the list pages and the comment reads of every run together. */
export const READS_PER_MINUTE = 120
/** A queued catch-up holds its repository for this long at most, in case its job is lost. */
const IN_FLIGHT_MS = 15 * 60_000

/** The answer the owner sees when a catch-up cannot be queued. Never the error text: the broker address stays out. */
export const QUEUE_UNAVAILABLE = 'The catch-up could not be queued right now. Try again in a minute.'

export class CatchUpNotQueued extends Error {
  constructor() {
    super(QUEUE_UNAVAILABLE)
    this.name = 'CatchUpNotQueued'
  }
}

/** Repository row id → when its catch-up was queued. Cleared when the run ends, or after IN_FLIGHT_MS. */
const inFlight = new Map<string, number>()

/** Whether a catch-up of this repository is queued or running in this process. */
export function catchUpInFlight(rowId: string): boolean {
  const at = inFlight.get(rowId)
  if (at === undefined) return false
  if (Date.now() - at < IN_FLIGHT_MS) return true
  inFlight.delete(rowId)
  return false
}

/**
 * The delivery id of one queued catch-up: the repository row, the milliseconds of the request, and a version of the
 * sync settings it saves. Two toggles in the same second with different settings are two jobs.
 */
export function catchUpDeliveryId(rowId: string, at: number, settings: unknown): string {
  const version = createHash('sha256').update(JSON.stringify(settings)).digest('hex').slice(0, 12)
  return `catch-up ${rowId} ${at} ${version}`
}

/** The sync settings of a linked repository, as the delivery id's version (see catchUpDeliveryId). */
export interface SyncSettingsRow {
  syncEnabled: boolean
  syncColumn: string
  syncVisibility: string
  acceptedLogins: string[]
  stagingBranches: string
  productionBranches: string
  completeOnClose: boolean
}

export function syncSettingsOf(row: SyncSettingsRow) {
  return {
    syncEnabled: row.syncEnabled,
    syncColumn: row.syncColumn,
    syncVisibility: row.syncVisibility,
    acceptedLogins: row.acceptedLogins,
    stagingBranches: row.stagingBranches,
    productionBranches: row.productionBranches,
    completeOnClose: row.completeOnClose
  }
}

/** A catch-up that cannot finish: transient is retried by the queue, permanent is set aside. */
export class CatchUpFailure extends Error {
  constructor(readonly kind: 'transient' | 'permanent', message: string) {
    super(message)
    this.name = 'CatchUpFailure'
  }
}

/** The attempt was abandoned: the run stops and writes nothing more. */
export class CatchUpAborted extends Error {
  constructor() {
    super('the catch-up was abandoned')
    this.name = 'AbortError'
  }
}

/** GitHub's answers the run needs. The live reader by default; the tests give recorded answers. */
export interface CatchUpGithub {
  /** One page of open issues, pull requests included (GitHub lists both). */
  issuePage(owner: string, repo: string, page: number): Promise<unknown[]>
  /** The first page of comments of an issue. */
  comments(owner: string, repo: string, number: number): Promise<unknown[]>
}

export const liveCatchUpGithub: CatchUpGithub = {
  async issuePage(owner, repo, page) {
    const read = await githubGet<unknown[]>(`/repos/${owner}/${repo}/issues?state=open&per_page=${PER_PAGE}&page=${page}`)
    return unwrap(read, owner, repo)
  },
  async comments(owner, repo, number) {
    const read = await githubGet<unknown[]>(`/repos/${owner}/${repo}/issues/${number}/comments?per_page=${MAX_COMMENTS}`)
    return unwrap(read, owner, repo)
  }
}

function unwrap(read: Awaited<ReturnType<typeof githubGet<unknown[]>>>, owner: string, repo: string): unknown[] {
  if (read.ok && !read.notModified) return Array.isArray(read.data) ? read.data : []
  if (read.ok) return []
  if (read.code === 'not_found') throw new CatchUpFailure('permanent', `GitHub has no repository ${owner}/${repo}, or it is private`)
  throw new CatchUpFailure('transient', read.message)
}

/** Reads per repository per minute. Its own copy of the rule the tag reads use (githubTags.ts ReadBudget). */
export class CatchUpBudget {
  private readonly windows = new Map<string, { start: number, count: number }>()

  constructor(private readonly perMinute: number, private readonly now: () => number = Date.now) {}

  take(repository: string): boolean {
    const at = this.now()
    const window = this.windows.get(repository)
    if (!window || at - window.start >= 60_000) {
      this.windows.set(repository, { start: at, count: 1 })
      return true
    }
    if (window.count >= this.perMinute) return false
    window.count++
    return true
  }
}

let defaultBudget: CatchUpBudget | null = null

export interface CatchUpDeps {
  /** Reads the linked repositories of the owner and name, with their accepted logins and sync switch. */
  store: Pick<GithubCardStore, 'linkedRepos'>
  /** Applies one synthetic webhook-shaped delivery (processGithubDelivery). */
  apply: (job: DeliveryJob) => Promise<'ignored' | 'done'>
  github?: CatchUpGithub
  budget?: CatchUpBudget
  signal?: AbortSignal
}

/** What one run did, for the log line. Strangers are counted here only; ignored_count is not changed by a catch-up. */
export interface CatchUpTally {
  issues: number
  queuedIssues: number
  strangerIssues: number
  comments: number
  truncatedIssues: boolean
}

/**
 * Runs one catch-up of a repository. Issues by accepted logins go through the webhook's `opened` path (which creates
 * the card once, or does nothing when it exists), and their comments through the `created` path (copied once, by
 * marker). Pull requests and strangers are skipped before the apply, so a catch-up never adds to ignored_count.
 */
export async function runCatchUp(job: DeliveryJob, deps: CatchUpDeps): Promise<'ignored' | 'done'> {
  // The repository is no longer in flight once this run ends, whatever the answer; a retry queues its own job.
  const rowId = String(field(field(job.payload, 'catch_up'), 'row') ?? '')
  try {
    return await runCatchUpOnce(job, deps)
  } finally {
    if (rowId) inFlight.delete(rowId)
  }
}

async function runCatchUpOnce(job: DeliveryJob, deps: CatchUpDeps): Promise<'ignored' | 'done'> {
  const owner = job.repoOwner
  const repo = job.repoName
  if (!ownerAllowed(owner).ok) return 'ignored'
  // Without the server's token the catch-up is skipped: the setting says so (catchup.post.ts). Nothing is read.
  if (!deps.github && !process.env.GITHUB_TOKEN?.trim()) return 'ignored'
  const github = deps.github ?? liveCatchUpGithub
  const budget = deps.budget ?? (defaultBudget ??= new CatchUpBudget(READS_PER_MINUTE))
  const key = `${owner}/${repo}`.toLowerCase()

  let linked
  try {
    linked = (await deps.store.linkedRepos(owner, repo)).filter(row => row.syncEnabled)
  } catch {
    throw new CatchUpFailure('transient', 'could not read the linked repositories')
  }
  if (!linked.length) return 'ignored'
  const logins = new Set(linked.flatMap(row => row.acceptedLogins.map(login => login.toLowerCase())))

  const read = async <T>(work: () => Promise<T>): Promise<T> => {
    if (deps.signal?.aborted) throw new CatchUpAborted()
    if (!budget.take(key)) throw new CatchUpFailure('transient', 'the read budget of this repository is used up for now, the catch-up will be retried')
    return work()
  }

  const tally: CatchUpTally = { issues: 0, queuedIssues: 0, strangerIssues: 0, comments: 0, truncatedIssues: false }
  const issues: Record<string, unknown>[] = []
  // Stops at the issue cap or the page cap, whichever comes first; a full page left unread makes the run truncated.
  let page = 1
  for (; ; page++) {
    const items = await read(() => github.issuePage(owner, repo, page))
    for (const item of items) {
      if (issues.length >= MAX_ISSUES) break
      if (field(item, 'pull_request') !== undefined && field(item, 'pull_request') !== null) continue
      issues.push(item as Record<string, unknown>)
    }
    if (items.length < PER_PAGE) break
    if (issues.length >= MAX_ISSUES || page >= MAX_PAGES) {
      tally.truncatedIssues = true
      break
    }
  }
  tally.issues = issues.length

  for (const issue of issues) {
    if (deps.signal?.aborted) throw new CatchUpAborted()
    const number = field(issue, 'number')
    const author = String(field(field(issue, 'user'), 'login') ?? '').toLowerCase()
    if (typeof number !== 'number' || !logins.has(author)) {
      tally.strangerIssues++
      continue
    }
    tally.queuedIssues++
    const repository = { full_name: `${owner}/${repo}`, id: job.repoId }
    await deps.apply(synthetic(job, repository, 'issues', { action: 'opened', issue }, `issue ${number}`))

    if (!(Number(field(issue, 'comments')) > 0)) continue
    const comments = await read(() => github.comments(owner, repo, number as number))
    for (const comment of comments.slice(0, MAX_COMMENTS)) {
      const commenter = String(field(field(comment, 'user'), 'login') ?? '').toLowerCase()
      if (!logins.has(commenter)) continue
      tally.comments++
      await deps.apply(synthetic(job, repository, 'issue_comment', { action: 'created', issue, comment }, `comment ${field(comment, 'id')}`))
    }
  }
  console.info(`[github] catch-up ${key}: ${tally.issues} open issues read, ${tally.queuedIssues} by accepted logins, ${tally.strangerIssues} by others (not copied), ${tally.comments} comments${tally.truncatedIssues ? `, only the first ${MAX_ISSUES} open issues checked` : ''}`)
  return 'done'
}

// A webhook-shaped job for one issue or comment. The id is stable per item, so the markers the apply writes match
// the ones a retry or a second run looks for.
function synthetic(job: DeliveryJob, repository: { full_name: string, id: number }, event: string, body: Record<string, unknown>, what: string): DeliveryJob {
  return {
    deliveryId: `catch-up ${job.repoOwner}/${job.repoName} ${what}`,
    event,
    repoOwner: job.repoOwner,
    repoName: job.repoName,
    repoId: job.repoId,
    payload: { ...body, repository },
    receivedAt: job.receivedAt,
    firstSeenAt: job.firstSeenAt,
    attempt: job.attempt
  }
}

function field(value: unknown, key: string): unknown {
  return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined
}

/**
 * Queues one catch-up of a repository (one job per request), with the broker's confirm: the caller is answered only
 * once the queue has the job. The delivery id is the id the queue dedupes on: the same settings change (repository
 * row and second) is one job.
 */
export async function queueCatchUp(
  row: { id: string, owner: string, repo: string },
  deliveryId: string,
  publish: (queue: 'main', message: { deliveryId: string, event: string, attempt: number, body: Buffer }) => Promise<void> = (queue, message) => getDeliveryQueue().publish(queue, message)
): Promise<'queued' | 'already'> {
  // One catch-up per repository at a time: a second request while one is queued or running is answered 'already'.
  if (catchUpInFlight(row.id)) return 'already'
  inFlight.set(row.id, Date.now())
  const body = Buffer.from(JSON.stringify({ repository: { full_name: `${row.owner}/${row.repo}`, id: 0 }, catch_up: { row: row.id } }))
  try {
    await publish('main', { deliveryId, event: CATCH_UP_EVENT, attempt: 0, body })
  } catch (error) {
    inFlight.delete(row.id)
    // The error text may name the broker: only its class is logged, and the caller gets the fixed sentence.
    console.error(`[github] catch-up of repository ${row.id} not queued (${error instanceof Error ? error.name : 'non-Error'})`)
    throw new CatchUpNotQueued()
  }
  return 'queued'
}
