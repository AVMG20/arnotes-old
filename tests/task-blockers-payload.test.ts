// What a board card and its drawer may show of a blocker, by audience (GH #36, slice 4).
// The board payload uses blockedMark for each card, so a customer's payload carries blocked only:
// no blockedBy, no blocker ids. Pure, no database. Run: node --import tsx --test tests/task-blockers-payload.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blockedMark } from '../server/utils/mcpBlockerLinks'
import { blockedSummary } from '../app/utils/taskBlockers'

const open = { blocked: true, openBlockerIds: ['hidden-task', 'shared-task'] }

test('a staff card carries the open blocker ids', () => {
  assert.deepEqual(blockedMark(open, 'staff'), { blocked: true, blockedBy: ['hidden-task', 'shared-task'] })
})

test('a customer card carries blocked only: no blockedBy, no ids', () => {
  const mark = blockedMark(open, 'customer')
  assert.deepEqual(mark, { blocked: true })
  assert.equal('blockedBy' in mark, false)
  assert.equal(JSON.stringify(mark).includes('hidden-task'), false)
})

test('a free card carries blocked false for both audiences', () => {
  const free = { blocked: false, openBlockerIds: [] }
  assert.deepEqual(blockedMark(free, 'staff'), { blocked: false })
  assert.deepEqual(blockedMark(free, 'customer'), { blocked: false })
})

test('a customer blocked only by hidden tasks reads plain words, not a count of zero', () => {
  // The drawer counts only the open blockers the customer may read; none are visible here.
  assert.equal(blockedSummary(true, 0), 'Waiting for work that is not shown here.')
  assert.equal(blockedSummary(true, 2), 'Blocked until 2 open tasks finish.')
  assert.equal(blockedSummary(false, 0), 'Not waiting for any task on this board.')
})
