/* eslint-disable @typescript-eslint/no-explicit-any -- recorded GitHub payloads are read loosely */
// The catch-up of issue sync (GH5): open issues and their comments read from GitHub and applied through
// processGithubDelivery. A fake store and recorded answers; no database, no network.
//   node --import tsx --test tests/github-catchup.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DeliveryAborted, DeliveryError, processGithubDelivery } from '../server/utils/githubCards'
import type { CardPatch, CardTask, DeliveryJob, GithubCardStore, IgnoredIssue, NewIssueCard, SyncedRepo } from '../server/utils/githubCards'
import {
  catchUpDeliveryId, catchUpInFlight, CatchUpBudget, CatchUpFailure, CatchUpNotQueued, QUEUE_UNAVAILABLE, queueCatchUp,
  runCatchUp, syncSettingsOf, type CatchUpGithub
} from '../server/utils/githubCatchUp'

const NOW = 1_800_000_000_000
const KEY = 'test-marker-key'
const PROJECT = 'project-1'

const LIST: any[] = JSON.parse(readFileSync(new URL('./fixtures/github/issues-open-page.json', import.meta.url), 'utf8'))
const COMMENTS: Record<number, any[]> = {
  1: [
    { id: 501, user: { login: 'bob' }, body: 'Looks right to me.', html_url: 'https://github.com/example-owner/example-repo/issues/1#issuecomment-501' },
    { id: 502, user: { login: 'stranger' }, body: 'Buy now', html_url: 'https://github.com/example-owner/example-repo/issues/1#issuecomment-502' }
  ]
}

function harness(repoOverrides: Partial<SyncedRepo> = {}) {
  const repo: SyncedRepo = {
    id: 'repo-row-1',
    projectId: PROJECT,
    owner: 'example-owner',
    repo: 'example-repo',
    syncEnabled: true,
    syncColumn: 'Backlog',
    syncVisibility: 'internal',
    acceptedLogins: ['alice', 'bob'],
    completeOnClose: false,
    ...repoOverrides
  }
  const cards = new Map<number, CardTask>()
  const created: NewIssueCard[] = []
  const updates: string[] = []
  const ignored: IgnoredIssue[] = []
  let nextId = 1
  const store: GithubCardStore = {
    async linkedRepos() { return [repo] },
    async recordIgnored(_repo, issue) { ignored.push(issue) },
    async issueCard(_repo, number) { return cards.get(number) ?? null },
    async resolveColumn() { return { columnId: 'Backlog', name: 'Backlog', fellBack: false } },
    async createIssueCard(input) {
      created.push(input)
      const card: CardTask = { id: `card-${nextId++}`, projectId: input.projectId, title: input.title, description: input.description, tags: input.tags, visibility: input.visibility, completedAt: null, trashed: false }
      cards.set(input.number, card)
      return card
    },
    async updateCard(_task: CardTask, _patch: CardPatch) {},
    async hasUpdate(_task, marker) { return updates.some(body => body.endsWith(marker)) },
    async addUpdate(_task, body) { updates.push(body) }
  }
  return { store, cards, created, updates, ignored }
}

// The recorded list answers: one page, and the comments of issue 1.
function recordedGithub(pages: any[][] = [LIST]) {
  const reads = { pages: [] as number[], comments: [] as number[] }
  const github: CatchUpGithub = {
    async issuePage(_owner, _repo, page) {
      reads.pages.push(page)
      return pages[page - 1] ?? []
    },
    async comments(_owner, _repo, number) {
      reads.comments.push(number)
      return COMMENTS[number] ?? []
    }
  }
  return { github, reads }
}

function job(event: string, deliveryId: string, payload: unknown = {}): DeliveryJob {
  return { deliveryId, event, repoOwner: 'example-owner', repoName: 'example-repo', repoId: 0, payload, receivedAt: NOW, firstSeenAt: NOW, attempt: 0 }
}

function runner(h: ReturnType<typeof harness>, github: CatchUpGithub, signal?: AbortSignal) {
  return (j: DeliveryJob) => runCatchUp(j, {
    store: h.store,
    github,
    signal,
    budget: new CatchUpBudget(1000, () => NOW),
    apply: synthetic => processGithubDelivery(synthetic, { store: h.store, markerKey: KEY, echoCommentIds: new Set() })
  })
}

test('two accepted authors are queued, the stranger and the pull request are skipped and not counted as ignored', async () => {
  const h = harness()
  const { github } = recordedGithub()
  const outcome = await runner(h, github)(job('catch_up', 'catch-up-1'))
  assert.equal(outcome, 'done')
  assert.deepEqual(h.created.map(card => card.number).sort(), [1, 4])
  assert.equal(h.ignored.length, 0, 'a catch-up never changes ignored_count')
  assert.equal(h.updates.filter(body => body.includes('comment by bob')).length, 1, 'bob comment copied')
  assert.equal(h.updates.filter(body => body.includes('stranger')).length, 0, 'stranger comment not copied')
})

test('running twice creates nothing twice', async () => {
  const h = harness()
  const { github } = recordedGithub()
  const run = runner(h, github)
  await run(job('catch_up', 'catch-up-1'))
  const before = { cards: h.created.length, updates: h.updates.length }
  await run(job('catch_up', 'catch-up-2'))
  assert.equal(h.created.length, before.cards)
  assert.equal(h.updates.length, before.updates)
  assert.equal(h.created.length, 2)
})

test('the read is capped at 200 open issues, one page at a time', async () => {
  const page = (from: number) => Array.from({ length: 100 }, (_, i) => ({ number: from + i, title: `Issue ${from + i}`, body: '', html_url: `https://github.com/example-owner/example-repo/issues/${from + i}`, comments: 0, user: { login: 'alice' } }))
  const h = harness()
  const { github, reads } = recordedGithub([page(1), page(101), page(201)])
  await runner(h, github)(job('catch_up', 'catch-up-cap'))
  assert.deepEqual(reads.pages, [1, 2], 'the third page is not asked for')
  assert.equal(h.created.length, 200)
})

test('a transient read failure is a transient delivery error; a missing repository is permanent', async () => {
  const h = harness()
  const transient: CatchUpGithub = {
    issuePage: async () => { throw new CatchUpFailure('transient', 'GitHub did not answer in time') },
    comments: async () => []
  }
  await assert.rejects(runner(h, transient)(job('catch_up', 'catch-up-t')), (error: unknown) => error instanceof CatchUpFailure && error.kind === 'transient')
  const permanent: CatchUpGithub = {
    issuePage: async () => { throw new CatchUpFailure('permanent', 'GitHub has no repository') },
    comments: async () => []
  }
  await assert.rejects(runner(h, permanent)(job('catch_up', 'catch-up-p')), (error: unknown) => error instanceof CatchUpFailure && error.kind === 'permanent')
  // Through the delivery pipeline the same failure is the queue's kind: a store read that fails is transient.
  const broken: GithubCardStore = {
    ...h.store,
    linkedRepos: async () => {
      throw new Error('database down')
    }
  }
  const previous = process.env.GITHUB_TOKEN
  process.env.GITHUB_TOKEN = 'test-token-not-logged'
  try {
    await assert.rejects(processGithubDelivery(job('catch_up', 'catch-up-x'), { store: broken, markerKey: KEY }), (error: unknown) => error instanceof DeliveryError && error.kind === 'transient')
  } finally {
    if (previous === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = previous
  }
})

test('an abandoned attempt stops before any read and writes nothing', async () => {
  const h = harness()
  const { github, reads } = recordedGithub()
  const controller = new AbortController()
  controller.abort()
  const previous = process.env.GITHUB_TOKEN
  process.env.GITHUB_TOKEN = 'test-token-not-logged'
  try {
    await assert.rejects(processGithubDelivery(job('catch_up', 'catch-up-a'), { store: h.store, markerKey: KEY, signal: controller.signal }), (error: unknown) => error instanceof DeliveryAborted)
  } finally {
    if (previous === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = previous
  }
  assert.equal(reads.pages.length, 0)
  assert.equal(h.created.length, 0)
  assert.equal(await runner(h, github, controller.signal)(job('catch_up', 'catch-up-a2')).catch(error => error.name), 'AbortError')
})

test('without a server token nothing is read and the catch-up is skipped', async () => {
  const h = harness()
  const previous = process.env.GITHUB_TOKEN
  delete process.env.GITHUB_TOKEN
  try {
    const outcome = await runCatchUp(job('catch_up', 'catch-up-n'), { store: h.store, apply: async () => 'done' })
    assert.equal(outcome, 'ignored')
  } finally {
    if (previous !== undefined) process.env.GITHUB_TOKEN = previous
  }
  assert.equal(h.created.length, 0)
})

test('a repository whose read budget is used up is a transient failure', async () => {
  const h = harness()
  const { github } = recordedGithub()
  const run = (budget: CatchUpBudget) => runCatchUp(job('catch_up', 'catch-up-b'), {
    store: h.store, github, budget, apply: async () => 'done'
  })
  // The first read (the issue list) uses the one allowed read; the comments of issue 1 are refused.
  await assert.rejects(run(new CatchUpBudget(1, () => NOW)), (error: unknown) => error instanceof CatchUpFailure && error.kind === 'transient')
})

test('pages of pull requests only are capped at ten pages, and the run is truncated', async () => {
  const prs = (from: number) => Array.from({ length: 100 }, (_, i) => ({ number: from + i, pull_request: { url: 'x' }, user: { login: 'alice' } }))
  const pages = Array.from({ length: 12 }, (_, p) => prs(p * 100 + 1))
  const h = harness()
  const { github, reads } = recordedGithub(pages)
  await runner(h, github)(job('catch_up', 'catch-up-prs'))
  assert.deepEqual(reads.pages, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'no page past the page cap is read')
  assert.equal(h.created.length, 0)
})

test('one catch-up per repository at a time: a second request is answered already, and a finished run frees it', async () => {
  const row = { id: 'repo-inflight', owner: 'example-owner', repo: 'example-repo' }
  const sent: string[] = []
  const publish = async (_queue: 'main', message: { deliveryId: string }) => {
    sent.push(message.deliveryId)
  }
  assert.equal(await queueCatchUp(row, 'catch-up-a', publish), 'queued')
  assert.equal(catchUpInFlight(row.id), true)
  assert.equal(await queueCatchUp(row, 'catch-up-b', publish), 'already')
  assert.deepEqual(sent, ['catch-up-a'], 'the second request sends nothing')

  // The run of the queued job ends and frees the repository (the job names its row).
  const h = harness()
  const { github } = recordedGithub()
  const job2: DeliveryJob = { ...job('catch_up', 'catch-up-a'), payload: { repository: { full_name: 'example-owner/example-repo' }, catch_up: { row: row.id } } }
  await runner(h, github)(job2)
  assert.equal(catchUpInFlight(row.id), false)
  assert.equal(await queueCatchUp(row, 'catch-up-c', publish), 'queued')
})

test('a queue failure answers the fixed sentence, never the broker text', async () => {
  const row = { id: 'repo-broken-queue', owner: 'example-owner', repo: 'example-repo' }
  const publish = async () => {
    throw new Error('connect ECONNREFUSED amqp://user:secret@broker.internal:5672')
  }
  await assert.rejects(queueCatchUp(row, 'catch-up-x', publish), (error: unknown) => {
    assert.ok(error instanceof CatchUpNotQueued)
    assert.equal(error.message, QUEUE_UNAVAILABLE)
    assert.ok(!error.message.includes('amqp') && !error.message.includes('secret'))
    return true
  })
  assert.equal(catchUpInFlight(row.id), false, 'a failed queue frees the repository for the next request')
})

test('the delivery id has the milliseconds and the settings version: same-second toggles differ, a double submit is the same', () => {
  const settings = syncSettingsOf({
    syncEnabled: true, syncColumn: 'Backlog', syncVisibility: 'internal', acceptedLogins: ['alice'],
    stagingBranches: '', productionBranches: '', completeOnClose: false
  })
  const other = { ...settings, syncColumn: 'Doing' }
  const a = catchUpDeliveryId('row-1', NOW, settings)
  assert.equal(a, catchUpDeliveryId('row-1', NOW, settings), 'the same request is the same job')
  assert.notEqual(a, catchUpDeliveryId('row-1', NOW + 1, settings), 'a millisecond later is another job')
  assert.notEqual(a, catchUpDeliveryId('row-1', NOW, other), 'other settings are another job')
  assert.notEqual(a, catchUpDeliveryId('row-2', NOW, settings), 'another repository is another job')
})
