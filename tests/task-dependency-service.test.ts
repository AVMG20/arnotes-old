// Blocked-by service (GH #36, slice 2): the parts that need no database. The writes are refused
// for a customer before any read, so those are checked here too. Run:
//   node --import tsx --test tests/task-dependency-service.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addBlocker, blockerIdFrom, blockerOffBoard, duplicateRefusal, isFinishedTask, loopMessage, NOT_ON_BOARD,
  removeBlocker, viewBlocker, HIDDEN_TASK_TITLE
} from '../server/utils/taskDependencyService'
import type { Actor } from '../server/utils/taskDependencyService'

const titles: Record<string, string> = { A: 'Write the spec', B: 'Build the table', C: 'Review it' }
const titleOf = (id: string) => titles[id] ?? 'a task'

test('a loop is named in plain words, step by step, for two and for three tasks', () => {
  assert.equal(
    loopMessage(['B', 'A', 'B'], titleOf),
    'That link would close a loop: Build the table waits for Write the spec, and Write the spec waits for Build the table (Build the table -> Write the spec -> Build the table).'
  )
  assert.match(loopMessage(['C', 'A', 'B', 'C'], titleOf), /^That link would close a loop: Review it waits for Write the spec, Write the spec waits for Build the table, and Build the table waits for Review it/)
})

test('a blocker is finished when trashed, when completed, or when its column is the finished one', () => {
  const finished = new Set(['done-column'])
  const live = { columnId: 'todo-column', completedAt: null, deletedAt: null }
  assert.equal(isFinishedTask(live, finished), false)
  assert.equal(isFinishedTask({ ...live, deletedAt: 1_800_000_000_000 }, finished), true)
  assert.equal(isFinishedTask({ ...live, completedAt: 1_800_000_000_000 }, finished), true)
  assert.equal(isFinishedTask({ ...live, columnId: 'done-column' }, finished), true)
})

test('a customer cannot add or remove a blocker, and the refusal comes before any read or write', async () => {
  const customer = { userId: 'customer-user', audience: 'customer' as const }
  const added = await addBlocker('board-1', 'A', 'B', customer)
  assert.deepEqual(added.ok, false)
  assert.equal(added.ok === false && added.reason, 'not_staff')
  const removed = await removeBlocker('board-1', 'A', 'B', customer)
  assert.equal(removed.ok === false && removed.reason, 'not_staff')
})

test('a racing insert that hits the unique pair is the duplicate refusal, also when the driver wraps the error', () => {
  assert.deepEqual(duplicateRefusal({ code: '23505' }), { ok: false, reason: 'duplicate', message: 'This task already waits for that one.' })
  assert.equal(duplicateRefusal({ cause: { code: '23505' } })?.reason, 'duplicate')
  assert.equal(duplicateRefusal({ cause: { cause: { code: '23505' } } })?.reason, 'duplicate')
  assert.equal(duplicateRefusal({ code: '08006' }), null)
  assert.equal(duplicateRefusal(new Error('connection lost')), null)
})

test('a blocker missing, in the trash, or on another board is refused with the same 404 answer', () => {
  assert.deepEqual(blockerOffBoard('board-1', null), { ok: false, reason: 'not_found', message: NOT_ON_BOARD })
  assert.deepEqual(blockerOffBoard('board-1', { projectId: 'board-2' }), { ok: false, reason: 'not_found', message: NOT_ON_BOARD })
  assert.equal(blockerOffBoard('board-1', { projectId: 'board-1' }), null)
})

test('a customer reads a hidden blocker with no id, title, column or finished flag; staff read all of it', () => {
  const hidden = { id: 't9', title: 'Secret plan', visibility: 'internal' as const }
  const customer: Actor = { userId: 'u', audience: 'customer' }
  const staff: Actor = { userId: 'u', audience: 'staff' }
  assert.deepEqual(viewBlocker(hidden, customer, 'Doing', true), { id: null, title: HIDDEN_TASK_TITLE, visible: false, column: null, finished: null })
  assert.deepEqual(viewBlocker(hidden, staff, 'Doing', false), { id: 't9', title: 'Secret plan', visible: true, column: 'Doing', finished: false })
  const shared = { id: 't1', title: 'Shared', visibility: 'customer' as const }
  assert.deepEqual(viewBlocker(shared, customer, 'Verify', false), { id: 't1', title: 'Shared', visible: true, column: 'Verify', finished: false })
})

test('an empty or non-string body gives no blocker id; a non-empty string is taken', () => {
  assert.equal(blockerIdFrom(undefined), null)
  assert.equal(blockerIdFrom(null), null)
  assert.equal(blockerIdFrom({}), null)
  assert.equal(blockerIdFrom({ blockerId: '   ' }), null)
  assert.equal(blockerIdFrom({ blockerId: 42 }), null)
  assert.equal(blockerIdFrom({ blockerId: ' abc ' }), 'abc')
})
