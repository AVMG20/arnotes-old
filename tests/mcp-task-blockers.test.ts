// The blocked-by parts of the MCP board tools (GH #36, slice 3) that need no database: the blocked
// mark per audience, the cap on a call's id lists, a refused link, what a customer may read of a
// blocker, and the batch that gives every card of a board its state. Run:
//   node --import tsx --test tests/mcp-task-blockers.test.ts
// The rollback of a refused write is a database transaction; it is proven on a live board, not here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blockedMark, checkLinkCount, linkOrFail, MAX_LINK_IDS } from '../server/utils/mcpBlockerLinks'
import { blockedStatesFrom, HIDDEN_TASK_TITLE, viewBlocker } from '../server/utils/taskDependencyService'
import type { TaskLink } from '../server/utils/taskDependencies'
import { McpToolError } from '../server/utils/mcpToolKit'

test('staff read the open blockers of a blocked task; a customer reads only that it is blocked', () => {
  const state = { blocked: true, openBlockerIds: ['A', 'B'] }
  assert.deepEqual(blockedMark(state, 'staff'), { blocked: true, blockedBy: ['A', 'B'] })
  assert.deepEqual(blockedMark(state, 'customer'), { blocked: true })
})

test('a ready task reads as not blocked, and carries no blocker ids for either audience', () => {
  const state = { blocked: false, openBlockerIds: [] }
  assert.deepEqual(blockedMark(state, 'staff'), { blocked: false })
  assert.deepEqual(blockedMark(state, 'customer'), { blocked: false })
})

test('a call may name up to the cap of tasks, and one more is refused in plain words', () => {
  const ids = Array.from({ length: MAX_LINK_IDS }, (_, i) => `t${i}`)
  assert.doesNotThrow(() => checkLinkCount(ids, 'blockedBy'))
  assert.throws(() => checkLinkCount([...ids, 'extra'], 'blockedBy'), (error: unknown) =>
    error instanceof McpToolError && error.message.includes(`"blockedBy" takes at most ${MAX_LINK_IDS} tasks`))
})

test('a refused link fails the call with the service message, and a made one passes', () => {
  assert.doesNotThrow(() => linkOrFail({ ok: true }))
  assert.throws(() => linkOrFail({ ok: false, message: 'This task already waits for that one.' }), (error: unknown) =>
    error instanceof McpToolError && error.message === 'This task already waits for that one.')
})

test('a customer reads a hidden blocker as a hidden task, with no id, column or finished flag', () => {
  const viewer = { userId: 'contact', audience: 'customer' as const }
  const hidden = viewBlocker({ id: 'T1', title: 'Secret plan', visibility: 'internal' }, viewer, 'To do', false)
  assert.deepEqual(hidden, { id: null, title: HIDDEN_TASK_TITLE, visible: false, column: null, finished: null })
  const text = JSON.stringify(hidden)
  assert.ok(!text.includes('Secret plan') && !text.includes('T1') && !text.includes('To do'))
})

test('a customer reads a customer-visible blocker in full, and staff read an internal one in full', () => {
  const customer = { userId: 'contact', audience: 'customer' as const }
  const staff = { userId: 'team', audience: 'staff' as const }
  assert.deepEqual(
    viewBlocker({ id: 'T2', title: 'Ship the export', visibility: 'customer' }, customer, 'Done', true),
    { id: 'T2', title: 'Ship the export', visible: true, column: 'Done', finished: true }
  )
  assert.deepEqual(
    viewBlocker({ id: 'T3', title: 'Secret plan', visibility: 'internal' }, staff, 'To do', false),
    { id: 'T3', title: 'Secret plan', visible: true, column: 'To do', finished: false }
  )
})

// A board of 500 cards in a chain: card i waits for card i-1. Every third card sits in the finished column.
test('the states of every card on a 500-card board come from one set of rows', () => {
  const cards = 500
  const row = (i: number, deleted = false) => ({
    id: `c${i}`,
    projectId: 'board',
    columnId: i % 3 === 0 ? 'done' : 'todo',
    title: `Card ${i}`,
    visibility: 'customer' as const,
    completedAt: null,
    deletedAt: deleted ? 1 : null
  })
  const blockers = new Map(Array.from({ length: cards }, (_, i) => [`c${i}`, row(i)] as const))
  const links: TaskLink[] = Array.from({ length: cards - 1 }, (_, i) => ({ blockedId: `c${i + 1}`, blockerId: `c${i}` }))
  const ids = Array.from({ length: cards }, (_, i) => `c${i}`)

  const states = blockedStatesFrom(links, blockers, new Set(['done']), ids)
  assert.equal(states.size, cards)
  assert.deepEqual(states.get('c0'), { blocked: false, openBlockerIds: [] })
  // c1 waits for c0, which is in the finished column: ready.
  assert.deepEqual(states.get('c1'), { blocked: false, openBlockerIds: [] })
  assert.equal(states.get('c1')?.blocked, false)
  // c2 waits for c1, which is open: blocked, and c1 is the open blocker.
  assert.deepEqual(states.get('c2'), { blocked: true, openBlockerIds: ['c1'] })
  // A trashed blocker does not block.
  blockers.set('c1', row(1, true))
  assert.equal(blockedStatesFrom(links, blockers, new Set(['done']), ['c2']).get('c2')?.blocked, false)
})
