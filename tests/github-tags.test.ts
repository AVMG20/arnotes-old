/* eslint-disable @typescript-eslint/no-explicit-any -- payloads are read loosely: each test changes the field it names */
// The GitHub tags of a card (GH3): pipeline and merge tags from pull_request, check_run and workflow_run deliveries.
// Run against recorded payloads in tests/fixtures/github/, a fake store and fake GitHub answers. No database, no network.
//   node --import tsx --test tests/github-tags.test.ts
import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import type { H3Event } from 'h3'
import { DeliveryAborted, DeliveryError, processGithubDelivery } from '../server/utils/githubCards'
import type { DeliveryJob } from '../server/utils/githubCards'
import { checksOf, readAllCheckRuns, readChecksOfHead, validCommitSha } from '../server/utils/githubSync'
import type { ChecksState, GithubRead, PullFacts } from '../server/utils/githubSync'
import type { GithubEventInput } from '../server/utils/agentEvents'
import {
  branchesOf, closedIssuesOf, mergeTagsOf, pipelineTagOf, planTags, processTagDelivery, readBudgetFromEnv, ReadBudget,
  refOf, resetTagReads, TAG_COLOURS
} from '../server/utils/githubTags'
import type { LinkedCard, TagCard, TagGithub, TagRepoLink, TagStore } from '../server/utils/githubTags'
import { closeDeliveryQueue, getDeliveryQueue } from '../server/utils/githubDeliveryQueue'
import type { MemoryDeliveryQueue } from '../server/utils/githubDeliveryQueueMemory'
import webhook from '../server/api/github/webhook.post'
import { db } from '../server/db'

const NOW = 1_800_000_000_000
const OWNER = 'example-owner'
const REPO = 'example-repo'
const HEAD = '3f9c1d0e7b2a4c5d6e8f9a0b1c2d3e4f5a6b7c8d'
const OLD_HEAD = 'a'.repeat(40)

function fixture(name: string, change?: ((payload: any) => void) | Record<string, unknown>): any {
  const payload = JSON.parse(readFileSync(new URL(`./fixtures/github/${name}.json`, import.meta.url), 'utf8'))
  if (typeof change === 'function') change(payload)
  else for (const [path, value] of Object.entries(change ?? {})) setPath(payload, path, value)
  return payload
}

function setPath(target: any, path: string, value: unknown): void {
  const keys = path.split('.')
  const last = keys.pop()!
  let node = target
  for (const key of keys) node = node[key]
  node[last] = value
}

function jobOf(event: string, payload: unknown, deliveryId = 'delivery-1', receivedAt = NOW): DeliveryJob {
  return { deliveryId, event, repoOwner: OWNER, repoName: REPO, repoId: 2, payload, receivedAt, firstSeenAt: receivedAt, attempt: 0 }
}

const ok = <T>(value: T): GithubRead<T> => ({ kind: 'ok', value })
const MISSING: GithubRead<never> = { kind: 'missing' }
const TRANSIENT: GithubRead<never> = { kind: 'transient', reason: 'GitHub did not answer' }
const MALFORMED: GithubRead<never> = { kind: 'malformed', reason: 'GitHub sent no head commit' }

// ── A fake store: the answers the database gives, with the writes and the closing keywords it was asked for ──

interface FakeCard { id: string, projectId: string, title: string, tags: string[], column: string, trashed?: boolean, failWrites?: boolean }
interface FakeLink { cardId: string, kind: 'pull' | 'issue', ref: string }
interface FakeStore extends TagStore {
  cards: Map<string, FakeCard>
  colours: Map<string, Record<string, string>>
  activity: { cardId: string, detail: Record<string, unknown> }[]
  writes: number
  askedIssues: number[][]
}

function fakeStore(options: { cards?: FakeCard[], links?: FakeLink[], repos?: TagRepoLink[] } = {}): FakeStore {
  const cards = new Map((options.cards ?? []).map(card => [card.id, { ...card }]))
  const links = options.links ?? []
  const repos = options.repos ?? []
  const store: FakeStore = {
    cards,
    colours: new Map(),
    activity: [],
    writes: 0,
    askedIssues: [],
    async repoLinks() {
      return repos
    },
    async linkedAt(_owner, _repo, number) {
      return links.some(link => link.kind === 'issue' || link.ref === String(number))
    },
    async linkedCards(_owner, _repo, number, issues) {
      store.askedIssues.push(issues)
      const found: LinkedCard[] = []
      for (const link of links) {
        const wanted = (link.kind === 'pull' && link.ref === String(number)) || (link.kind === 'issue' && issues.includes(Number(link.ref)))
        const card = cards.get(link.cardId)
        if (!wanted || !card || card.trashed) continue
        found.push({
          kind: link.kind,
          card: {
            id: card.id,
            projectId: card.projectId,
            title: card.title,
            board: { id: card.projectId, userId: 'owner-1', teamId: null, customerId: null },
            assigneeId: null,
            createdBy: null,
            column: card.column
          } satisfies TagCard
        })
      }
      return found
    },
    async applyTags(cardId, plan, url) {
      const card = cards.get(cardId)
      if (!card) return null
      if (card.failWrites) throw new Error('the database did not answer')
      const colours = store.colours.get(card.projectId) ?? {}
      const change = plan(card.tags, colours)
      if (!change) return null
      card.tags = change.tags
      store.colours.set(card.projectId, change.colours)
      for (const tag of change.remove) store.activity.push({ cardId, detail: { from: tag, url } })
      for (const tag of change.add) store.activity.push({ cardId, detail: { to: tag, url } })
      store.writes++
      return change.add
    }
  }
  return store
}

// ── GitHub's answers ───────────────────────────────────────────────────────────

function pullFacts(overrides: Partial<PullFacts> = {}): PullFacts {
  return {
    headSha: HEAD,
    headRef: 'feature/export-button',
    headRepo: `${OWNER}/${REPO}`,
    author: OWNER,
    title: 'Fixes #24: rename the export button',
    body: 'Closes #25.',
    state: 'open',
    merged: false,
    ...overrides
  }
}

interface FakeGithub extends TagGithub {
  calls: { pull: number, checks: number, refresh: number }
}

function fakeGithub(options: { pull?: GithubRead<PullFacts> | (() => GithubRead<PullFacts>), checks?: Record<string, GithubRead<ChecksState>> | ((sha: string) => GithubRead<ChecksState>), refreshThrows?: boolean } = {}): FakeGithub {
  const calls = { pull: 0, checks: 0, refresh: 0 }
  return {
    calls,
    async pull() {
      calls.pull++
      const answer = options.pull ?? ok(pullFacts())
      return typeof answer === 'function' ? answer() : answer
    },
    async checks(_owner, _repo, _number, sha) {
      calls.checks++
      const answer = options.checks ?? {}
      if (typeof answer === 'function') return answer(sha)
      return answer[sha] ?? ok('none')
    },
    async refresh() {
      calls.refresh++
      if (options.refreshThrows) throw new Error('the refresh broke')
    }
  }
}

/** The state GitHub reports for a list of check runs, through the same aggregation the link panel uses. */
const runsState = (runs: { name: string, status: string, conclusion: string | null }[]): GithubRead<ChecksState> => ok(checksOf(runs as any).state)
const checkRun = (conclusion: string | null, status = 'completed', name = 'unit tests') => ({ name, status, conclusion })

// The link rows of the pull request's card and of the two issues it closes (#24 and #25), in one project.
const PULL_CARD: FakeCard = { id: 'card-pr', projectId: 'project-a', title: '[GH #31] PR card', tags: [], column: 'Verify' }
const ISSUE_24: FakeCard = { id: 'card-24', projectId: 'project-a', title: '[GH #24] Export button', tags: [], column: 'In progress' }
const ISSUE_25: FakeCard = { id: 'card-25', projectId: 'project-a', title: '[GH #25] Export label', tags: [], column: 'To do' }
const LINKS: FakeLink[] = [
  { cardId: 'card-pr', kind: 'pull', ref: '31' },
  { cardId: 'card-24', kind: 'issue', ref: '24' },
  { cardId: 'card-25', kind: 'issue', ref: '25' }
]
const SYNCED: TagRepoLink = { projectId: 'project-a', syncEnabled: true, staging: [], production: [], acceptedLogins: [OWNER] }

function standardStore(extra: Partial<Parameters<typeof fakeStore>[0]> = {}) {
  return fakeStore({
    cards: [PULL_CARD, ISSUE_24, ISSUE_25].map(card => ({ ...card })),
    links: LINKS,
    repos: [SYNCED],
    ...extra
  })
}

function eventsOf(list: GithubEventInput[]) {
  return list.map(event => ({ kind: event.kind, card: event.task.id, ref: event.ref }))
}

/** One delivery through the tag work, with a budget that does not run out unless the test says so. */
function run(job: DeliveryJob, store: FakeStore, github: FakeGithub, events: GithubEventInput[] = [], extra: { budget?: ReadBudget, announce?: (input: GithubEventInput) => void } = {}) {
  return processTagDelivery(job, {
    store,
    github,
    budget: extra.budget ?? new ReadBudget(10_000),
    refreshBudget: new ReadBudget(10_000),
    announce: extra.announce ?? (event => events.push(event))
  })
}

beforeEach(() => {
  resetTagReads()
})

// ── The pure decisions ───────────────────────────────────────────────────────

test('the pipeline tag follows the checks state: failing, running, passing, and none is no change', () => {
  assert.equal(pipelineTagOf('failing'), 'pipeline failed')
  assert.equal(pipelineTagOf('running'), 'pipeline running')
  assert.equal(pipelineTagOf('passing'), 'pipeline passed')
  assert.equal(pipelineTagOf('none'), null)
  assert.equal(pipelineTagOf(null), null)
})

test('the checks conclusions: success, neutral and skipped pass; failure and cancelled fail; a pending run is running', () => {
  const state = (runs: { name: string, status: string, conclusion: string | null }[]) => checksOf(runs as any).state
  assert.equal(state([checkRun('success'), checkRun('neutral'), checkRun('skipped')]), 'passing')
  assert.equal(state([checkRun('success'), checkRun('failure')]), 'failing')
  assert.equal(state([checkRun('success'), checkRun('cancelled')]), 'failing')
  assert.equal(state([checkRun('success'), checkRun(null, 'in_progress')]), 'running')
  // A failure beside a pending run is a failure: the pipeline has failed, whatever else is still going.
  assert.equal(state([checkRun('failure'), checkRun(null, 'queued')]), 'failing')
})

test('the issues a pull request closes: closing keywords before #N, distinct, and not cross-repository', () => {
  assert.deepEqual(closedIssuesOf('Fixes #24: rename', 'Closes #25.'), [24, 25])
  assert.deepEqual(closedIssuesOf('fixed #7', 'Resolves: #7 and Closes #8'), [7, 8])
  assert.deepEqual(closedIssuesOf('Fixes example-owner/other#9', 'see #10, relates to #11'), [])
  assert.deepEqual(closedIssuesOf('Mentions #12', 'no keyword here'), [])
})

test('the staging and production settings are comma lists of valid branch names', () => {
  assert.deepEqual(branchesOf('staging, release/1.x, bad name!, '), ['staging', 'release/1.x'])
  assert.deepEqual(branchesOf(''), [])
})

test('merge tags: staging by name, production by name or the default branch when none is named, otherwise none', () => {
  const base = { merged: true, staging: ['staging'], production: [], defaultBranch: 'main' }
  assert.deepEqual(mergeTagsOf({ ...base, base: 'staging' }), ['merged staging'])
  assert.deepEqual(mergeTagsOf({ ...base, base: 'main' }), ['merged production'])
  assert.deepEqual(mergeTagsOf({ ...base, base: 'feature/x' }), [])
  assert.deepEqual(mergeTagsOf({ ...base, merged: false, base: 'main' }), [])
  assert.deepEqual(mergeTagsOf({ ...base, production: ['release'], base: 'main' }), [])
  assert.deepEqual(mergeTagsOf({ ...base, base: '' }), [])
})

test('branch names are compared exactly: Staging is not the staging branch', () => {
  assert.deepEqual(mergeTagsOf({ merged: true, base: 'Staging', staging: ['staging'], production: [], defaultBranch: 'main' }), [])
})

test('the ref names the pull request and its branch, cut to 60 characters; a branch that is not a plain name is left out', () => {
  assert.equal(refOf(31, 'feature/export-button'), '#31 feature/export-button')
  assert.equal(refOf(31, 'x\n<b>bold</b>'), '#31')
  assert.equal(refOf(31, 'a'.repeat(100)).length, 60)
})

test('a plan replaces the other pipeline tags, adds what is missing, and makes no change when nothing differs', () => {
  const plan = planTags(['other', 'pipeline failed'], {}, { pipeline: 'pipeline running', add: [] })
  assert.deepEqual(plan?.remove, ['pipeline failed'])
  assert.deepEqual(plan?.add, ['pipeline running'])
  assert.deepEqual(plan?.tags, ['other', 'pipeline running'])
  assert.equal(plan?.colours['pipeline running'], 'sky')
  assert.equal(planTags(['pipeline passed'], {}, { pipeline: 'pipeline passed', add: [] }), null)
  // A colour the board already has is kept.
  assert.equal(planTags([], { 'pr closed': 'pink' }, { pipeline: null, add: ['pr closed'] })?.colours['pr closed'], 'pink')
  // No pipeline tag wanted: the other pipeline tags stay as they are.
  assert.equal(planTags(['pipeline failed'], {}, { pipeline: null, add: ['merged staging'] })?.remove.length, 0)
})

test('reopening drops pr closed; the colour map of the tags is frozen', () => {
  const plan = planTags(['pr closed', 'keep'], {}, { pipeline: null, add: [], drop: ['pr closed'] })
  assert.deepEqual(plan?.remove, ['pr closed'])
  assert.deepEqual(plan?.tags, ['keep'])
  assert.equal(Object.isFrozen(TAG_COLOURS), true)
})

test('a full commit id is lower-case hex of 40 or 64 characters; anything else never reaches a URL', () => {
  assert.equal(validCommitSha(HEAD), true)
  assert.equal(validCommitSha('a'.repeat(64)), true)
  assert.equal(validCommitSha('A'.repeat(40)), false)
  assert.equal(validCommitSha('abc'), false)
  assert.equal(validCommitSha('../../orgs/x'), false)
  assert.equal(validCommitSha(null), false)
})

test('the read budget: a per-repository window, and bad values of the environment fall back to 60', () => {
  const budget = new ReadBudget(2, () => NOW)
  assert.equal(budget.take('r'), true)
  assert.equal(budget.take('r'), true)
  assert.equal(budget.take('r'), false)
  assert.equal(budget.take('other'), true)
  assert.equal(new ReadBudget(2, () => NOW + 60_000).take('r'), true)
  const fallback = (value: string) => {
    const probe = readBudgetFromEnv({ GITHUB_TAG_READS_PER_MINUTE: value } as NodeJS.ProcessEnv)
    let count = 0
    while (probe.take('r')) count++
    return count
  }
  assert.equal(fallback('abc'), 60)
  assert.equal(fallback('0'), 60)
  assert.equal(fallback('1.5'), 60)
  assert.equal(fallback('100001'), 60)
  assert.equal(fallback('5'), 5)
})

// ── GitHub's reads: pages, the state of a partial list, and the answers that fail ─────────

function pagedRuns(total: number, failingOn?: number): (n: number) => Promise<GithubRead<{ check_runs?: unknown, total_count?: unknown }>> {
  return async (n) => {
    const start = (n - 1) * 100
    const size = Math.max(0, Math.min(100, total - start))
    const runs = Array.from({ length: size }, (_, index) => {
      const number = start + index
      return { name: `check ${number}`, status: 'completed', conclusion: number === failingOn ? 'failure' : 'success' }
    })
    return ok({ check_runs: runs, total_count: total })
  }
}

test('150 check runs over two pages are all read, and one failing run on page 2 makes the state failing', async () => {
  const read = await readAllCheckRuns(pagedRuns(150, 120))
  assert.equal(read.kind, 'ok')
  assert.equal((read as { value: unknown[] }).value.length, 150)
  assert.equal(checksOf((read as { value: any[] }).value).state, 'failing')
})

test('a check list shorter than GitHub names is unknown: transient, never passing', async () => {
  const short = async (n: number) => (n === 1 ? pagedRuns(150)(1) : ok({ check_runs: [], total_count: 150 }))
  const read = await readAllCheckRuns(short)
  assert.equal(read.kind, 'transient')
})

test('more check runs than the ten pages hold are unknown too', async () => {
  const read = await readAllCheckRuns(pagedRuns(1200))
  assert.equal(read.kind, 'transient')
})

test('a check run without a name or status, or a list without its count, is malformed', async () => {
  assert.equal((await readAllCheckRuns(async () => ok({ check_runs: [{ status: 'completed' }], total_count: 1 }))).kind, 'malformed')
  assert.equal((await readAllCheckRuns(async () => ok({ check_runs: [] }))).kind, 'malformed')
})

test('a head commit that is not a commit id is never read from GitHub', async () => {
  assert.equal((await readChecksOfHead(OWNER, REPO, 31, '../../x')).kind, 'malformed')
})

// ── The work, on recorded deliveries ─────────────────────────────────────────

test('a pull request opened with a failing pipeline: the card and its two closed issues get the failed tag, one event each', async () => {
  const store = standardStore()
  const github = fakeGithub({ checks: { [HEAD]: runsState([checkRun('failure')]) } })
  const events: GithubEventInput[] = []
  const outcome = await run(jobOf('pull_request', fixture('pull-request-opened')), store, github, events)
  assert.equal(outcome, 'done')
  for (const id of ['card-pr', 'card-24', 'card-25']) assert.deepEqual(store.cards.get(id)!.tags, ['pipeline failed'])
  assert.deepEqual(eventsOf(events).map(e => e.kind), ['pipeline_failed', 'pipeline_failed', 'pipeline_failed'])
  assert.equal(events[0]!.ref, '#31 feature/export-button')
  assert.equal(store.activity.filter(line => line.detail.to === 'pipeline failed').length, 3)
  assert.equal(store.activity[0]!.detail.url, `https://github.com/${OWNER}/${REPO}/pull/31`)
  assert.equal(store.colours.get('project-a')!['pipeline failed'], 'red')
})

test('failed, then running, then passed on one pull request: exactly one pipeline tag at each step', async () => {
  const store = standardStore({ cards: [{ ...PULL_CARD }], links: [{ cardId: 'card-pr', kind: 'pull', ref: '31' }] })
  const runs: Record<string, GithubRead<ChecksState>> = { [HEAD]: runsState([checkRun('failure')]) }
  const github = fakeGithub({ checks: runs })
  const events: GithubEventInput[] = []
  const deliver = (payload: unknown, id: string) => run(jobOf('check_run', payload, id), store, github, events)

  await deliver(fixture('check-run-completed'), 'd-failed')
  assert.deepEqual(store.cards.get('card-pr')!.tags, ['pipeline failed'])

  runs[HEAD] = runsState([checkRun(null, 'in_progress')])
  await deliver(fixture('check-run-completed', { 'action': 'rerequested', 'check_run.status': 'in_progress', 'check_run.conclusion': null }), 'd-rerun')
  assert.deepEqual(store.cards.get('card-pr')!.tags, ['pipeline running'])

  runs[HEAD] = runsState([checkRun('success')])
  await deliver(fixture('check-run-completed', { 'check_run.conclusion': 'success' }), 'd-passed')
  assert.deepEqual(store.cards.get('card-pr')!.tags, ['pipeline passed'])
  assert.deepEqual(eventsOf(events).map(e => e.kind), ['pipeline_failed', 'pipeline_passed'])
})

test('check runs: each conclusion is read from the head commit, and only a changed tag writes and announces', async () => {
  const cases: [string | null, string, string | null][] = [
    ['success', 'completed', 'pipeline passed'],
    ['failure', 'completed', 'pipeline failed'],
    ['neutral', 'completed', 'pipeline passed'],
    ['skipped', 'completed', 'pipeline passed'],
    ['cancelled', 'completed', 'pipeline failed'],
    [null, 'in_progress', 'pipeline running']
  ]
  for (const [conclusion, status, expected] of cases) {
    const store = standardStore({ cards: [{ ...PULL_CARD }], links: [{ cardId: 'card-pr', kind: 'pull', ref: '31' }] })
    const github = fakeGithub({ checks: { [HEAD]: runsState([checkRun(conclusion, status)]) } })
    const events: GithubEventInput[] = []
    await run(jobOf('check_run', fixture('check-run-completed', { 'check_run.conclusion': conclusion, 'check_run.status': status })), store, github, events)
    assert.deepEqual(store.cards.get('card-pr')!.tags, [expected], `${conclusion}/${status}`)
    assert.equal(events.length, expected === 'pipeline running' ? 0 : 1, `events for ${conclusion}/${status}`)
  }
})

test('workflow runs: in progress is running, completed with a failing job is failed', async () => {
  const store = standardStore({ cards: [{ ...PULL_CARD }], links: [{ cardId: 'card-pr', kind: 'pull', ref: '31' }] })
  const runs: Record<string, GithubRead<ChecksState>> = { [HEAD]: runsState([checkRun(null, 'in_progress', 'build')]) }
  const github = fakeGithub({ checks: runs })
  await run(jobOf('workflow_run', fixture('workflow-run-completed', { 'action': 'in_progress', 'workflow_run.status': 'in_progress', 'workflow_run.conclusion': null })), store, github)
  assert.deepEqual(store.cards.get('card-pr')!.tags, ['pipeline running'])
  runs[HEAD] = runsState([checkRun('failure', 'completed', 'build')])
  await run(jobOf('workflow_run', fixture('workflow-run-completed')), store, github)
  assert.deepEqual(store.cards.get('card-pr')!.tags, ['pipeline failed'])
})

test('mixed results on one commit: any failure makes the pipeline failed, a pending run keeps it failed', async () => {
  const store = standardStore({ cards: [{ ...PULL_CARD }], links: [{ cardId: 'card-pr', kind: 'pull', ref: '31' }] })
  const runs = [checkRun('success', 'completed', 'lint'), checkRun('failure', 'completed', 'tests'), checkRun(null, 'queued', 'deploy preview')]
  const github = fakeGithub({ checks: { [HEAD]: runsState(runs) } })
  await run(jobOf('check_run', fixture('check-run-completed', { 'check_run.name': 'deploy preview', 'check_run.conclusion': null, 'check_run.status': 'queued' })), store, github)
  assert.deepEqual(store.cards.get('card-pr')!.tags, ['pipeline failed'])
})

test('a pull request that closes two issues: both issue cards get the passed tag, and a running tag is replaced', async () => {
  const store = standardStore()
  store.cards.get('card-24')!.tags = ['pipeline running', 'keep me']
  const github = fakeGithub({ checks: { [HEAD]: runsState([checkRun('success')]) } })
  await run(jobOf('pull_request', fixture('pull-request-opened')), store, github)
  assert.deepEqual(store.cards.get('card-24')!.tags, ['keep me', 'pipeline passed'])
  assert.deepEqual(store.cards.get('card-25')!.tags, ['pipeline passed'])
})

test('a merge into the staging branch adds merged staging with one event, and the other tags are kept', async () => {
  const store = standardStore({ repos: [{ ...SYNCED, staging: ['staging'] }] })
  store.cards.get('card-pr')!.tags = ['pipeline passed', 'urgent']
  const events: GithubEventInput[] = []
  const github = fakeGithub()
  await run(jobOf('pull_request', fixture('pull-request-closed-merged', { 'pull_request.base.ref': 'staging' })), store, github, events)
  assert.deepEqual(store.cards.get('card-pr')!.tags, ['pipeline passed', 'urgent', 'merged staging'])
  assert.deepEqual(eventsOf(events).map(e => e.kind), ['merged_staging', 'merged_staging', 'merged_staging'])
  assert.equal(events.filter(e => e.task.id === 'card-pr').length, 1)
  assert.equal(github.calls.checks, 0, 'a closed pull request needs no check read')
})

test('a merge into production, with no production branch named, is the default branch: merged production', async () => {
  const store = standardStore()
  const events: GithubEventInput[] = []
  await run(jobOf('pull_request', fixture('pull-request-closed-merged')), store, fakeGithub(), events)
  assert.deepEqual(store.cards.get('card-pr')!.tags, ['merged production'])
  assert.deepEqual(events.map(e => e.kind).sort(), ['merged_production', 'merged_production', 'merged_production'])
})

test('a merge into another branch adds no merge tag and no event; a close without merge adds pr closed', async () => {
  const other = standardStore()
  const otherEvents: GithubEventInput[] = []
  await run(jobOf('pull_request', fixture('pull-request-closed-merged', { 'pull_request.base.ref': 'feature/other' })), other, fakeGithub(), otherEvents)
  assert.deepEqual(other.cards.get('card-pr')!.tags, [])
  assert.equal(otherEvents.length, 0)

  const closed = standardStore()
  const closedEvents: GithubEventInput[] = []
  await run(jobOf('pull_request', fixture('pull-request-closed-unmerged')), closed, fakeGithub(), closedEvents)
  assert.deepEqual(closed.cards.get('card-pr')!.tags, ['pr closed'])
  assert.equal(closedEvents.length, 0)
})

test('reopening removes pr closed, with no event and one activity line', async () => {
  const store = standardStore({ cards: [{ ...PULL_CARD, tags: ['pr closed'] }], links: [{ cardId: 'card-pr', kind: 'pull', ref: '31' }] })
  const events: GithubEventInput[] = []
  await run(jobOf('pull_request', fixture('pull-request-opened', { action: 'reopened' })), store, fakeGithub({ checks: { [HEAD]: ok('none') } }), events)
  assert.deepEqual(store.cards.get('card-pr')!.tags, [])
  assert.equal(store.activity.filter(line => line.detail.from === 'pr closed').length, 1)
  assert.equal(events.length, 0)
})

test('a double close writes once: the second delivery of a closed pull request changes nothing', async () => {
  const store = standardStore({ cards: [{ ...PULL_CARD }], links: [{ cardId: 'card-pr', kind: 'pull', ref: '31' }] })
  const github = fakeGithub()
  await run(jobOf('pull_request', fixture('pull-request-closed-unmerged'), 'd-close-1'), store, github)
  const writes = store.writes
  await run(jobOf('pull_request', fixture('pull-request-closed-unmerged'), 'd-close-2'), store, github)
  assert.equal(store.writes, writes)
  assert.deepEqual(store.cards.get('card-pr')!.tags, ['pr closed'])
})

test('a card in another project is not tagged unless its project links the repository with sync on, or the pull request itself', async () => {
  const store = standardStore({
    cards: [
      { ...PULL_CARD },
      { id: 'card-b', projectId: 'project-b', title: 'Other project issue', tags: [], column: 'To do' },
      { id: 'card-c', projectId: 'project-c', title: 'Synced project issue', tags: [], column: 'To do' }
    ],
    links: [
      { cardId: 'card-pr', kind: 'pull', ref: '31' },
      { cardId: 'card-b', kind: 'issue', ref: '24' },
      { cardId: 'card-c', kind: 'issue', ref: '24' }
    ],
    repos: [
      SYNCED,
      { projectId: 'project-b', syncEnabled: false, staging: [], production: [], acceptedLogins: [OWNER] },
      { projectId: 'project-c', syncEnabled: true, staging: [], production: [], acceptedLogins: [OWNER] }
    ]
  })
  await run(jobOf('pull_request', fixture('pull-request-opened')), store, fakeGithub({ checks: { [HEAD]: runsState([checkRun('success')]) } }))
  assert.deepEqual(store.cards.get('card-b')!.tags, [])
  assert.deepEqual(store.cards.get('card-c')!.tags, ['pipeline passed'])
  assert.deepEqual(store.cards.get('card-pr')!.tags, ['pipeline passed'])
})

test('a trashed card is left alone', async () => {
  const store = standardStore({ cards: [{ ...PULL_CARD, trashed: true }], links: [{ cardId: 'card-pr', kind: 'pull', ref: '31' }] })
  await run(jobOf('pull_request', fixture('pull-request-closed-unmerged')), store, fakeGithub())
  assert.deepEqual(store.cards.get('card-pr')!.tags, [])
})

test('a pull request with no card is a no-op: no error, no GitHub read, no write', async () => {
  const store = fakeStore()
  const github = fakeGithub({ checks: { [HEAD]: runsState([checkRun('failure')]) } })
  assert.equal(await run(jobOf('check_run', fixture('check-run-completed')), store, github), 'ignored')
  assert.equal(await run(jobOf('pull_request', fixture('pull-request-opened')), store, github), 'ignored')
  assert.equal(github.calls.pull + github.calls.checks + github.calls.refresh, 0)
  assert.equal(store.writes, 0)
})

// ── Who may tag the issue cards ────────────────────────────────────────────────

test('a stranger with a Fixes #24 in the title: the pull card is tagged, the issue cards are not', async () => {
  const store = standardStore()
  const github = fakeGithub({ pull: ok(pullFacts({ author: 'stranger-example' })), checks: { [HEAD]: runsState([checkRun('failure')]) } })
  await run(jobOf('pull_request', fixture('pull-request-opened', { 'pull_request.user.login': 'stranger-example' })), store, github)
  assert.deepEqual(store.cards.get('card-pr')!.tags, ['pipeline failed'])
  assert.deepEqual(store.cards.get('card-24')!.tags, [])
  assert.deepEqual(store.cards.get('card-25')!.tags, [])
  assert.ok(store.askedIssues.every(issues => issues.length === 0), 'the keywords were not even asked for')
})

test('a stranger pull request that no card is linked to is not read at all, keywords and all', async () => {
  const store = standardStore({ links: [{ cardId: 'card-24', kind: 'issue', ref: '24' }, { cardId: 'card-25', kind: 'issue', ref: '25' }] })
  const github = fakeGithub()
  const budget = new ReadBudget(1)
  const job = jobOf('pull_request', fixture('pull-request-opened', { 'pull_request.user.login': 'stranger-example', 'pull_request.title': 'Fixes #24: rename the export button' }))
  assert.equal(await run(job, store, github, [], { budget }), 'ignored')
  assert.equal(github.calls.pull + github.calls.checks + github.calls.refresh, 0)
  assert.equal(budget.take(`${OWNER}/${REPO}`.toLowerCase()), true, 'no read was taken from the budget')
  assert.deepEqual(store.cards.get('card-24')!.tags, [])
})

test('a fork pull request with the keyword, from an accepted login: no issue tags and no issue event', async () => {
  const store = standardStore()
  const events: GithubEventInput[] = []
  const github = fakeGithub({ checks: { [HEAD]: runsState([checkRun('failure')]) } })
  await run(jobOf('pull_request', fixture('pull-request-opened', { 'pull_request.head.repo.full_name': 'someone/example-repo' })), store, github, events)
  assert.deepEqual(store.cards.get('card-24')!.tags, [])
  assert.deepEqual(store.cards.get('card-25')!.tags, [])
  assert.equal(events.some(event => event.task.id !== 'card-pr'), false)
})

test('a fork pull request that the board linked: its own card is tagged, from the link alone', async () => {
  const store = standardStore()
  await run(jobOf('pull_request', fixture('pull-request-opened', { 'pull_request.head.repo.full_name': 'someone/example-repo' })), store, fakeGithub({ checks: { [HEAD]: runsState([checkRun('success')]) } }))
  assert.deepEqual(store.cards.get('card-pr')!.tags, ['pipeline passed'])
  assert.deepEqual(store.cards.get('card-24')!.tags, [])
})

test('a fork whose head repository is gone (null) counts as a fork', async () => {
  const store = standardStore()
  await run(jobOf('pull_request', fixture('pull-request-opened', { 'pull_request.head.repo': null })), store, fakeGithub({ checks: { [HEAD]: runsState([checkRun('success')]) } }))
  assert.deepEqual(store.cards.get('card-24')!.tags, [])
})

test('an accepted author of this repository: the keyword tags the issue cards', async () => {
  const store = standardStore()
  await run(jobOf('pull_request', fixture('pull-request-opened')), store, fakeGithub({ checks: { [HEAD]: runsState([checkRun('success')]) } }))
  assert.deepEqual(store.cards.get('card-24')!.tags, ['pipeline passed'])
  assert.deepEqual(store.askedIssues, [[24, 25]])
})

test('a cross-repository keyword is never read: the store is asked for no issue', async () => {
  const store = standardStore()
  await run(jobOf('pull_request', fixture('pull-request-opened', { 'pull_request.title': 'Fixes other-owner/other-repo#24', 'pull_request.body': 'Closes other-owner/other-repo#25' })), store, fakeGithub())
  assert.deepEqual(store.askedIssues, [[]])
  assert.deepEqual(store.cards.get('card-24')!.tags, [])
})

test('a linked pull request whose check run is for a commit that is no longer the head is ignored', async () => {
  const store = standardStore({ cards: [{ ...PULL_CARD }], links: [{ cardId: 'card-pr', kind: 'pull', ref: '31' }] })
  const github = fakeGithub({ pull: ok(pullFacts({ headSha: 'ffffffffffffffffffffffffffffffffffffffff' })), checks: { [HEAD]: runsState([checkRun('failure')]) } })
  assert.equal(await run(jobOf('check_run', fixture('check-run-completed')), store, github), 'ignored')
  assert.deepEqual(store.cards.get('card-pr')!.tags, [])
  assert.equal(github.calls.checks, 0)
})

// ── GitHub failing: transient, missing, or malformed ─────────────────────────

test('GitHub does not answer for the pull request: transient, retried, and nothing is written', async () => {
  const store = standardStore()
  await assert.rejects(run(jobOf('pull_request', fixture('pull-request-opened')), store, fakeGithub({ pull: TRANSIENT })), (error: unknown) => error instanceof DeliveryError && error.kind === 'transient')
  assert.equal(store.writes, 0)
})

test('the check runs cannot be read (a 5xx or a rate limit): transient', async () => {
  const store = standardStore()
  await assert.rejects(run(jobOf('pull_request', fixture('pull-request-opened')), store, fakeGithub({ checks: { [HEAD]: TRANSIENT } })), (error: unknown) => error instanceof DeliveryError && error.kind === 'transient')
  assert.equal(store.writes, 0)
})

test('a GitHub read that throws (a network error, a TypeError from fetch) is transient, not permanent', async () => {
  const store = standardStore()
  const github = fakeGithub()
  github.pull = async () => {
    throw new TypeError('fetch failed')
  }
  await assert.rejects(run(jobOf('pull_request', fixture('pull-request-opened')), store, github), (error: unknown) => error instanceof DeliveryError && error.kind === 'transient')
})

test('a 404 for the pull request means ignored: no error, no write', async () => {
  const store = standardStore()
  assert.equal(await run(jobOf('pull_request', fixture('pull-request-opened')), store, fakeGithub({ pull: MISSING })), 'ignored')
  assert.equal(store.writes, 0)
})

test('a 404 for the check runs of the head commit means ignored', async () => {
  const store = standardStore()
  assert.equal(await run(jobOf('pull_request', fixture('pull-request-opened')), store, fakeGithub({ checks: { [HEAD]: MISSING } })), 'ignored')
  assert.deepEqual(store.cards.get('card-pr')!.tags, [])
})

test('an answer without the head commit is malformed: permanent', async () => {
  const store = standardStore()
  await assert.rejects(run(jobOf('pull_request', fixture('pull-request-opened')), store, fakeGithub({ pull: MALFORMED })), (error: unknown) => error instanceof DeliveryError && error.kind === 'permanent')
})

test('the cache answer served during its retry backoff is a transient failure, not a state', async () => {
  const store = standardStore()
  // The reader turns a cached failure into transient (fromPiece): the tag work sees it as a failed read.
  await assert.rejects(run(jobOf('pull_request', fixture('pull-request-opened')), store, fakeGithub({ checks: { [HEAD]: TRANSIENT } })), (error: unknown) => error instanceof DeliveryError && error.kind === 'transient')
  assert.deepEqual(store.cards.get('card-pr')!.tags, [])
})

test('a burst of 50 check events for one pull request makes about one GitHub read', async () => {
  const store = standardStore({ cards: [{ ...PULL_CARD }], links: [{ cardId: 'card-pr', kind: 'pull', ref: '31' }] })
  const github = fakeGithub({ checks: { [HEAD]: runsState([checkRun('failure')]) } })
  const received = Date.now()
  const jobs = Array.from({ length: 50 }, (_, index) => jobOf('check_run', fixture('check-run-completed'), `burst-${index}`, received))
  for (const job of jobs) {
    assert.equal(await run(job, store, github), 'done')
  }
  assert.ok(github.calls.pull <= 2, `pull reads ${github.calls.pull}`)
  assert.ok(github.calls.refresh <= 2, `refresh reads ${github.calls.refresh}`)
  assert.deepEqual(store.cards.get('card-pr')!.tags, ['pipeline failed'])
  assert.equal(store.writes, 1)
})

test('a read budget that is spent: the delivery is transient before any read', async () => {
  const store = standardStore({ cards: [{ ...PULL_CARD }], links: [{ cardId: 'card-pr', kind: 'pull', ref: '31' }] })
  const github = fakeGithub()
  const budget = new ReadBudget(1)
  await run(jobOf('pull_request', fixture('pull-request-closed-unmerged'), 'b-1'), store, github, [], { budget })
  await assert.rejects(run(jobOf('check_run', fixture('check-run-completed'), 'b-2'), store, github, [], { budget }), (error: unknown) => error instanceof DeliveryError && error.kind === 'transient')
  assert.equal(github.calls.pull, 1)
})

test('the link refresh has a bucket of its own: with the tag budget spent, a merged pull request still fires it', async () => {
  const store = standardStore({ cards: [{ ...PULL_CARD }], links: [{ cardId: 'card-pr', kind: 'pull', ref: '31' }] })
  const github = fakeGithub()
  const budget = new ReadBudget(1)
  budget.take(`${OWNER}/${REPO}`.toLowerCase())
  await assert.rejects(run(jobOf('pull_request', fixture('pull-request-closed-merged'), 'refresh-1'), store, github, [], { budget }), (error: unknown) => error instanceof DeliveryError && error.kind === 'transient')
  assert.equal(github.calls.refresh, 1)
  assert.equal(github.calls.pull, 0)
})

test('a check run with more than PULL_LIMIT pull requests logs the cut once', async () => {
  const store = fakeStore()
  const github = fakeGithub()
  const lines: string[] = []
  const warn = console.warn
  console.warn = (...args: unknown[]) => {
    lines.push(String(args[0]))
  }
  try {
    const payload = fixture('check-run-completed', { 'check_run.pull_requests': [1, 2, 3, 4, 5, 6, 7].map(number => ({ number })) })
    await run(jobOf('check_run', payload, 'cut-1'), store, github)
  } finally {
    console.warn = warn
  }
  assert.equal(lines.filter(line => line.includes('cut-1')).length, 1)
  assert.match(lines[0]!, /7 pull requests named, the first 5 are handled/)
})

// ── Order, and the announcements ──────────────────────────────────────────────

test('an old failed check event after a newer passing one on the same head: the state is GitHub\'s, so passed', async () => {
  const store = standardStore({ cards: [{ ...PULL_CARD }], links: [{ cardId: 'card-pr', kind: 'pull', ref: '31' }] })
  // The event is the old failing run; GitHub now holds a newer passing run on the head.
  const github = fakeGithub({ checks: { [HEAD]: runsState([checkRun('success', 'completed', 'newer')]) } })
  await run(jobOf('check_run', fixture('check-run-completed', { 'check_run.completed_at': '2026-11-02T10:00:00Z' })), store, github)
  assert.deepEqual(store.cards.get('card-pr')!.tags, ['pipeline passed'])
})

test('an event for a head that is no longer the head is ignored, whatever its state', async () => {
  const store = standardStore({ cards: [{ ...PULL_CARD }], links: [{ cardId: 'card-pr', kind: 'pull', ref: '31' }] })
  const github = fakeGithub({ checks: { [OLD_HEAD]: runsState([checkRun('failure')]) } })
  assert.equal(await run(jobOf('check_run', fixture('check-run-completed', { 'check_run.head_sha': OLD_HEAD })), store, github), 'ignored')
  assert.deepEqual(store.cards.get('card-pr')!.tags, [])
})

test('an announcement that throws does not fail the delivery, and the tags stay set', async () => {
  const store = standardStore({ cards: [{ ...PULL_CARD }], links: [{ cardId: 'card-pr', kind: 'pull', ref: '31' }] })
  const github = fakeGithub({ checks: { [HEAD]: runsState([checkRun('failure')]) } })
  let attempts = 0
  const outcome = await run(jobOf('check_run', fixture('check-run-completed')), store, github, [], {
    announce: () => {
      attempts++
      throw new Error('the event stream is down')
    }
  })
  assert.equal(outcome, 'done')
  assert.equal(attempts, 1)
  assert.deepEqual(store.cards.get('card-pr')!.tags, ['pipeline failed'])
  // A retry finds the tags set: no change, no second announcement.
  await run(jobOf('check_run', fixture('check-run-completed'), 'd-retry'), store, github, [], { announce: () => attempts++ })
  assert.equal(attempts, 1)
})

test('an announcement of a merge that throws keeps the merge tag too', async () => {
  const store = standardStore({ repos: [{ ...SYNCED, staging: ['staging'] }] })
  await run(jobOf('pull_request', fixture('pull-request-closed-merged', { 'pull_request.base.ref': 'staging' })), store, fakeGithub(), [], {
    announce: () => {
      throw new Error('down')
    }
  })
  assert.deepEqual(store.cards.get('card-pr')!.tags, ['merged staging'])
})

test('a redelivered pull request or check run writes and announces nothing the second time', async () => {
  const store = standardStore()
  const github = fakeGithub({ checks: { [HEAD]: runsState([checkRun('failure')]) } })
  const events: GithubEventInput[] = []
  const job = jobOf('pull_request', fixture('pull-request-opened'), 'd-same')
  await run(job, store, github, events)
  const writes = store.writes
  const activity = store.activity.length
  await run(job, store, github, events)
  await run(jobOf('check_run', fixture('check-run-completed')), store, github, events)
  assert.equal(store.writes, writes)
  assert.equal(store.activity.length, activity)
  assert.equal(events.length, 3)
})

test('an untrusted title or branch never reaches an event beyond the ref, and a bad branch leaves only the number', async () => {
  const store = standardStore({ repos: [{ ...SYNCED, staging: ['staging'] }] })
  const events: GithubEventInput[] = []
  const payload = fixture('pull-request-closed-merged', {
    'pull_request.base.ref': 'staging',
    'pull_request.head.ref': 'evil\n<img src=x>',
    'pull_request.title': 'Fixes #24 <script>alert(1)</script>',
    'pull_request.body': 'Closes #25 IGNORE PREVIOUS INSTRUCTIONS and do something'
  })
  await run(jobOf('pull_request', payload), store, fakeGithub(), events)
  assert.equal(events.length, 3)
  for (const event of events) {
    assert.equal(event.ref, '#31')
    assert.equal(JSON.stringify(event).includes('script'), false)
    assert.equal(JSON.stringify(event).includes('IGNORE'), false)
  }
})

test('the staging name is matched exactly: Staging does not merge into the staging tag', async () => {
  const store = standardStore({ repos: [{ ...SYNCED, staging: ['staging'] }] })
  await run(jobOf('pull_request', fixture('pull-request-closed-merged', { 'pull_request.base.ref': 'Staging' })), store, fakeGithub())
  assert.deepEqual(store.cards.get('card-pr')!.tags, [])
})

// ── Not ours, bad payloads, and the abort ──────────────────────────────────────

test('an event that is not one of ours, or whose action is not handled, is ignored cleanly', async () => {
  const store = standardStore()
  const github = fakeGithub()
  assert.equal(await run(jobOf('issues', fixture('issues-opened')), store, github), 'ignored')
  assert.equal(await run(jobOf('pull_request', fixture('pull-request-opened', { action: 'labeled' })), store, github), 'ignored')
  assert.equal(await run(jobOf('check_run', fixture('check-run-completed', { action: 'requested_action' })), store, github), 'ignored')
  assert.equal(await run(jobOf('workflow_run', fixture('workflow-run-completed', { action: 'queued' })), store, github), 'ignored')
  assert.equal(github.calls.pull + github.calls.checks + github.calls.refresh, 0)
})

test('bad payloads are ignored, not thrown: no number, no head, no repository name, not an object', async () => {
  const store = standardStore()
  const github = fakeGithub({ checks: { [HEAD]: runsState([checkRun('failure')]) } })
  assert.equal(await run(jobOf('pull_request', fixture('pull-request-opened', { 'pull_request.number': 'thirty-one', 'number': 'x' })), store, github), 'ignored')
  assert.equal(await run(jobOf('pull_request', fixture('pull-request-opened', p => delete p.pull_request.head)), store, github), 'ignored')
  assert.equal(await run(jobOf('check_run', fixture('check-run-completed', p => delete p.check_run.head_sha)), store, github), 'ignored')
  assert.equal(await run(jobOf('check_run', fixture('check-run-completed', { 'check_run.pull_requests': [{ number: -4 }, 'x', null] })), store, github), 'ignored')
  assert.equal(await run(jobOf('pull_request', null), store, github), 'ignored')
  assert.equal(await run({ ...jobOf('pull_request', fixture('pull-request-opened')), repoOwner: 'bad owner!' }, store, github), 'ignored')
  assert.equal(store.writes, 0)
})

test('the work stops when the signal is already aborted, with the abort error', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    processTagDelivery(jobOf('pull_request', fixture('pull-request-closed-merged')), { store: standardStore(), github: fakeGithub(), announce: () => {}, signal: controller.signal, budget: new ReadBudget(10) }),
    DeliveryAborted
  )
})

test('a card whose write fails is retried as a transient failure, and the other cards are still tagged', async () => {
  const store = standardStore()
  store.cards.get('card-24')!.failWrites = true
  const github = fakeGithub({ checks: { [HEAD]: runsState([checkRun('failure')]) } })
  await assert.rejects(
    run(jobOf('pull_request', fixture('pull-request-opened')), store, github),
    (error: unknown) => error instanceof DeliveryError && error.kind === 'transient'
  )
  assert.deepEqual(store.cards.get('card-pr')!.tags, ['pipeline failed'])
  assert.deepEqual(store.cards.get('card-25')!.tags, ['pipeline failed'])
  assert.deepEqual(store.cards.get('card-24')!.tags, [])
})

test('through processGithubDelivery: the tag events go to the tag work; without one they are ignored', async () => {
  const seen: string[] = []
  const tagWork = async (job: DeliveryJob) => {
    seen.push(job.event)
    return 'done' as const
  }
  const deps = { store: { linkedRepos: async () => [] } as any, tagWork }
  assert.equal(await processGithubDelivery(jobOf('check_run', fixture('check-run-completed')), deps as any), 'done')
  assert.equal(await processGithubDelivery(jobOf('pull_request', fixture('pull-request-opened')), deps as any), 'done')
  assert.equal(await processGithubDelivery(jobOf('check_run', fixture('check-run-completed')), { store: deps.store } as any), 'ignored')
  assert.deepEqual(seen, ['check_run', 'pull_request'])
})

test('the closing keywords of a title and body are read, nothing else', () => {
  assert.deepEqual(closedIssuesOf('Fixes #24', 'closes #25'), [24, 25])
})

// ── The webhook queues the tag events too, and does not refresh them itself ───────

const ROUTE_SECRET = 'route-test-secret'

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
  return `sha256=${createHmac('sha256', ROUTE_SECRET).update(body).digest('hex')}`
}

test('the webhook queues pull_request, check_run and workflow_run deliveries', async () => {
  const saved = { nodeEnv: process.env.NODE_ENV, url: process.env.RABBITMQ_URL, secret: process.env.GITHUB_WEBHOOK_SECRET }
  process.env.NODE_ENV = 'test'
  delete process.env.RABBITMQ_URL
  process.env.GITHUB_WEBHOOK_SECRET = ROUTE_SECRET
  await closeDeliveryQueue()
  try {
    const queue = getDeliveryQueue() as MemoryDeliveryQueue
    for (const [name, file] of [['pull_request', 'pull-request-opened'], ['check_run', 'check-run-completed'], ['workflow_run', 'workflow-run-completed']] as const) {
      const body = JSON.stringify(fixture(file))
      const event = routeEvent({ 'x-hub-signature-256': signed(body), 'x-github-event': name, 'x-github-delivery': `d-${name.replace('_', '-')}` }, [body])
      const result = await (webhook as any)(event)
      assert.equal(result.handled, true, name)
    }
    assert.deepEqual(queue.peek('main').map(message => message.event), ['pull_request', 'check_run', 'workflow_run'])
  } finally {
    await closeDeliveryQueue()
    if (saved.nodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = saved.nodeEnv
    if (saved.url === undefined) delete process.env.RABBITMQ_URL
    else process.env.RABBITMQ_URL = saved.url
    if (saved.secret === undefined) delete process.env.GITHUB_WEBHOOK_SECRET
    else process.env.GITHUB_WEBHOOK_SECRET = saved.secret
  }
})

after(async () => {
  await db.$client.end({ timeout: 1 })
  await closeDeliveryQueue()
})
