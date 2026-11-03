// GitHub drives a card's tags (GH3): the pipeline state of a pull request, and where it was merged or closed.
// The tags are built in, not rules: no rule adds them. The rules engine keeps its own actions on the same events
// (githubPullEvents.ts), and the link refresh that fires them runs here, inside the consumer, under the same
// read budget as the tags (the webhook no longer refreshes for these events).
//
// Who gets tagged. A card linked to the pull request (kind pull, set by a board member) always does. A card linked
// to an issue the pull request closes (a closing keyword before #N in its title or body, same repository only) does
// only when the pull request comes from this repository (not a fork), its author is in the accepted logins of that
// project's link (the list that gates issue sync), and the project links the repository with sync on or links the
// pull request. Otherwise the keyword is ignored, with one log line. Cross-repository keywords are never read.
//
// The work runs inside processGithubDelivery (githubCards.ts), so the queue retries a failure like any delivery.
// Each card's tag change and its activity lines are one transaction; the agent event is sent after that commit,
// and a failure to send it is logged, never retried (a retry would find the tags set and not send it again).
//
// Reads. A real read of GitHub (the pull request, its check runs) is one token of the repository's
// per-minute budget (GITHUB_TAG_READS_PER_MINUTE, 60 by default); the link refresh has a bucket of its own of the same size. A read is reused for the same pull request and
// head commit when it was made less than COALESCE_MS ago and after the delivery was received, so a burst of check
// events makes about one read. Each GitHub failure is transient (a retry spaces the reads out); a 404 means the
// thing is gone and is ignored; an answer without the parts a tag needs is permanent.
//
// Decisions (also in the README):
// - Drafts get pipeline tags: a draft's checks are a pipeline.
// - A fork's pull request gets merge and close tags, and its pipeline tags at its own opened, reopened and
//   synchronize events. Its check events name no pull request, so the pipeline is not followed as its checks finish.
// - The pipeline state is the head commit's ALL check runs, required or optional alike. Legacy commit statuses are not read.
// - Issue keywords count for any base branch, not only the default one: a pull request into staging names its work too.
// - Branch names are compared exactly: Staging is not staging (git branch names are case-sensitive).
// - Reopening removes pr closed; a close without a merge adds it again.
import { randomUUID } from 'node:crypto'
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { db } from '../db'
import { githubLinks, projectColumns, projectGithubRepos, projects, projectTasks, taskActivity } from '../db/schema'
import { announceGithubEvent } from './agentEvents'
import type { AgentBoard, GithubEventInput, GithubEventKind } from './agentEvents'
import { ownerAllowed } from './githubAllow'
import { DeliveryAborted, DeliveryError, TAG_EVENTS } from './githubCards'
import type { DeliveryJob } from './githubCards'
import { readChecksOfHead, readPullFacts, refreshForEvent, validCommitSha } from './githubSync'
import type { ChecksState, GithubRead, PullFacts } from './githubSync'
import { publish, workspaceTopic } from './realtime'

const NAME = /^[A-Za-z0-9_.-]{1,100}$/
// A branch name as git allows it. Anything else is never shown in an event or used to name a base branch.
const BRANCH = /^[A-Za-z0-9._/-]{1,100}$/
const REF_LIMIT = 60
const CARD_LIMIT = 20
const BRANCH_LIMIT = 20
// A check or workflow event names the pull requests it is for; more than this is cut, and logged.
const PULL_LIMIT = 5
// A closing keyword followed by #N, as GitHub reads them. A cross-repository form (owner/repo#N) does not match.
const CLOSING = /\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s*:?\s+#(\d{1,9})\b/gi
const PULL_ACTIONS = new Set(['opened', 'reopened', 'synchronize'])
const CHECK_ACTIONS = new Set(['created', 'completed', 'rerequested'])
const RUN_ACTIONS = new Set(['requested', 'in_progress', 'completed'])
// A read of the same pull request and head commit is reused for this long, when it started after the delivery came in.
const COALESCE_MS = 3_000
const DEFAULT_READS_PER_MINUTE = 60
const SNAPSHOT_LIMIT = 500

export const PIPELINE_TAGS = ['pipeline running', 'pipeline failed', 'pipeline passed'] as const
export type PipelineTag = (typeof PIPELINE_TAGS)[number]
export const PR_CLOSED_TAG = 'pr closed'

// The colour a tag gets when the board does not have one yet. A tag that already has a colour keeps it. Frozen.
export const TAG_COLOURS: Readonly<Record<string, string>> = Object.freeze({
  'pipeline running': 'sky',
  'pipeline failed': 'red',
  'pipeline passed': 'green',
  'merged staging': 'violet',
  'merged production': 'indigo',
  'pr closed': 'orange'
})

// The agent event a tag change announces. The other tags change a card without an event.
const EVENT_OF_TAG: Readonly<Record<string, GithubEventKind>> = Object.freeze({
  'pipeline failed': 'pipeline_failed',
  'pipeline passed': 'pipeline_passed',
  'merged staging': 'merged_staging',
  'merged production': 'merged_production'
})

// ─── Pure decisions ──────────────────────────────────────────────────────────

/** The pipeline tag a checks state means. No checks means no tag change. */
export function pipelineTagOf(state: ChecksState | null): PipelineTag | null {
  if (state === 'failing') return 'pipeline failed'
  if (state === 'running') return 'pipeline running'
  if (state === 'passing') return 'pipeline passed'
  return null
}

/** The issue numbers the title or body closes (Fixes #N, Closes #N, Resolves #N ...), distinct, at most CARD_LIMIT. */
export function closedIssuesOf(title: string, body: string): number[] {
  const found = new Set<number>()
  for (const text of [title, body]) {
    for (const match of text.matchAll(CLOSING)) {
      const number = Number(match[1])
      if (Number.isSafeInteger(number) && number > 0) found.add(number)
    }
  }
  return [...found].slice(0, CARD_LIMIT)
}

/** A comma-separated list of branch names from the settings: names that are not valid are dropped. */
export function branchesOf(list: string): string[] {
  return list.split(',').map(name => name.trim()).filter(name => BRANCH.test(name)).slice(0, BRANCH_LIMIT)
}

/**
 * The merge tags of a merged pull request: staging when its base is a staging branch, production when it is a
 * production branch (none named means the repository's default branch). Names match exactly. A pull request not
 * merged gets none.
 */
export function mergeTagsOf(input: { merged: boolean, base: string, staging: string[], production: string[], defaultBranch: string }): string[] {
  if (!input.merged || !BRANCH.test(input.base)) return []
  const tags: string[] = []
  if (input.staging.includes(input.base)) tags.push('merged staging')
  const production = input.production.length ? input.production : [input.defaultBranch]
  if (production.includes(input.base)) tags.push('merged production')
  return tags
}

/** The ref an event names: '#<number> <branch>', the branch only when it is a valid name, cut to 60 characters. */
export function refOf(number: number, branch: string): string {
  const named = BRANCH.test(branch) ? ` ${branch}` : ''
  return Array.from(`#${number}${named}`).slice(0, REF_LIMIT).join('')
}

export interface TagPlan {
  add: string[]
  remove: string[]
  tags: string[]
  colours: Record<string, string>
}

/**
 * The change one card needs: the pipeline tag replaces the other pipeline tags, the tags in `add` are added when
 * missing, the tags in `drop` are removed when present. Nothing else is touched. Null when nothing differs: nothing is
 * written, and no event follows.
 */
export function planTags(tags: string[], colours: Record<string, string>, wanted: { pipeline: PipelineTag | null, add: string[], drop?: string[] }): TagPlan | null {
  const pipelineTags: readonly string[] = PIPELINE_TAGS
  const replaced = wanted.pipeline ? tags.filter(tag => pipelineTags.includes(tag) && tag !== wanted.pipeline) : []
  const dropped = tags.filter(tag => (wanted.drop ?? []).includes(tag))
  const remove = [...new Set([...replaced, ...dropped])]
  const wantedTags = [...(wanted.pipeline ? [wanted.pipeline] : []), ...wanted.add]
  const add = [...new Set(wantedTags.filter(tag => !tags.includes(tag)))]
  if (!add.length && !remove.length) return null
  const nextColours = { ...colours }
  for (const tag of add) {
    if (!(tag in nextColours) && TAG_COLOURS[tag]) nextColours[tag] = TAG_COLOURS[tag]
  }
  return { add, remove, tags: [...tags.filter(tag => !remove.includes(tag)), ...add], colours: nextColours }
}

// ─── The store, GitHub, and the budget, as the work needs them ───────────────

export interface TagRepoLink {
  projectId: string
  syncEnabled: boolean
  staging: string[]
  production: string[]
  /** The accepted logins of the link, lower-cased: the same list that gates issue sync. */
  acceptedLogins: string[]
}

export interface TagCard {
  id: string
  projectId: string
  title: string
  board: AgentBoard
  assigneeId: string | null
  createdBy: string | null
  column: string
}

export interface LinkedCard {
  kind: 'pull' | 'issue'
  card: TagCard
}

export interface TagStore {
  /** Every project's link of this repository, sync on or off. */
  repoLinks(owner: string, repo: string): Promise<TagRepoLink[]>
  /** True when a card is linked to this pull request, or any issue of this repository is linked to a card. */
  linkedAt(owner: string, repo: string, number: number): Promise<boolean>
  /** The cards linked to the pull request, and to the issues given (kind issue), trashed ones left out. */
  linkedCards(owner: string, repo: string, number: number, issues: number[]): Promise<LinkedCard[]>
  /**
   * Plans and writes one card's tags in one transaction: the plan is made from the tags as they are then, under a
   * row lock. Returns the tags added (possibly none), or null when the card was not changed.
   */
  applyTags(cardId: string, plan: (tags: string[], colours: Record<string, string>) => TagPlan | null, url: string): Promise<string[] | null>
}

export interface TagGithub {
  pull(owner: string, repo: string, number: number): Promise<GithubRead<PullFacts>>
  checks(owner: string, repo: string, number: number, sha: string): Promise<GithubRead<ChecksState>>
  /** The link cache refresh, which also fires the rules on the pull request's transitions. */
  refresh(event: string, payload: unknown): Promise<void>
}

/** The per-repository budget of real GitHub reads by tag work: a fixed window of one minute per repository. */
export class ReadBudget {
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

/** GITHUB_TAG_READS_PER_MINUTE: a whole number from 1 to 100000; anything else is the default, with one log line. */
export function readBudgetFromEnv(env: NodeJS.ProcessEnv = process.env): ReadBudget {
  const raw = (env.GITHUB_TAG_READS_PER_MINUTE ?? '').trim()
  if (!raw) return new ReadBudget(DEFAULT_READS_PER_MINUTE)
  const value = Number(raw)
  if (Number.isInteger(value) && value >= 1 && value <= 100_000) return new ReadBudget(value)
  console.warn(`GitHub tags: GITHUB_TAG_READS_PER_MINUTE is not a whole number from 1 to 100000: using ${DEFAULT_READS_PER_MINUTE}`)
  return new ReadBudget(DEFAULT_READS_PER_MINUTE)
}

export interface TagDeps {
  store: TagStore
  /** GitHub's answers. The live reader by default; the tests give recorded answers. */
  github?: TagGithub
  signal?: AbortSignal
  /** The agent event sink. announceGithubEvent by default. */
  announce?: (input: GithubEventInput) => void
  /** The read budget. One per process by default (readBudgetFromEnv). */
  budget?: ReadBudget
  /** The link refresh has its own budget, so a spent tag budget cannot lose a rule firing. One per process by default. */
  refreshBudget?: ReadBudget
}

export type TagOutcome = 'ignored' | 'done'

export const liveGithub: TagGithub = {
  pull: (owner, repo, number) => readPullFacts(owner, repo, number),
  checks: (owner, repo, number, sha) => readChecksOfHead(owner, repo, number, sha),
  refresh: async (event, payload) => {
    await refreshForEvent(event, payload as Parameters<typeof refreshForEvent>[1])
  }
}

let defaultBudget: ReadBudget | null = null
let defaultRefreshBudget: ReadBudget | null = null

// The reads of a pull request by head commit: reused for COALESCE_MS, when they started after the delivery came in.
interface Snapshot {
  at: number
  facts: GithubRead<PullFacts>
  checks: GithubRead<ChecksState> | null
}
const snapshots = new Map<string, Snapshot>()

/** Forgets the reads kept for coalescing (the tests use it; the server never needs it). */
export function resetTagReads(): void {
  snapshots.clear()
  defaultBudget = null
}

// ─── The work ────────────────────────────────────────────────────────────────

/** One pull request's tag work: what the event and GitHub say, and the pipeline state for its head commit. */
interface PullWork {
  number: number
  sha: string
  headRef: string
  title: string
  body: string
  author: string
  /** The pull request comes from this repository, not a fork (its head repository is the base). */
  sameRepo: boolean
  pipeline: PipelineTag | null
  merged: boolean
  base: string
  defaultBranch: string
  closedUnmerged: boolean
  reopened: boolean
}

interface PullRequestEvent {
  number: number
  action: string
  headSha: string
  headRef: string
  headRepo: string
  author: string
  title: string
  body: string
  merged: boolean
  base: string
  defaultBranch: string
}

/** The deps the work runs with: GitHub, the sink and the budget are always there (the defaults are filled in). */
interface ReadyDeps extends TagDeps {
  github: TagGithub
  announce: (input: GithubEventInput) => void
  budget: ReadBudget
  refreshBudget: ReadBudget
}

function field(value: unknown, key: string): unknown {
  return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function stopIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DeliveryAborted()
}

function pullRequestEvent(payload: unknown): PullRequestEvent | null {
  const pull = field(payload, 'pull_request')
  const number = positiveInt(field(pull, 'number'))
  const action = text(field(payload, 'action')) ?? ''
  if (number === null || !(PULL_ACTIONS.has(action) || action === 'closed')) return null
  const base = field(pull, 'base')
  const head = field(pull, 'head')
  return {
    number,
    action,
    headSha: text(field(head, 'sha')) ?? '',
    headRef: text(field(head, 'ref')) ?? '',
    headRepo: text(field(field(head, 'repo'), 'full_name')) ?? '',
    author: text(field(field(pull, 'user'), 'login')) ?? '',
    title: text(field(pull, 'title')) ?? '',
    body: text(field(pull, 'body')) ?? '',
    merged: field(pull, 'merged') === true,
    base: text(field(base, 'ref')) ?? '',
    defaultBranch: text(field(field(base, 'repo'), 'default_branch')) ?? ''
  }
}

/** The pull requests a check or workflow event is for (at most PULL_LIMIT, the rest logged), and the head commit it names. */
function runEvent(event: string, payload: unknown): { numbers: number[], headSha: string, named: number } | null {
  const run = field(payload, event === 'check_run' ? 'check_run' : 'workflow_run')
  const action = text(field(payload, 'action')) ?? ''
  const actions = event === 'check_run' ? CHECK_ACTIONS : RUN_ACTIONS
  const headSha = text(field(run, 'head_sha')) ?? ''
  if (!actions.has(action) || !headSha) return null
  const pulls = field(run, 'pull_requests')
  const all = Array.isArray(pulls)
    ? [...new Set(pulls.map(pull => positiveInt(field(pull, 'number'))).filter((number): number is number => number !== null))]
    : []
  return { numbers: all.slice(0, PULL_LIMIT), headSha, named: all.length }
}

/** A failed read as the error the queue acts on: transient is retried, malformed is permanent. */
function readFailure(number: number, what: string, read: { kind: 'transient' | 'malformed', reason: string }): DeliveryError {
  return new DeliveryError(read.kind === 'transient' ? 'transient' : 'permanent', `pull ${number}: ${what}: ${read.reason}`)
}

/** A GitHub read that throws (a network error, a bad answer shape) is a transient failure, never an unknown one. */
async function guarded<T>(work: () => Promise<T>, number: number): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof DeliveryAborted) throw error
    throw new DeliveryError('transient', `pull ${number}: GitHub could not be read (${error instanceof Error ? error.name : 'non-Error'})`)
  }
}

function classify(error: unknown, number: number): DeliveryError {
  if (error instanceof DeliveryError) return new DeliveryError(error.kind, `pull ${number}: ${error.reason}`)
  if (error instanceof TypeError || error instanceof RangeError) {
    return new DeliveryError('permanent', `pull ${number}: the tags hit a ${error.name}`)
  }
  return new DeliveryError('transient', `pull ${number}: a tag write did not finish`)
}

/**
 * The reads of one pull request for a head commit: the link refresh (which fires the rules), the pull request, and,
 * when wanted, its check runs. A read that started after the delivery came in, for the same head commit, less than
 * COALESCE_MS ago, is reused and costs no budget. A real read takes one token of the repository's budget.
 */
async function snapshotOf(owner: string, repo: string, number: number, sha: string, wantChecks: boolean, event: string, payload: unknown, job: DeliveryJob, deps: ReadyDeps): Promise<Snapshot> {
  const key = `${owner.toLowerCase()}/${repo.toLowerCase()}#${number}@${sha}`
  const started = Date.now()
  const hit = snapshots.get(key)
  if (hit && hit.at >= job.receivedAt && started - hit.at < COALESCE_MS && (!wantChecks || hit.checks !== null)) return hit

  // The link refresh has its own bucket and runs first, so a spent tag budget cannot lose a rule firing.
  const refreshAllowed = deps.refreshBudget.take(`${owner}/${repo}`.toLowerCase())
  if (!refreshAllowed) {
    console.error(`GitHub delivery ${job.deliveryId} (${event}): the link refresh is over its per-minute limit, so the rules may miss this change`)
  }
  try {
    if (refreshAllowed) await deps.github.refresh(event, payload)
  } catch (error) {
    // The cache refresh is best effort, as it was in the webhook: the tags below read GitHub themselves.
    console.error(`GitHub delivery ${job.deliveryId} (${event}): the link refresh failed (${error instanceof Error ? error.name : 'non-Error'})`)
  }
  if (!deps.budget.take(`${owner}/${repo}`.toLowerCase())) {
    throw new DeliveryError('transient', `pull ${number}: the GitHub reads of this repository are over the per-minute limit`)
  }
  const facts = await guarded(() => deps.github.pull(owner, repo, number), number)
  const checks = wantChecks && facts.kind === 'ok' && (event === 'pull_request' || facts.value.headSha === sha) ? await guarded(() => deps.github.checks(owner, repo, number, sha), number) : null
  const snapshot: Snapshot = { at: started, facts, checks }
  if (facts.kind === 'ok' && (!wantChecks || checks?.kind === 'ok')) {
    snapshots.delete(key)
    snapshots.set(key, snapshot)
    if (snapshots.size > SNAPSHOT_LIMIT) snapshots.delete(snapshots.keys().next().value as string)
  }
  return snapshot
}

/** The agent event of each tag that was added, sent once per tag. Runs after the commit, and never throws. */
function announceAdded(added: string[], card: TagCard, work: PullWork, deps: ReadyDeps, job: DeliveryJob): void {
  const kinds = new Set(added.map(tag => EVENT_OF_TAG[tag]).filter((kind): kind is GithubEventKind => kind !== undefined))
  for (const kind of kinds) {
    try {
      deps.announce({
        kind,
        board: card.board,
        task: { id: card.id, title: card.title, assigneeId: card.assigneeId, createdBy: card.createdBy, column: card.column },
        ref: refOf(work.number, work.headRef)
      })
    } catch (error) {
      console.error(`GitHub delivery ${job.deliveryId}: the ${kind} event was not sent (${error instanceof Error ? error.name : 'non-Error'}); the tags are saved`)
    }
  }
}

/**
 * Applies one pull request's work to each of its cards. A card that fails is recorded and the others still run; the
 * failures are thrown together at the end, as the syncer does. An abort stops the work at its next step.
 */
async function applyPull(owner: string, repo: string, work: PullWork, links: Map<string, TagRepoLink>, deps: ReadyDeps, job: DeliveryJob, failures: DeliveryError[]): Promise<void> {
  const { store, signal } = deps
  stopIfAborted(signal)
  // Issue keywords count only for a pull request of this repository, from an accepted author. Otherwise they are ignored.
  const keywords = closedIssuesOf(work.title, work.body)
  const accepted = work.sameRepo && work.author !== '' && [...links.values()].some(link => link.acceptedLogins.includes(work.author.toLowerCase()))
  if (!accepted && keywords.length) {
    console.warn(`GitHub delivery ${job.deliveryId}: closing keywords of pull ${work.number} ignored (not from an accepted login in this repository)`)
  }
  const found = await store.linkedCards(owner, repo, work.number, accepted ? closedIssuesOf(work.title, work.body) : [])
  if (!found.length) return
  const pullProjects = new Set(found.filter(item => item.kind === 'pull').map(item => item.card.projectId))
  const cards = new Map<string, { card: TagCard, link: TagRepoLink | undefined }>()
  for (const item of [...found].sort((a, b) => Number(b.kind === 'pull') - Number(a.kind === 'pull'))) {
    const link = links.get(item.card.projectId)
    const issueOk = item.kind === 'issue'
      && work.sameRepo
      && !!link
      && link.acceptedLogins.includes(work.author.toLowerCase())
      && (link.syncEnabled || pullProjects.has(item.card.projectId))
    if ((item.kind === 'pull' || issueOk) && !cards.has(item.card.id)) cards.set(item.card.id, { card: item.card, link })
  }

  const url = `https://github.com/${owner}/${repo}/pull/${work.number}`
  for (const { card, link } of [...cards.values()].slice(0, CARD_LIMIT)) {
    stopIfAborted(signal)
    const add = [
      ...mergeTagsOf({
        merged: work.merged,
        base: work.base,
        staging: link?.staging ?? [],
        production: link?.production ?? [],
        defaultBranch: work.defaultBranch
      }),
      ...(work.closedUnmerged ? [PR_CLOSED_TAG] : [])
    ]
    const drop = work.reopened ? [PR_CLOSED_TAG] : []
    let added: string[] | null = null
    try {
      added = await store.applyTags(card.id, (tags, colours) => planTags(tags, colours, { pipeline: work.pipeline, add, drop }), url)
    } catch (error) {
      if (error instanceof DeliveryAborted) throw error
      failures.push(classify(error, work.number))
      continue
    }
    // Outside the try: the tags are saved, so a failure to announce is logged and never fails (or repeats) the delivery.
    if (added?.length) announceAdded(added, card, work, deps, job)
  }
}

/**
 * Applies one queued delivery of pull_request, check_run or workflow_run. Returns `ignored` when nothing here applies
 * (another event or action, a bad payload, no card for the pull request, a 404 from GitHub) and `done` otherwise.
 * Throws a DeliveryError: transient for a GitHub or database failure (retried), permanent for an answer that cannot be
 * used. Called from processGithubDelivery (githubCards.ts) through the consumer.
 */
export async function processTagDelivery(job: DeliveryJob, deps: TagDeps): Promise<TagOutcome> {
  if (!(TAG_EVENTS as readonly string[]).includes(job.event)) return 'ignored'
  const owner = job.repoOwner
  const repo = job.repoName
  if (!NAME.test(owner) || !NAME.test(repo)) return 'ignored'
  if (!ownerAllowed(owner).ok) return 'ignored'
  const ready: ReadyDeps = {
    ...deps,
    github: deps.github ?? liveGithub,
    announce: deps.announce ?? announceGithubEvent,
    budget: deps.budget ?? (defaultBudget ??= readBudgetFromEnv()),
    refreshBudget: deps.refreshBudget ?? (defaultRefreshBudget ??= readBudgetFromEnv())
  }
  const { store, signal } = ready
  const failures: DeliveryError[] = []
  let handled = false

  // The works of this delivery: one per pull request it is about.
  const works: { number: number, sha: string, event: string, payload: unknown, work: (facts: PullFacts | null, checks: ChecksState | null) => PullWork | null, wantChecks: boolean, known?: { author: string, sameRepo: boolean } }[] = []
  if (job.event === 'pull_request') {
    const pull = pullRequestEvent(job.payload)
    if (!pull || !validCommitSha(pull.headSha)) return 'ignored'
    const closed = pull.action === 'closed'
    works.push({
      number: pull.number,
      sha: pull.headSha,
      event: job.event,
      payload: job.payload,
      wantChecks: PULL_ACTIONS.has(pull.action),
      known: { author: pull.author, sameRepo: pull.headRepo.toLowerCase() === `${owner}/${repo}`.toLowerCase() },
      work: (_facts, checks) => ({
        number: pull.number,
        sha: pull.headSha,
        headRef: pull.headRef,
        title: pull.title,
        body: pull.body,
        author: pull.author,
        sameRepo: pull.headRepo.toLowerCase() === `${owner}/${repo}`.toLowerCase(),
        pipeline: pipelineTagOf(checks),
        merged: closed && pull.merged,
        base: pull.base,
        defaultBranch: pull.defaultBranch,
        closedUnmerged: closed && !pull.merged,
        reopened: pull.action === 'reopened'
      })
    })
  } else {
    const run = runEvent(job.event, job.payload)
    if (!run || !validCommitSha(run.headSha)) return 'ignored'
    if (run.named > PULL_LIMIT) {
      console.warn(`GitHub delivery ${job.deliveryId} (${job.event}): ${run.named} pull requests named, the first ${PULL_LIMIT} are handled`)
    }
    for (const number of run.numbers) {
      works.push({
        number,
        sha: run.headSha,
        event: job.event,
        payload: job.payload,
        wantChecks: true,
        work: (facts, checks) => facts && checks
          ? {
              number,
              sha: run.headSha,
              headRef: facts.headRef,
              title: facts.title,
              body: facts.body,
              author: facts.author,
              sameRepo: facts.headRepo?.toLowerCase() === `${owner}/${repo}`.toLowerCase(),
              pipeline: pipelineTagOf(checks),
              merged: false,
              base: '',
              defaultBranch: '',
              closedUnmerged: false,
              reopened: false
            }
          : null
      })
    }
  }

  const links = new Map((await store.repoLinks(owner, repo)).map(link => [link.projectId, link]))
  for (const item of works) {
    stopIfAborted(signal)
    // Nothing here to tag: no card is linked to this pull request or to an issue of this repository. No GitHub read.
    if (!(await store.linkedAt(owner, repo, item.number))) continue
    // A stranger pull request that no card is linked to is not read at all: its keywords would be ignored anyway.
    const known = item.known
    if (known && !(known.sameRepo && [...links.values()].some(link => link.acceptedLogins.includes(known.author.toLowerCase()))) && !(await store.linkedCards(owner, repo, item.number, [])).some(found => found.kind === 'pull')) continue
    const snapshot = await snapshotOf(owner, repo, item.number, item.sha, item.wantChecks, item.event, item.payload, job, ready)
    if (snapshot.facts.kind === 'missing') continue
    if (snapshot.facts.kind !== 'ok') throw readFailure(item.number, 'the pull request could not be read', snapshot.facts)
    // A check or workflow run of a commit that is no longer the head says nothing about the pull request now.
    if (job.event !== 'pull_request' && snapshot.facts.value.headSha !== item.sha) continue
    let checks: ChecksState | null = null
    if (item.wantChecks) {
      const read = snapshot.checks
      if (!read || read.kind === 'missing') continue
      if (read.kind !== 'ok') throw readFailure(item.number, 'the check runs could not be read', read)
      checks = read.value
    }
    const work = item.work(snapshot.facts.value, checks)
    if (!work) continue
    await applyPull(owner, repo, work, links, ready, job, failures)
    handled = true
  }

  if (failures.length) {
    const kind = failures.some(failure => failure.kind === 'transient') ? 'transient' : 'permanent'
    throw new DeliveryError(kind, failures.map(failure => failure.reason).join('; '))
  }
  return handled ? 'done' : 'ignored'
}

// ─── The database store ──────────────────────────────────────────────────────

export function makeDatabaseTagStore(database: typeof db): TagStore {
  return {
    async repoLinks(owner, repo) {
      const rows = await database.select({
        projectId: projectGithubRepos.projectId,
        syncEnabled: projectGithubRepos.syncEnabled,
        stagingBranches: projectGithubRepos.stagingBranches,
        productionBranches: projectGithubRepos.productionBranches,
        acceptedLogins: projectGithubRepos.acceptedLogins
      })
        .from(projectGithubRepos)
        .where(and(
          sql`lower(${projectGithubRepos.owner}) = ${owner.toLowerCase()}`,
          sql`lower(${projectGithubRepos.repo}) = ${repo.toLowerCase()}`
        ))
      return rows.map(row => ({
        projectId: row.projectId,
        syncEnabled: row.syncEnabled,
        staging: branchesOf(row.stagingBranches),
        production: branchesOf(row.productionBranches),
        acceptedLogins: row.acceptedLogins.map(login => login.toLowerCase())
      }))
    },

    async linkedAt(owner, repo, number) {
      const [row] = await database.select({ id: githubLinks.id })
        .from(githubLinks)
        .where(and(
          sql`lower(${githubLinks.owner}) = ${owner.toLowerCase()}`,
          sql`lower(${githubLinks.repo}) = ${repo.toLowerCase()}`,
          or(
            and(eq(githubLinks.kind, 'pull'), eq(githubLinks.ref, String(number))),
            eq(githubLinks.kind, 'issue')
          )
        ))
        .limit(1)
      return row !== undefined
    },

    async linkedCards(owner, repo, number, issues) {
      const conditions = [
        and(eq(githubLinks.kind, 'pull'), eq(githubLinks.ref, String(number))),
        issues.length ? and(eq(githubLinks.kind, 'issue'), inArray(githubLinks.ref, issues.map(String))) : undefined
      ].filter((condition): condition is SQL => condition !== undefined)
      const rows = await database.select({
        kind: githubLinks.kind,
        task: projectTasks,
        column: projectColumns.name,
        userId: projects.userId,
        teamId: projects.teamId,
        customerId: projects.customerId
      })
        .from(githubLinks)
        .innerJoin(projectTasks, eq(projectTasks.id, githubLinks.taskId))
        .innerJoin(projectColumns, eq(projectColumns.id, projectTasks.columnId))
        .innerJoin(projects, eq(projects.id, projectTasks.projectId))
        .where(and(
          sql`lower(${githubLinks.owner}) = ${owner.toLowerCase()}`,
          sql`lower(${githubLinks.repo}) = ${repo.toLowerCase()}`,
          or(...conditions),
          isNull(projectTasks.deletedAt)
        ))
      return rows.map((row): LinkedCard => ({
        kind: row.kind === 'pull' ? 'pull' : 'issue',
        card: {
          id: row.task.id,
          projectId: row.task.projectId,
          title: row.task.title,
          board: { id: row.task.projectId, userId: row.userId, teamId: row.teamId, customerId: row.customerId },
          assigneeId: row.task.assigneeId,
          createdBy: row.task.createdBy,
          column: row.column
        }
      }))
    },

    async applyTags(cardId, plan, url) {
      const result = {} as { added?: string[], projectId?: string, userId?: string, teamId?: string | null }
      await database.transaction(async (tx) => {
        // The card's row is locked for the read and the write, so two deliveries cannot plan from the same tags.
        const [row] = await tx.select({ projectId: projectTasks.projectId, tags: projectTasks.tags })
          .from(projectTasks)
          .where(eq(projectTasks.id, cardId))
          .for('update')
          .limit(1)
        if (!row) return
        const [project] = await tx.select({ userId: projects.userId, teamId: projects.teamId, labelColors: projects.labelColors })
          .from(projects)
          .where(eq(projects.id, row.projectId))
          .limit(1)
        if (!project) return
        const colours = project.labelColors ?? {}
        const change = plan(row.tags, colours)
        if (!change) return
        const now = Date.now()
        await tx.update(projectTasks).set({ tags: change.tags, updatedAt: now }).where(eq(projectTasks.id, cardId))
        // Only the colours of the new tags are merged in, in the database: a colour a person saves meanwhile is kept.
        const newColours = Object.fromEntries(Object.entries(change.colours).filter(([tag]) => !(tag in colours)))
        if (Object.keys(newColours).length) {
          await tx.update(projects)
            .set({ labelColors: sql`((${projects.labelColors})::jsonb || ${JSON.stringify(newColours)}::jsonb)::json` })
            .where(eq(projects.id, row.projectId))
        }
        // One activity line per tag, written by GitHub, with the pull request link: the same change, the same transaction.
        const lines = [
          ...change.remove.map(tag => ({ from: tag })),
          ...change.add.map(tag => ({ to: tag }))
        ]
        if (lines.length) {
          await tx.insert(taskActivity).values(lines.map((detail, index) => ({
            id: randomUUID(),
            taskId: cardId,
            projectId: row.projectId,
            actorId: null,
            via: 'github' as const,
            kind: 'label' as const,
            detail: { ...detail, url },
            createdAt: now + index
          })))
        }
        result.added = change.add
        result.projectId = row.projectId
        result.userId = project.userId
        result.teamId = project.teamId
      })
      if (result.added === undefined || result.projectId === undefined || result.userId === undefined) return null
      try {
        // The board refresh is sent after the change is saved. A failure here cannot undo it, so it is logged only.
        await publish(workspaceTopic(result.userId, result.teamId ?? null), { type: 'board', projectId: result.projectId })
      } catch (error) {
        console.error(`GitHub tags: the change is saved, but the board refresh was not sent (${error instanceof Error ? error.name : 'non-Error'})`)
      }
      return result.added
    }
  }
}

export const databaseTagStore: TagStore = makeDatabaseTagStore(db)
