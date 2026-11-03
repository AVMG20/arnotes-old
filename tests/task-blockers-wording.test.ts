// The drawer's summary when a viewer cannot see every blocker (GH #36, slice 4 review).
// A customer with one visible and one hidden open blocker must not read "until 1 open task".
// Pure, no browser. Run: node --import tsx --test tests/task-blockers-wording.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blockedSummaryWithHidden } from '../app/utils/taskBlockers'

test('staff, or a customer with nothing hidden, keep the exact count', () => {
  assert.equal(blockedSummaryWithHidden(true, 1, 0), 'Blocked until 1 open task finishes.')
  assert.equal(blockedSummaryWithHidden(true, 3, 0), 'Blocked until 3 open tasks finish.')
  assert.equal(blockedSummaryWithHidden(false, 0, 0), 'Not waiting for any task on this board.')
})

test('a customer with one visible and one hidden open blocker reads a floor', () => {
  assert.equal(blockedSummaryWithHidden(true, 1, 1), 'Blocked until at least 1 open task finishes.')
  assert.equal(blockedSummaryWithHidden(true, 2, 1), 'Blocked until at least 2 open tasks finish.')
})

test('a customer blocked only by hidden tasks gets the plain fallback', () => {
  assert.equal(blockedSummaryWithHidden(true, 0, 2), 'Waiting for work that is not shown here.')
})

test('a customer with hidden blockers but no block reads not waiting', () => {
  assert.equal(blockedSummaryWithHidden(false, 0, 1), 'Not waiting for any task on this board.')
})
