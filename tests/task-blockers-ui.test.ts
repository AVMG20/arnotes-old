// The blocked-by words and the blocker search of the board card and the drawer section (GH #36,
// slice 4). Pure functions, no browser. Run: node --import tsx --test tests/task-blockers-ui.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blockedChipLabel, blockedSummary, blockerCandidates, blockerStateWords } from '../app/utils/taskBlockers'

test('the card chip counts open blockers when the count is known', () => {
  assert.equal(blockedChipLabel(2), 'Blocked by 2')
  assert.equal(blockedChipLabel(null), 'Blocked')
  assert.equal(blockedChipLabel(0), 'Blocked')
})

test('the summary reads in plain words for one and for many', () => {
  assert.equal(blockedSummary(false, 0), 'Not waiting for any task on this board.')
  assert.equal(blockedSummary(true, 1), 'Blocked until 1 open task finishes.')
  assert.equal(blockedSummary(true, 3), 'Blocked until 3 open tasks finish.')
})

test('a hidden blocker has no state words; a visible one says Open or Finished', () => {
  assert.equal(blockerStateWords({ finished: null }), '')
  assert.equal(blockerStateWords({ finished: false }), 'Open')
  assert.equal(blockerStateWords({ finished: true }), 'Finished')
})

const tasks = [
  { id: 'a', title: 'Build the login page', columnId: 'c1' },
  { id: 'b', title: 'Login copy review', columnId: 'c2' },
  { id: 'self', title: 'Login tests', columnId: 'c1' },
  { id: 'gone', title: 'Login old', columnId: 'c1', deletedAt: 1 },
  { id: 'sub', title: 'Login subtask', columnId: 'c1', parentTaskId: 'a' },
  { id: 'taken', title: 'Login already waited for', columnId: 'c1' }
]

test('the search finds live top-level tasks by part of the title, case-insensitive', () => {
  const found = blockerCandidates(tasks, '  LOGIN ', { selfId: 'self', waitingFor: ['taken'] })
  assert.deepEqual(found.map(t => t.id), ['a', 'b'])
})

test('an empty query finds nothing', () => {
  assert.deepEqual(blockerCandidates(tasks, '   ', { selfId: 'self', waitingFor: [] }), [])
})

test('the search stops at the limit', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, title: `item ${i}`, columnId: 'c' }))
  assert.equal(blockerCandidates(many, 'item', { selfId: 'x', waitingFor: [] }, 4).length, 4)
})
