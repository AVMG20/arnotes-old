// Which column moves reach agents (GH #38 slice B): the four default columns, and any column an enabled rule chooses.
// Pure: moveWatch.ts has no imports, so this needs no database and no network.
//   node --import tsx --test tests/agent-move-watch.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MOVE_WINDOW_MS, agentHearsMove, createMoveCoalescer, isDefaultMoveColumn, isMoveTriggerFor, moveRecipients } from '../server/utils/moveWatch'

const custom = { id: 'col-review', name: 'Review' }
const verify = { id: 'col-v', name: 'Verify' }
const todo = { id: 'col-t', name: 'To do' }

test('the four default columns always reach agents, whatever the rules say', () => {
  assert.equal(agentHearsMove(verify, []), true)
  assert.equal(agentHearsMove({ id: 'x', name: 'Ready for live' }, []), true)
  assert.equal(agentHearsMove({ id: 'y', name: 'Done' }, []), true)
  assert.equal(agentHearsMove({ id: 'z', name: 'Bugs' }, []), true)
})

test('an ordinary column reaches agents only when an enabled rule chooses it', () => {
  assert.equal(agentHearsMove(todo, []), false)
  assert.equal(agentHearsMove(todo, [{ kind: 'task_moved', columnId: 'col-review' }]), false)
  assert.equal(agentHearsMove(custom, [{ kind: 'task_moved', columnId: 'col-review' }]), true)
})

test('a rule that is not a move into the column does not choose it', () => {
  assert.equal(agentHearsMove(custom, [{ kind: 'task_added' }]), false)
  assert.equal(agentHearsMove(custom, [{ kind: 'task_assigned', assigneeId: 'col-review' }]), false)
})

test('malformed trigger values are never a match', () => {
  assert.equal(isMoveTriggerFor(null, 'col-review'), false)
  assert.equal(isMoveTriggerFor('task_moved', 'col-review'), false)
  assert.equal(isMoveTriggerFor({ kind: 'task_moved' }, 'col-review'), false)
  assert.equal(isMoveTriggerFor({ kind: 'task_moved', columnId: 'other' }, 'col-review'), false)
})

test('default column names are matched without case', () => {
  assert.equal(isDefaultMoveColumn('READY FOR LIVE'), true)
  assert.equal(isDefaultMoveColumn('Review'), false)
})

// Recipients: the card's people and the crew pm, once each, never the mover.
test('a move reaches the assignee, the creator and the pm, not the mover', () => {
  const task = { assigneeId: 'ann', createdBy: 'bob' }
  assert.deepEqual(moveRecipients(task, 'mover', ['pm-1']).sort(), ['ann', 'bob', 'pm-1'])
  assert.deepEqual(moveRecipients(task, 'ann', ['pm-1']).sort(), ['bob', 'pm-1'])
  assert.deepEqual(moveRecipients({ assigneeId: null, createdBy: 'ann' }, null, ['ann']), ['ann'])
})

// The coalescer, driven by a fake clock and a scheduler the test runs by hand.
function harness() {
  let at = 1_000
  const sent: { key: string, more: number, payload: string }[] = []
  const timers: { fn: () => void, ms: number }[] = []
  const coalescer = createMoveCoalescer<string>({
    send: (payload, more) => sent.push({ key: payload, more, payload }),
    now: () => at,
    schedule: (fn, ms) => timers.push({ fn, ms })
  })
  const advance = (ms: number) => {
    at += ms
  }
  const fire = () => {
    for (const timer of timers.splice(0)) timer.fn()
  }
  return { coalescer, sent, timers, advance, fire }
}

test('the first move in a window is sent at once, the rest are counted into one summary', () => {
  const h = harness()
  assert.equal(h.coalescer.offer('board|pm|internal', 'card-1'), true)
  assert.equal(h.coalescer.offer('board|pm|internal', 'card-2'), false)
  assert.equal(h.coalescer.offer('board|pm|internal', 'card-3'), false)
  assert.deepEqual(h.sent, [{ key: 'card-1', more: 0, payload: 'card-1' }])
  assert.equal(h.timers[0]?.ms, MOVE_WINDOW_MS)
  h.fire()
  assert.deepEqual(h.sent.at(-1), { key: 'card-3', more: 2, payload: 'card-3' })
  assert.equal(h.coalescer.openWindows(), 0)
})

test('a window with no further moves sends no summary', () => {
  const h = harness()
  h.coalescer.offer('k', 'only')
  h.fire()
  assert.equal(h.sent.length, 1)
})

test('bulk move of 200 cards is at most two events for one recipient on one board', () => {
  const h = harness()
  for (let i = 0; i < 200; i++) h.coalescer.offer('board|pm|internal', `card-${i}`)
  h.fire()
  assert.equal(h.sent.length, 2)
  assert.equal(h.sent[1]?.more, 199)
})

test('keys are separate: another person, board or visibility gets its own first move', () => {
  const h = harness()
  assert.equal(h.coalescer.offer('board|ann|internal', 'a'), true)
  assert.equal(h.coalescer.offer('board|ann|customer', 'b'), true)
  assert.equal(h.coalescer.offer('other|ann|internal', 'c'), true)
  assert.equal(h.sent.length, 3)
})

test('a new window starts after the old one closes, and expired state is swept', () => {
  const h = harness()
  h.coalescer.offer('k', 'first')
  h.coalescer.offer('k', 'second')
  h.advance(MOVE_WINDOW_MS)
  // The window has expired: the next move starts a new one at once, and the old summary goes out first.
  assert.equal(h.coalescer.offer('k', 'third'), true)
  assert.deepEqual(h.sent.map(s => s.more), [0, 1, 0])
  h.advance(MOVE_WINDOW_MS)
  assert.equal(h.coalescer.offer('other', 'x'), true)
  assert.equal(h.coalescer.openWindows(), 1)
})

test('a timer from an old window does not close a newer one for the same key', () => {
  const h = harness()
  h.coalescer.offer('k', 'first')
  const stale = h.timers.splice(0)
  h.advance(MOVE_WINDOW_MS)
  h.coalescer.offer('k', 'second')
  stale.forEach(t => t.fn())
  assert.equal(h.coalescer.openWindows(), 1)
})
