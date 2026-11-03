// Turns a stored GitHub link into fresh data. Every call to GitHub goes through
// the github_cache table: a row fresh enough is answered with no call at all, a
// stored ETag turns an unchanged answer into a free 304, and a rate limit keeps
// the last good data and records when to try again. Who may see the result is not
// decided here; the readers filter it with githubAudience.
import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db'
import { githubCache, githubLinks } from '../db/schema'
import type { GithubLink } from '../db/schema'
import { githubGet, rateLimitMessage } from '../lib/github'
import type { GithubFailureCode } from '../lib/github'
import { ownerAllowed } from './githubAllow'
import { pullTransitions } from './githubPullEvents'
import { fireRules, newRuleChain } from './ruleEngine'
import type { PullEventKind, PullSnapshot } from './githubPullEvents'

// An answer younger than this is used as it is, without asking GitHub.
const FRESH_MS = 60_000
// After GitHub was unreachable or refused us, wait this long before trying again.
const RETRY_MS = 30_000
const COMMENTS_SHOWN = 5
const MAX_PULLS = 10
const MAX_REFRESH = 50
const PER_PAGE = 100

const NOT_FOUND = 'GitHub has no such issue, pull request, branch or run, or it is private'
const UNAVAILABLE = 'GitHub could not be reached, try again in a moment'
const REFUSED = 'GitHub refused the request, check the GITHUB_TOKEN on the server'

// What the cache stores in `status` when the last attempt did not give an answer.
// 200 and 404 are real HTTP answers; the rest are our own markers.
const STATUS_UNAVAILABLE = 0
const STATUS_REFUSED = 401
const STATUS_RATE_LIMITED = 429
const STATUS_NOT_FOUND = 404
const STATUS_OK = 200

export type LinkKind = GithubLink['kind']
export type LinkRef = Pick<GithubLink, 'kind' | 'owner' | 'repo' | 'ref'>

export interface IssueComment {
  author: string | null
  body: string
  createdAt: string
  htmlUrl: string
}

export interface IssueDetails {
  number: number
  title: string
  state: 'open' | 'closed'
  labels: { name: string, color: string }[]
  assignees: string[]
  author: string | null
  body: string
  htmlUrl: string
  createdAt: string
  updatedAt: string
  closedAt: string | null
  commentCount: number
  /** The last few comments, oldest first. */
  comments: IssueComment[]
}

export type ReviewState = 'approved' | 'changes_requested' | 'commented' | 'none'
export type ChecksState = 'passing' | 'failing' | 'running' | 'none'

export interface CheckRunSummary {
  name: string
  status: string
  conclusion: string | null
  htmlUrl: string | null
}

export interface PullSummary {
  number: number
  title: string
  state: 'open' | 'closed'
  merged: boolean
  draft: boolean
  author: string | null
  htmlUrl: string
  reviewState: ReviewState
}

export interface PullDetails extends PullSummary {
  updatedAt: string
  mergedAt: string | null
  headRef: string
  headSha: string
  baseRef: string
  /** true or false when the head branch is in this repo; null when that cannot be told. */
  headBranchDeleted: boolean | null
  checks: { state: ChecksState, runs: CheckRunSummary[] }
}

export interface IssueData {
  issue: IssueDetails
  pulls: PullSummary[]
}

export interface BranchData {
  name: string
  defaultBranch: string
  aheadBy: number
  behindBy: number
  lastCommit: { sha: string, message: string, author: string | null, date: string | null, htmlUrl: string } | null
}

export interface RunData {
  id: number
  name: string | null
  status: string | null
  conclusion: string | null
  event: string | null
  headBranch: string | null
  headSha: string | null
  htmlUrl: string
  createdAt: string | null
  updatedAt: string | null
}

export type LinkData = IssueData | PullDetails | BranchData | RunData

export interface SyncResult {
/** Set when what the link points at turned out to be another kind (a pull request found through issue syntax). */
  kind?: LinkKind
  /** The data we have, fresh or last good. Null when there is nothing to show. */
  data: LinkData | null
  /** What went wrong with the latest attempt, or null when everything is fresh. */
  error: GithubFailureCode | null
  /** Plain words for the panel, null when there is no problem. */
  message: string | null
  /** When the oldest part of the data was fetched. */
  fetchedAt: string | null
  /** Set on a rate limit or an outage: when we will try again. */
  nextRetryAt: string | null
}

// ─── The cache ───────────────────────────────────────────────────────────────

interface CacheRow {
  etag: string | null
  status: number | null
  body: unknown
  fetchedAt: number
  nextRetryAt: number | null
}

/** One GitHub answer as the cache has it: the body we hold, if any, and what went wrong. */
interface Piece<T> {
  body: T | null
  fetchedAt: number | null
  failure: { code: GithubFailureCode, message: string, retryAt: number | null } | null
}

async function loadRow(key: string): Promise<CacheRow | null> {
  const [row] = await db.select().from(githubCache).where(eq(githubCache.key, key)).limit(1)
  return row ?? null
}

async function saveRow(key: string, kind: string, values: Partial<Omit<CacheRow, 'fetchedAt'>> & { fetchedAt?: number }) {
  await db.insert(githubCache)
    .values({ id: randomUUID(), key, kind, etag: null, status: null, body: null, fetchedAt: Date.now(), nextRetryAt: null, ...values })
    .onConflictDoUpdate({ target: githubCache.key, set: values })
}

/** What a cached row says, without asking GitHub again. */
function answerFromRow<T>(row: CacheRow): Piece<T> {
  const body = (row.body ?? null) as T | null
  const fetchedAt = row.fetchedAt
  if (row.status === STATUS_NOT_FOUND) return { body: null, fetchedAt, failure: { code: 'not_found', message: NOT_FOUND, retryAt: null } }
  if (row.status === STATUS_RATE_LIMITED) {
    const retryAt = row.nextRetryAt ?? Date.now() + 60_000
    return { body, fetchedAt, failure: { code: 'rate_limited', message: rateLimitMessage(new Date(retryAt)), retryAt } }
  }
  if (row.status === STATUS_REFUSED) return { body, fetchedAt, failure: { code: 'refused', message: REFUSED, retryAt: row.nextRetryAt } }
  if (row.status === STATUS_UNAVAILABLE) return { body, fetchedAt, failure: { code: 'unavailable', message: UNAVAILABLE, retryAt: row.nextRetryAt } }
  return { body, fetchedAt, failure: null }
}

/**
 * One GitHub GET, through the cache. `kind` and `key` name the row; `path` is the
 * API path. `force` skips the freshness window, but never a known rate limit.
 */
async function fetchPiece<T>(kind: string, key: string, path: string, force: boolean): Promise<Piece<T>> {
  const row = await loadRow(key)
  const now = Date.now()
  if (row?.nextRetryAt && row.nextRetryAt > now) return answerFromRow<T>(row)
  if (row && !force && (row.status === STATUS_OK || row.status === STATUS_NOT_FOUND) && row.fetchedAt > now - FRESH_MS) {
    return answerFromRow<T>(row)
  }

  const result = await githubGet<T>(path, { etag: row?.etag ?? null })
  if (result.ok && result.notModified) {
    await saveRow(key, kind, { status: STATUS_OK, fetchedAt: now, nextRetryAt: null, etag: result.etag ?? row?.etag ?? null })
    return answerFromRow<T>(await loadRow(key) as CacheRow)
  }
  if (result.ok) {
    await saveRow(key, kind, { status: STATUS_OK, fetchedAt: now, nextRetryAt: null, etag: result.etag, body: result.data })
    return { body: result.data, fetchedAt: now, failure: null }
  }

  // A failed attempt keeps the last good body, so the panel still has something to show.
  if (result.code === 'not_found') {
    await saveRow(key, kind, { status: STATUS_NOT_FOUND, fetchedAt: now, nextRetryAt: null, etag: null, body: null })
    return answerFromRow<T>({ etag: null, status: STATUS_NOT_FOUND, body: null, fetchedAt: now, nextRetryAt: null })
  }
  if (result.code === 'rate_limited') {
    const retryAt = result.retryAt ?? new Date(now + 60_000)
    await saveRow(key, kind, { status: STATUS_RATE_LIMITED, nextRetryAt: retryAt.getTime() })
  } else if (result.code === 'refused') {
    await saveRow(key, kind, { status: STATUS_REFUSED, nextRetryAt: now + RETRY_MS })
  } else {
    await saveRow(key, kind, { status: STATUS_UNAVAILABLE, nextRetryAt: now + RETRY_MS })
  }
  return answerFromRow<T>(await loadRow(key) as CacheRow)
}

// ─── Names and paths ─────────────────────────────────────────────────────────

// Stored links were checked by the parser when they were written. Checked again
// here, because these names become part of a URL path and a cache key.
const NAME = /^[A-Za-z0-9_.-]{1,100}$/
const NUMBER = /^[1-9]\d{0,9}$/
const BRANCH = /^[A-Za-z0-9_./-]{1,250}$/

function checkLink(link: LinkRef) {
  const nameOk = NAME.test(link.owner) && NAME.test(link.repo) && link.owner !== '.' && link.owner !== '..' && link.repo !== '.' && link.repo !== '..'
  const refOk = link.kind === 'branch'
    ? BRANCH.test(link.ref) && !link.ref.includes('..') && !link.ref.includes('//')
    : NUMBER.test(link.ref)
  if (!nameOk || !refOk) throw new Error('A stored GitHub link has a part that is not a safe name')
}

function repoBase(link: LinkRef): string {
  return `/repos/${link.owner}/${link.repo}`
}

/** A cache key per request, lower-cased on the repo because GitHub names are not case-sensitive. */
function keyFor(link: LinkRef, suffix: string): string {
  return `${link.owner.toLowerCase()}/${link.repo.toLowerCase()}#${link.ref}:${suffix}`
}

/** A pull request as the tags need it (GH3): its head commit now, its branch, author, head repository, and its text. */
export interface PullFacts {
  headSha: string
  headRef: string
  /** The head repository's full name, or null when it is gone (a deleted fork). */
  headRepo: string | null
  author: string
  title: string
  body: string
  state: 'open' | 'closed'
  merged: boolean
}

/**
 * What one GitHub read for a tag gives. `missing` is a 404: the thing is not there, so no tag changes. `transient` is
 * any failure a later attempt can fix: an outage, a timeout, a rate limit, or a cached failure during its backoff.
 * `malformed` is an answer without the parts a tag needs; it fails the same way again, so it is permanent.
 */
export type GithubRead<T>
  = | { kind: 'ok', value: T }
    | { kind: 'missing' }
    | { kind: 'transient', reason: string }
    | { kind: 'malformed', reason: string }

/** A full commit id in lower-case hex (SHA-1 or SHA-256). Only such an id goes into an API path. */
export function validCommitSha(sha: unknown): sha is string {
  return typeof sha === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)
}

/** One cache answer as a read: a failure of any kind (also one served from the backoff window) is transient, a 404 is missing. */
function fromPiece<T>(piece: Piece<T>): GithubRead<T> {
  if (piece.failure?.code === 'not_found') return { kind: 'missing' }
  if (piece.failure) return { kind: 'transient', reason: piece.failure.message }
  if (piece.body === null || piece.body === undefined) return { kind: 'transient', reason: UNAVAILABLE }
  return { kind: 'ok', value: piece.body }
}

/** A pull request as GitHub has it now (GH3 tags). Forced past the cache: a tag must not follow a cached head commit. */
export async function readPullFacts(owner: string, repo: string, number: number): Promise<GithubRead<PullFacts>> {
  const link = { kind: 'pull' as const, owner, repo, ref: String(number) }
  const pull = await fetchPiece<RawPull>('pull', keyFor(link, 'pull'), `${repoBase(link)}/pulls/${number}`, true)
  const read = fromPiece(pull)
  if (read.kind !== 'ok') return read
  const raw = read.value
  if (!validCommitSha(raw.head?.sha) || typeof raw.head?.ref !== 'string' || (raw.state !== 'open' && raw.state !== 'closed')) {
    return { kind: 'malformed', reason: 'GitHub sent a pull request without a usable head commit' }
  }
  return {
    kind: 'ok',
    value: {
      headSha: raw.head.sha,
      headRef: raw.head.ref,
      headRepo: raw.head.repo?.full_name ?? null,
      author: raw.user?.login ?? '',
      title: typeof raw.title === 'string' ? raw.title : '',
      body: typeof raw.body === 'string' ? raw.body : '',
      state: raw.state,
      merged: raw.merged === true || raw.merged_at != null
    }
  }
}

/** Check runs are read this many to a page, and at most this many pages: a list longer than that is unknown. */
const CHECK_PAGE = 100
const CHECK_PAGES = 10

/**
 * Every check run of a commit, read page by page with `page(n)`, until the total GitHub names is read. Fewer runs
 * than the total is unknown (transient): a partial list can read as passing, so no state is made from it.
 */
export async function readAllCheckRuns(page: (n: number) => Promise<GithubRead<{ check_runs?: unknown, total_count?: unknown }>>): Promise<GithubRead<RawCheckRun[]>> {
  const runs: RawCheckRun[] = []
  let total = 0
  for (let n = 1; n <= CHECK_PAGES; n++) {
    const read = await page(n)
    if (read.kind !== 'ok') return read
    const list = read.value.check_runs
    const count = read.value.total_count
    if (!Array.isArray(list) || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      return { kind: 'malformed', reason: 'GitHub sent a check-run list without its parts' }
    }
    for (const run of list) {
      const named = run as { name?: unknown, status?: unknown }
      if (!run || typeof run !== 'object' || typeof named.name !== 'string' || typeof named.status !== 'string') {
        return { kind: 'malformed', reason: 'GitHub sent a check run without a name or status' }
      }
      runs.push(run as RawCheckRun)
    }
    total = count
    if (runs.length >= total || list.length === 0) break
  }
  if (runs.length < total) {
    return { kind: 'transient', reason: `GitHub names ${total} check runs and ${runs.length} were read: the state is unknown` }
  }
  return { kind: 'ok', value: runs }
}

/**
 * The state of one commit from ALL its check runs (required and optional alike; legacy commit statuses are not read).
 * Forced, as readPullFacts. A commit GitHub does not have is missing.
 */
export async function readChecksOfHead(owner: string, repo: string, number: number, sha: string): Promise<GithubRead<ChecksState>> {
  if (!validCommitSha(sha)) return { kind: 'malformed', reason: 'the head commit is not a commit id' }
  const link = { kind: 'pull' as const, owner, repo, ref: String(number) }
  const read = await readAllCheckRuns(async n => fromPiece(await fetchPiece<{ check_runs?: unknown, total_count?: unknown }>(
    'checks',
    keyFor(link, `checks:${sha}:${n}`),
    `${repoBase(link)}/commits/${sha}/check-runs?per_page=${CHECK_PAGE}&page=${n}`,
    true
  )))
  if (read.kind !== 'ok') return read
  return { kind: 'ok', value: checksOf(read.value).state }
}

function iso(ms: number | null | undefined): string | null {
  return typeof ms === 'number' ? new Date(ms).toISOString() : null
}

// ─── Raw GitHub shapes (only the fields we read) ─────────────────────────────

interface RawUser { login?: string }
interface RawIssue {
  number: number
  title: string
  state: 'open' | 'closed'
  labels?: { name: string, color?: string }[]
  assignees?: RawUser[]
  user?: RawUser
  body?: string | null
  html_url: string
  comments?: number
  created_at: string
  updated_at: string
  closed_at?: string | null
  pull_request?: unknown
}
interface RawComment { user?: RawUser, body?: string | null, created_at: string, html_url: string }
interface RawSearchPull {
  number: number
  title: string
  state: 'open' | 'closed'
  draft?: boolean
  user?: RawUser
  html_url: string
  pull_request?: { merged_at?: string | null }
}
interface RawPull {
  number: number
  title: string
  state: 'open' | 'closed'
  merged?: boolean
  merged_at?: string | null
  draft?: boolean
  user?: RawUser
  html_url: string
  updated_at: string
  head: { ref: string, sha: string, repo?: { full_name?: string } | null }
  base: { ref: string }
  body?: string | null
}
interface RawReview { user?: RawUser, state: string }
interface RawCheckRun { name: string, status: string, conclusion: string | null, html_url?: string | null }
interface RawBranch { name: string }
interface RawRepo { default_branch: string }
interface RawCompare { ahead_by: number, behind_by: number }
interface RawCommit {
  sha: string
  html_url: string
  commit: { message: string, author?: { name?: string, date?: string } | null }
  author?: RawUser | null
}
interface RawRun {
  id: number
  name?: string | null
  status?: string | null
  conclusion?: string | null
  event?: string | null
  head_branch?: string | null
  head_sha?: string | null
  html_url: string
  created_at?: string | null
  updated_at?: string | null
}

// ─── Assembling the data ─────────────────────────────────────────────────────

function toComment(raw: RawComment): IssueComment {
  return { author: raw.user?.login ?? null, body: raw.body ?? '', createdAt: raw.created_at, htmlUrl: raw.html_url }
}

/** The latest decision per reviewer decides; a plain comment does not overrule an approval. */
function reviewStateOf(reviews: RawReview[]): ReviewState {
  const latest = new Map<string, string>()
  for (const review of reviews) {
    if (review.state !== 'APPROVED' && review.state !== 'CHANGES_REQUESTED' && review.state !== 'DISMISSED') continue
    latest.set(review.user?.login ?? '', review.state)
  }
  const states = [...latest.values()]
  if (states.includes('CHANGES_REQUESTED')) return 'changes_requested'
  if (states.includes('APPROVED')) return 'approved'
  return reviews.length > 0 ? 'commented' : 'none'
}

const PASSING = new Set(['success', 'neutral', 'skipped'])

export function checksOf(runs: RawCheckRun[]): { state: ChecksState, runs: CheckRunSummary[] } {
  const shown = runs.map(run => ({ name: run.name, status: run.status, conclusion: run.conclusion, htmlUrl: run.html_url ?? null }))
  if (runs.length === 0) return { state: 'none', runs: [] }
  const failing = runs.some(run => run.status === 'completed' && !PASSING.has(run.conclusion ?? ''))
  const running = runs.some(run => run.status !== 'completed')
  const state: ChecksState = failing ? 'failing' : running ? 'running' : 'passing'
  return { state, runs: shown }
}

function summaryOf(pull: RawPull, reviewState: ReviewState): PullSummary {
  return {
    number: pull.number,
    title: pull.title,
    state: pull.state,
    merged: pull.merged === true || pull.merged_at != null,
    draft: pull.draft === true,
    author: pull.user?.login ?? null,
    htmlUrl: pull.html_url,
    reviewState
  }
}

/** The first failure among the parts decides the error; the rest still show. */
function firstFailure(pieces: Piece<unknown>[]) {
  const failed = pieces.find(piece => piece.failure)?.failure ?? null
  const times = pieces.map(piece => piece.fetchedAt).filter((t): t is number => typeof t === 'number')
  return {
    error: failed?.code ?? null,
    message: failed?.message ?? null,
    nextRetryAt: failed?.code === 'rate_limited' || failed?.code === 'unavailable' ? iso(failed.retryAt) : null,
    fetchedAt: iso(times.length ? Math.min(...times) : null)
  }
}

function finish(data: LinkData | null, pieces: Piece<unknown>[]): SyncResult {
  return { data, ...firstFailure(pieces) }
}

// ─── One sync per kind of link ───────────────────────────────────────────────

async function syncIssue(link: LinkRef, force: boolean, events: PullEventKind[] = []): Promise<SyncResult> {
  const base = repoBase(link)
  const n = link.ref
  const issue = await fetchPiece<RawIssue>('issue', keyFor(link, 'issue'), `${base}/issues/${n}`, force)
  if (!issue.body) return finish(null, [issue])

  // GitHub's issues endpoint answers for pull requests too (with a pull_request key), so
  // `owner/repo#45` may be a pull request. Show it as one, with its checks and branch.
  if (issue.body.pull_request) return { ...(await syncPull({ ...link, kind: 'pull' }, force, events)), kind: 'pull' }

  const raw = issue.body
  const count = raw.comments ?? 0
  // The newest comments are on the last page; GitHub pages oldest first.
  const page = Math.max(1, Math.ceil(count / PER_PAGE))
  const comments = await fetchPiece<RawComment[]>('comments', keyFor(link, `comments:p${page}`), `${base}/issues/${n}/comments?per_page=${PER_PAGE}&page=${page}`, force)

  // Pull requests that name this issue: the search endpoint lists PRs whose text has #n.
  const query = encodeURIComponent(`repo:${link.owner}/${link.repo} is:pr ${n}`)
  const search = await fetchPiece<{ items: RawSearchPull[] }>('search', keyFor(link, 'pulls'), `/search/issues?q=${query}`, force)

  const pieces: Piece<unknown>[] = [issue, comments, search]
  const pulls: PullSummary[] = []
  for (const item of (search.body?.items ?? []).slice(0, MAX_PULLS)) {
    const reviews = await fetchPiece<RawReview[]>('reviews', keyFor({ ...link, ref: String(item.number) }, 'reviews'), `${base}/pulls/${item.number}/reviews?per_page=${PER_PAGE}`, force)
    pieces.push(reviews)
    const mergedAt = item.pull_request?.merged_at ?? null
    pulls.push({
      number: item.number,
      title: item.title,
      state: item.state,
      merged: mergedAt !== null,
      draft: item.draft === true,
      author: item.user?.login ?? null,
      htmlUrl: item.html_url,
      reviewState: reviewStateOf(reviews.body ?? [])
    })
  }

  const data: IssueData = {
    issue: {
      number: raw.number,
      title: raw.title,
      state: raw.state,
      labels: (raw.labels ?? []).map(label => ({ name: label.name, color: label.color ?? '' })),
      assignees: (raw.assignees ?? []).map(user => user.login ?? '').filter(Boolean),
      author: raw.user?.login ?? null,
      body: raw.body ?? '',
      htmlUrl: raw.html_url,
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
      closedAt: raw.closed_at ?? null,
      commentCount: count,
      comments: (comments.body ?? []).slice(-COMMENTS_SHOWN).map(toComment)
    },
    pulls
  }
  return finish(data, pieces)
}

/** The pull as the cache holds it before a sync overwrites it, so the sync can tell what changed. Null when never seen. */
async function previousPull(link: LinkRef): Promise<PullSnapshot | null> {
  const row = await loadRow(keyFor(link, 'pull'))
  const pull = row?.body as RawPull | null | undefined
  if (!pull) return null
  const checks = await loadRow(keyFor(link, `checks:${pull.head.sha}`))
  const runs = (checks?.body as { check_runs: RawCheckRun[] } | null | undefined)?.check_runs
  return {
    state: pull.state,
    merged: pull.merged === true || pull.merged_at != null,
    checks: runs ? checksOf(runs).state : null
  }
}

/**
 * Fires the rules for a pull's transitions, once per task that links the pull. An issue
 * link with the same number is the same pull (GitHub numbers both alike). Runs after the
 * sync has saved its cache, and never throws, so a failed lookup does not undo the sync.
 */
async function fireForPull(link: LinkRef, found: PullEventKind[]): Promise<void> {
  if (found.length === 0) return
  try {
    const rows = await db.select({ projectId: githubLinks.projectId, taskId: githubLinks.taskId }).from(githubLinks).where(and(
      sql`lower(${githubLinks.owner}) = ${link.owner.toLowerCase()}`,
      sql`lower(${githubLinks.repo}) = ${link.repo.toLowerCase()}`,
      eq(githubLinks.ref, link.ref),
      sql`${githubLinks.kind} in ('pull', 'issue')`
    ))
    // One chain per change, so each task's rules run once per event.
    const tasks = new Map(rows.map(row => [row.taskId, row.projectId]))
    for (const [taskId, projectId] of tasks) {
      for (const type of found) {
        await fireRules({ type, projectId, taskId, actorId: null, actorIsAgent: false, detail: link.ref }, newRuleChain())
      }
    }
  } catch {
    // The rules are best effort; the sync itself has already been saved.
  }
}

async function syncPull(link: LinkRef, force: boolean, events: PullEventKind[] = []): Promise<SyncResult> {
  const before = await previousPull(link)
  const base = repoBase(link)
  const n = link.ref
  const pull = await fetchPiece<RawPull>('pull', keyFor(link, 'pull'), `${base}/pulls/${n}`, force)
  if (!pull.body) return finish(null, [pull])

  const raw = pull.body
  const reviews = await fetchPiece<RawReview[]>('reviews', keyFor(link, 'reviews'), `${base}/pulls/${n}/reviews?per_page=${PER_PAGE}`, force)
  const checks = await fetchPiece<{ check_runs: RawCheckRun[] }>('checks', keyFor(link, `checks:${raw.head.sha}`), `${base}/commits/${raw.head.sha}/check-runs?per_page=${PER_PAGE}`, force)
  const branches = await fetchPiece<RawBranch[]>('branches', keyFor(link, 'branches'), `${base}/branches?per_page=${PER_PAGE}`, force)

  // A head repo that is not this one is a fork; its branch is not ours to check.
  // An absent head repo is read as this repo, which is what the API means for a same-repo PR.
  const headRepo = raw.head.repo?.full_name?.toLowerCase() ?? `${link.owner}/${link.repo}`.toLowerCase()
  const sameRepo = headRepo === `${link.owner}/${link.repo}`.toLowerCase()
  const headBranchDeleted = sameRepo && branches.body
    ? !branches.body.some(branch => branch.name === raw.head.ref)
    : null

  const reviewState = reviewStateOf(reviews.body ?? [])
  const data: PullDetails = {
    ...summaryOf(raw, reviewState),
    updatedAt: raw.updated_at,
    mergedAt: raw.merged_at ?? null,
    headRef: raw.head.ref,
    headSha: raw.head.sha,
    baseRef: raw.base.ref,
    headBranchDeleted,
    checks: checksOf(checks.body?.check_runs ?? [])
  }
  const after: PullSnapshot = { state: raw.state, merged: data.merged, checks: checks.body ? data.checks.state : null }
  const found = pullTransitions(before, after)
  events.push(...found)
  await fireForPull(link, found)
  return finish(data, [pull, reviews, checks, branches])
}

async function syncBranch(link: LinkRef, force: boolean): Promise<SyncResult> {
  const base = repoBase(link)
  const name = link.ref
  const repo = await fetchPiece<RawRepo>('repo', keyFor(link, 'repo'), base, force)
  if (!repo.body) return finish(null, [repo])

  const defaultBranch = repo.body.default_branch
  // Compare says both how far the branch is ahead and whether it still exists.
  const compare = await fetchPiece<RawCompare>('compare', keyFor(link, `compare:${defaultBranch}`), `${base}/compare/${defaultBranch}...${name}`, force)
  const commit = await fetchPiece<RawCommit>('commit', keyFor(link, 'commit'), `${base}/commits/${name}`, force)
  const pieces: Piece<unknown>[] = [repo, compare, commit]
  if (!compare.body) return finish(null, pieces)

  const last = commit.body
  const data: BranchData = {
    name,
    defaultBranch,
    aheadBy: compare.body.ahead_by,
    behindBy: compare.body.behind_by,
    lastCommit: last
      ? {
          sha: last.sha,
          message: last.commit.message.split('\n')[0] ?? '',
          author: last.commit.author?.name ?? last.author?.login ?? null,
          date: last.commit.author?.date ?? null,
          htmlUrl: last.html_url
        }
      : null
  }
  return finish(data, pieces)
}

async function syncRun(link: LinkRef, force: boolean): Promise<SyncResult> {
  const base = repoBase(link)
  // The runs list is the one place the stored id can be looked up on the API.
  const runs = await fetchPiece<{ workflow_runs: RawRun[] }>('runs', keyFor(link, 'runs'), `${base}/actions/runs?per_page=${PER_PAGE}`, force)
  const found = (runs.body?.workflow_runs ?? []).find(run => String(run.id) === link.ref)
  if (!found) {
    if (runs.failure) return finish(null, [runs])
    return {
      data: null,
      error: 'not_found',
      message: `GitHub has no workflow run ${link.ref} among the latest ${PER_PAGE} runs of this repo`,
      fetchedAt: iso(runs.fetchedAt),
      nextRetryAt: null
    }
  }
  const data: RunData = {
    id: found.id,
    name: found.name ?? null,
    status: found.status ?? null,
    conclusion: found.conclusion ?? null,
    event: found.event ?? null,
    headBranch: found.head_branch ?? null,
    headSha: found.head_sha ?? null,
    htmlUrl: found.html_url,
    createdAt: found.created_at ?? null,
    updatedAt: found.updated_at ?? null
  }
  return finish(data, [runs])
}

/**
 * Brings one stored link up to date and returns what the panel should show.
 * `force` asks GitHub even when the cache is fresh (the refresh button and the
 * webhook use it); a known rate limit is still respected.
 */
export async function syncLink(link: LinkRef, options: { force?: boolean } = {}): Promise<SyncResult> {
  return (await syncLinkEvents(link, options)).result
}

/** As syncLink, and also the pull request events the sync found (see githubPullEvents). */
export async function syncLinkEvents(link: LinkRef, options: { force?: boolean } = {}): Promise<{ result: SyncResult, events: PullEventKind[] }> {
  checkLink(link)
  // The second gate: a link made before the owner was taken off the allowlist is not fetched.
  // Checked before any call or cache write, so a refused owner costs nothing.
  const allowed = ownerAllowed(link.owner)
  if (!allowed.ok) return { result: { data: null, error: 'refused', message: allowed.message, fetchedAt: null, nextRetryAt: null }, events: [] }
  const force = options.force === true
  const events: PullEventKind[] = []
  try {
    if (link.kind === 'issue') return { result: await syncIssue(link, force, events), events }
    if (link.kind === 'pull') return { result: await syncPull(link, force, events), events }
    if (link.kind === 'branch') return { result: await syncBranch(link, force), events }
    return { result: await syncRun(link, force), events }
  } catch {
    // Anything unexpected (a malformed answer, a dropped database connection) is
    // reported in words; the cache keeps what it had.
    return { result: { data: null, error: 'unavailable', message: UNAVAILABLE, fetchedAt: null, nextRetryAt: null }, events }
  }
}

// ─── Webhooks ────────────────────────────────────────────────────────────────

/** A pull request event on one stored link, for the rules engine. */
export interface LinkTransition { projectId: string, taskId: string, linkId: string, event: PullEventKind, prNumber: number }

interface WebhookPayload {
  repository?: { full_name?: string }
  issue?: { number?: number }
  pull_request?: { number?: number }
  check_run?: { check_suite?: { head_branch?: string | null } }
  workflow_run?: { id?: number, head_branch?: string | null }
}

/**
 * Refreshes the cached data for the links an event touches. Only links in the
 * repo the event came from are looked at. Returns the pull request events they found, one entry per link.
 */
export async function refreshForEvent(event: string, payload: WebhookPayload): Promise<LinkTransition[]> {
  const [owner, repo] = (payload.repository?.full_name ?? '').split('/')
  if (!owner || !repo || !NAME.test(owner) || !NAME.test(repo)) return []
  // An event from a repo whose owner is no longer allowed refreshes nothing.
  if (!ownerAllowed(owner).ok) return []

  const links = await db.select({ id: githubLinks.id, projectId: githubLinks.projectId, taskId: githubLinks.taskId, kind: githubLinks.kind, owner: githubLinks.owner, repo: githubLinks.repo, ref: githubLinks.ref })
    .from(githubLinks)
    .where(and(
      sql`lower(${githubLinks.owner}) = ${owner.toLowerCase()}`,
      sql`lower(${githubLinks.repo}) = ${repo.toLowerCase()}`
    ))

  // Which links an event can change: an issue, a PR (and the issues that list it),
  // a check or workflow run (and the PRs and branches it belongs to).
  const affected = links.filter((link) => {
    if (event === 'issues') return link.kind === 'issue' && link.ref === String(payload.issue?.number)
    if (event === 'pull_request') {
      return (link.kind === 'pull' && link.ref === String(payload.pull_request?.number)) || link.kind === 'issue'
    }
    if (event === 'check_run') {
      const branch = payload.check_run?.check_suite?.head_branch
      return link.kind === 'pull' || (link.kind === 'branch' && link.ref === branch)
    }
    if (event === 'workflow_run') {
      const branch = payload.workflow_run?.head_branch
      return (link.kind === 'workflow_run' && link.ref === String(payload.workflow_run?.id))
        || link.kind === 'pull'
        || (link.kind === 'branch' && link.ref === branch)
    }
    return false
  })

  // Several tasks may link the same issue; it is fetched once.
  const unique = new Map<string, LinkRef>()
  for (const link of affected) unique.set(`${link.kind}:${link.ref}`, { ...link, owner, repo })
  const targets = [...unique.values()].slice(0, MAX_REFRESH)
  const found = new Map<string, PullEventKind[]>()
  for (const target of targets) {
    found.set(`${target.kind}:${target.ref}`, (await syncLinkEvents(target, { force: true })).events)
  }
  // One entry per stored link the events belong to, so every task on the PR hears them.
  return affected.flatMap(link => (found.get(`${link.kind}:${link.ref}`) ?? []).map(hit => ({ projectId: link.projectId, taskId: link.taskId, linkId: link.id, event: hit, prNumber: Number(link.ref) })))
}
