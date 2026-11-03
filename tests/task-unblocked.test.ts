// The "unblocked" news (GH #36 slice 5): when the last open blocker of a task finishes, the assignee gets an
// Inbox note and an agent event, and the crew's pm gets the event. These are the pure rules and the audience
// of the event; the database side is checked live on a scratch board.
//   node --import tsx --test tests/task-unblocked.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AgentEventHub, deliverableTo, emitAgentEventWith, isAgentEventKind } from '../server/utils/agentEvents'
import type { AgentBoard, AgentEventInput, AudienceLookups, StreamKey } from '../server/utils/agentEvents'

import { MARKED_DONE, REOPENED, createNoteCoalescer, freedByBulk, unblockBody, unblockedEvent, unblockedIds, unblockedRecipients, waitingOn, wasUnfinished } from '../server/utils/unblockedWatch'

const DAY = 24 * 60 * 60_000
const BASE = 1_000_000

test('the kind is a known agent event kind', () => {
  assert.equal(isAgentEventKind('unblocked'), true)
  assert.equal(isAgentEventKind('unblock'), false)
})

test('a move from an unfinished column into a finished one is the unblocking change', () => {
  assert.equal(wasUnfinished({ changes: ['Moved to Done'], completedNow: false, columnNowFinished: true, movedFromFinished: false }), true)
})

test('a move between two finished columns (Ready for live to Done) is not a second unblock', () => {
  assert.equal(wasUnfinished({ changes: ['Moved to Done'], completedNow: false, columnNowFinished: true, movedFromFinished: true }), false)
})

test('a move out of a finished column is not an unblock (the task is unfinished now)', () => {
  // Only called when the task is finished now; the caller checks that first, so a move that unfinishes it is not reached.
  assert.equal(wasUnfinished({ changes: ['Moved to To do'], completedNow: false, columnNowFinished: false, movedFromFinished: true }), false)
})

test('a move whose previous column cannot be read tells nothing', () => {
  assert.equal(wasUnfinished({ changes: ['Moved to Done'], completedNow: false, columnNowFinished: true, movedFromFinished: null }), false)
})

test('completing a task that sat in an unfinished column is the unblocking change', () => {
  assert.equal(wasUnfinished({ changes: [MARKED_DONE], completedNow: true, columnNowFinished: false, movedFromFinished: null }), true)
})

test('completing a task already in a finished column is not an unblock', () => {
  assert.equal(wasUnfinished({ changes: [MARKED_DONE], completedNow: true, columnNowFinished: true, movedFromFinished: null }), false)
})

test('a move and a completion in one save are read together', () => {
  // Moved from an unfinished column into Done and marked done: unfinished before, so one unblock.
  assert.equal(wasUnfinished({ changes: ['Moved to Done', MARKED_DONE], completedNow: true, columnNowFinished: true, movedFromFinished: false }), true)
})

test('reopening a completed task in a finished column was finished before, so nothing is told', () => {
  assert.equal(wasUnfinished({ changes: [REOPENED], completedNow: false, columnNowFinished: true, movedFromFinished: null }), false)
})

test('trashing an unfinished blocker is the unblocking change; trashing a finished one is not', () => {
  // The trash paths pass no changes: the column and the completion are as they were.
  assert.equal(wasUnfinished({ changes: [], completedNow: false, columnNowFinished: false, movedFromFinished: null }), true)
  assert.equal(wasUnfinished({ changes: [], completedNow: false, columnNowFinished: true, movedFromFinished: null }), false)
  assert.equal(wasUnfinished({ changes: [], completedNow: true, columnNowFinished: false, movedFromFinished: null }), false)
})

test('only dependents that are no longer blocked are told; the rest stay blocked', () => {
  const states = new Map([
    ['still', { blocked: true }],
    ['free', { blocked: false }],
    ['also-free', { blocked: false }]
  ])
  assert.deepEqual(unblockedIds(['still', 'free', 'also-free'], states), ['free', 'also-free'])
})

test('a dependent with no state read is not told', () => {
  assert.deepEqual(unblockedIds(['unknown'], new Map()), [])
})

test('the assignee and the pm hear it, once each, never the person who made the change', () => {
  assert.deepEqual(unblockedRecipients('ann', 'bob', ['pm-1', 'ann']), ['ann', 'pm-1'])
  assert.deepEqual(unblockedRecipients('ann', 'ann', ['pm-1']), ['pm-1'])
  assert.deepEqual(unblockedRecipients(null, 'bob', ['pm-1']), ['pm-1'])
})

// The audience of the event, as the hub reads it: the crew's pm and a staff member see an internal task; a
// customer contact sees only a customer-visible one, and no internal detail reaches them.
function makeHub() {
  const time = BASE
  return new AgentEventHub({
    maxConnections: 200,
    perUserStreams: 3,
    pingMs: 60_000,
    recheckMs: 60_000,
    queueLimitBytes: 256 * 1024,
    backlogEvents: 500,
    backlogTotal: 100_000,
    backlogMs: DAY,
    connectsPerMinute: 30,
    now: () => time
  })
}

function open(hub: AgentEventHub, streamKey: StreamKey) {
  const slot = hub.reserve(streamKey)
  if (typeof slot === 'string') throw new Error(`reserve refused: ${slot}`)
  const chunks: string[] = []
  const connection = {
    chunks,
    ended: false,
    aborted: false,
    queued: 0,
    write(chunk: string) { chunks.push(chunk) },
    pending() { return this.queued },
    end() { this.ended = true },
    abort() { this.aborted = true }
  }
  assert.equal(slot.activate(undefined, connection, { teamIds: ['crew-team'], customerIds: [] }, async () => null), true)
  return { text: () => chunks.join('') }
}

const crewBoard: AgentBoard = { id: 'board-1', userId: 'owner', teamId: 'crew-team', customerId: 'cust-1' }

function lookups(contacts: Record<string, string[]> = {}): AudienceLookups {
  return {
    isMember: async (userId, teamId) => teamId === 'crew-team' && (userId === 'pm-1' || userId === 'ann'),
    customerIds: async userId => contacts[userId] ?? []
  }
}

function unblocked(customerVisible: boolean): AgentEventInput {
  return {
    kind: 'unblocked',
    board: crewBoard,
    task: { id: 'task-9', title: 'Ship the parser', assigneeId: 'ann' },
    from: 'Bob',
    customerVisible
  }
}

test('an internal unblock reaches the assignee and the pm, not a customer contact', async () => {
  const hub = makeHub()
  const ann = open(hub, { keyId: 'k-ann', userId: 'ann', teamId: 'crew-team' })
  const pm = open(hub, { keyId: 'k-pm', userId: 'pm-1', teamId: 'crew-team' })
  const contact = open(hub, { keyId: 'k-contact', userId: 'contact-1', teamId: null })
  const contactLookups: AudienceLookups = { isMember: lookups().isMember, customerIds: async userId => userId === 'contact-1' ? ['cust-1'] : [] }

  assert.equal(await emitAgentEventWith(hub, lookups(), 'ann', unblocked(false)), true)
  assert.equal(await emitAgentEventWith(hub, lookups(), 'pm-1', unblocked(false)), true)
  assert.equal(await emitAgentEventWith(hub, contactLookups, 'contact-1', unblocked(false)), false)

  assert.match(ann.text(), /^event: unblocked$/m)
  assert.match(pm.text(), /^event: unblocked$/m)
  assert.equal(contact.text(), '')
})

test('a customer-visible unblock reaches the customer contact too', async () => {
  const hub = makeHub()
  const contact = open(hub, { keyId: 'k-contact', userId: 'contact-1', teamId: null })
  const contactLookups: AudienceLookups = { isMember: async () => false, customerIds: async userId => userId === 'contact-1' ? ['cust-1'] : [] }
  assert.equal(await emitAgentEventWith(hub, contactLookups, 'contact-1', unblocked(true)), true)
  assert.match(contact.text(), /^event: unblocked$/m)
  assert.equal(deliverableTo({ audience: 'customer', teamId: null }, null), true)
})

test('an Inbox note for a window waits for the window to close, and counts the rest', () => {
  const sent: { first: string, more: number }[] = []
  const timers: { fn: () => void, ms: number }[] = []
  const notes = createNoteCoalescer<string>({ send: (first, more) => sent.push({ first, more }), windowMs: 30_000, schedule: (fn, ms) => timers.push({ fn, ms }) })
  notes.offer('board|ann', 'Ship the parser')
  notes.offer('board|ann', 'Fix the lexer')
  notes.offer('board|ann', 'Tidy the docs')
  assert.deepEqual(sent, [])
  assert.equal(timers.length, 1)
  assert.equal(timers[0]!.ms, 30_000)
  timers[0]!.fn()
  assert.deepEqual(sent, [{ first: 'Ship the parser', more: 2 }])
  assert.equal(notes.openWindows(), 0)
})

test('an Inbox note for another assignee, or after its window closed, is a note of its own', () => {
  const sent: { first: string, more: number }[] = []
  const timers: { fn: () => void, ms: number }[] = []
  const notes = createNoteCoalescer<string>({ send: (first, more) => sent.push({ first, more }), schedule: (fn, ms) => timers.push({ fn, ms }) })
  notes.offer('board|ann', 'A')
  notes.offer('board|bob', 'B')
  timers[0]!.fn()
  timers[1]!.fn()
  notes.offer('board|ann', 'C')
  timers[2]!.fn()
  assert.deepEqual(sent, [{ first: 'A', more: 0 }, { first: 'B', more: 0 }, { first: 'C', more: 0 }])
})

test('a summary of unblocks keeps who acted as from, and says how many more it stands for', () => {
  const board = { id: 'board-1', name: 'Board', userId: 'owner', teamId: 'crew-team', customerId: null }
  const payload = { recipient: 'ann', board, task: { id: 'task-9', title: 'Ship the parser', visibility: 'internal' as const, assigneeId: 'ann' }, from: 'Bob', customerVisible: false }
  assert.deepEqual(unblockedEvent(payload, 0), { kind: 'unblocked', board, task: payload.task, from: 'Bob', customerVisible: false })
  assert.deepEqual(unblockedEvent(payload, 3), { kind: 'unblocked', board, task: payload.task, from: 'Bob', count: 3, customerVisible: false })
})

test('a dependent that waited for two freed blockers is one entry; the note names a blocker only when it is the one customer-visible blocker', () => {
  const links: Parameters<typeof waitingOn>[0] = [
    { blockerId: 'b1', id: 'dep', title: 'Dependent', visibility: 'internal', assigneeId: 'ann', createdBy: 'bob' },
    { blockerId: 'b2', id: 'dep', title: 'Dependent', visibility: 'internal', assigneeId: 'ann', createdBy: 'bob' },
    { blockerId: 'gone', id: 'other', title: 'Other', visibility: 'internal', assigneeId: null, createdBy: null }
  ]
  const blockers = [{ id: 'b1', title: 'Parser', visibility: 'customer' as const }, { id: 'b2', title: 'Lexer', visibility: 'internal' as const }]
  const waiting = waitingOn(links, blockers)
  assert.deepEqual([...waiting.keys()], ['dep'])
  const freedBy = waiting.get('dep')!.freedBy
  assert.equal(freedBy.length, 2)
  assert.equal(unblockBody(freedBy), 'A task it waited for is finished.')
  assert.equal(unblockBody([blockers[0]!]), '"Parser" is finished.')
  assert.equal(unblockBody([blockers[1]!]), 'A task it waited for is finished.')
})

test('a column delete that frees two blockers of one dependent, while another stays blocked, tells the freed dependent once', () => {
  const finished = new Set(['done'])
  const rows = [
    { id: 'b1', columnId: 'todo', completedAt: null, deletedAt: 5 },
    { id: 'b2', columnId: 'done', completedAt: null, deletedAt: null },
    { id: 'b3', columnId: 'todo', completedAt: null, deletedAt: null }
  ]
  const freedIds = freedByBulk(['b1', 'b2', 'b3'], rows, finished)
  assert.deepEqual(freedIds, ['b1', 'b2'])
  const links: Parameters<typeof waitingOn>[0] = [
    { blockerId: 'b1', id: 'freed', title: 'Freed', visibility: 'internal', assigneeId: 'ann', createdBy: null },
    { blockerId: 'b2', id: 'freed', title: 'Freed', visibility: 'internal', assigneeId: 'ann', createdBy: null },
    { blockerId: 'b1', id: 'held', title: 'Held', visibility: 'internal', assigneeId: 'ann', createdBy: null },
    { blockerId: 'b3', id: 'held', title: 'Held', visibility: 'internal', assigneeId: 'ann', createdBy: null }
  ]
  const waiting = waitingOn(links, freedIds.map(id => ({ id, title: id, visibility: 'internal' as const })))
  assert.equal(waiting.get('freed')!.freedBy.length, 2)
  const freed = unblockedIds([...waiting.keys()], new Map([['freed', { blocked: false }], ['held', { blocked: true }]]))
  assert.deepEqual(freed, ['freed'])
})

test('a bulk change frees the blockers it finished: trashed ones and ones moved into a finished column, not the rest', () => {
  const finished = new Set(['done'])
  const rows = [
    { id: 'trashed', columnId: 'todo', completedAt: null, deletedAt: 5 },
    { id: 'moved-done', columnId: 'done', completedAt: null, deletedAt: null },
    { id: 'moved-todo', columnId: 'todo', completedAt: null, deletedAt: null }
  ]
  assert.deepEqual(freedByBulk(['trashed', 'moved-done', 'moved-todo', 'not-read'], rows, finished), ['trashed', 'moved-done'])
  assert.deepEqual(freedByBulk([], rows, finished), [])
})
