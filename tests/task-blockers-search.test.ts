// The blocker search box: a loop is not offered, and the box says why a title match is not offered
// (GH #36, slice 4 retest). Pure, no browser. Run: node --import tsx --test tests/task-blockers-search.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blockerCandidates, blockerSearchNote, emptySearchWords } from '../app/utils/taskBlockers'

const self = 'self'
const tasks = [
  { id: 'self', title: 'Login UI', columnId: 'c' },
  { id: 'linked', title: 'Login API', columnId: 'c' },
  { id: 'loop', title: 'Login copy', columnId: 'c', blockedBy: ['self'] },
  { id: 'free', title: 'Login docs', columnId: 'c', blockedBy: ['other'] }
]
const exclude = { selfId: self, waitingFor: ['linked'] }

test('a title that is already linked is offered neither, and the box says it is linked', () => {
  assert.deepEqual(blockerCandidates(tasks, 'API', exclude).map(t => t.id), [])
  const note = blockerSearchNote(tasks, 'API', exclude)
  assert.deepEqual(note, { linked: 1, loop: 0 })
  assert.equal(emptySearchWords(note), 'That task is already linked.')
})

test('a candidate that waits for this task would close a loop: not offered, and the box says so', () => {
  assert.deepEqual(blockerCandidates(tasks, 'copy', exclude).map(t => t.id), [])
  const note = blockerSearchNote(tasks, 'copy', exclude)
  assert.deepEqual(note, { linked: 0, loop: 1 })
  assert.equal(emptySearchWords(note), 'That task waits for this one, so linking it would close a loop.')
})

test('a fine candidate is still offered, and a title with no match keeps the old sentence', () => {
  assert.deepEqual(blockerCandidates(tasks, 'docs', exclude).map(t => t.id), ['free'])
  assert.equal(emptySearchWords(blockerSearchNote(tasks, 'nothing', exclude)), 'No task on this board has that in its title.')
})
