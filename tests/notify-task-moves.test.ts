// The not-recipient cases of a task move (GH #38 slice B, Boss's should on #41): a customer contact, another crew,
// a personal board, the summary count. tellAgentsOfMove reads the database, so these run on its seams: the audience
// (emitAgentEventWith on a hub), the crew of a team (crewPeopleFrom), the recipients (moveRecipients) and the
// coalescer. No database and no network.
//   node --import tsx --test tests/notify-task-moves.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AgentEventHub, crewPeopleFrom, deliverableTo, emitAgentEventWith } from '../server/utils/agentEvents'
import type { AgentBoard, AgentEventInput, AudienceLookups, StreamKey } from '../server/utils/agentEvents'
import { MOVE_WINDOW_MS, createMoveCoalescer, moveRecipients } from '../server/utils/moveWatch'

const DAY = 24 * 60 * 60_000
const BASE = 1_000_000

function makeHub() {
  let time = BASE
  const hub = new AgentEventHub({
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
  const advance = (ms: number) => {
    time += ms
  }
  return { hub, advance }
}

/** Opens a stream for a key, as the route does, and returns what it is sent. */
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
  assert.equal(slot.activate(undefined, connection, { teamIds: [], customerIds: [] }, async () => null), true)
  return { text: () => chunks.join('') }
}

function lookups(members: Record<string, string[]> = {}, contacts: Record<string, string[]> = {}): AudienceLookups {
  return {
    isMember: async (userId, teamId) => (members[userId] ?? []).includes(teamId),
    customerIds: async userId => contacts[userId] ?? []
  }
}

// A move event as notifyEvents.ts builds it for one recipient.
function moveFor(board: AgentBoard, customerVisible: boolean, recipient: string): AgentEventInput {
  return {
    kind: 'task_moved',
    board,
    task: { id: 'task-1', title: 'Card', assigneeId: recipient },
    from: 'Sam',
    customerVisible
  }
}

const teamBoard: AgentBoard = { id: 'board-team', userId: 'owner', teamId: 'team-a', customerId: null }
const customerBoard: AgentBoard = { id: 'board-acme', userId: 'owner', teamId: null, customerId: 'acme' }
const personalBoard: AgentBoard = { id: 'board-mine', userId: 'ann', teamId: null, customerId: null }

test('a customer contact is never sent an internal move, and gets only the customer-visible one', async () => {
  const { hub } = makeHub()
  const contact = open(hub, { keyId: 'k-contact', userId: 'contact', teamId: null })
  const people = lookups({}, { contact: ['acme'] })

  assert.equal(await emitAgentEventWith(hub, people, 'contact', moveFor(customerBoard, false, 'contact')), false)
  assert.equal(contact.text(), '')

  assert.equal(await emitAgentEventWith(hub, people, 'contact', moveFor(customerBoard, true, 'contact')), true)
  assert.match(contact.text(), /^event: task_moved$/m)
})

test('another crew\'s key is not a recipient of a team move, and a crew with no single row has no pm', async () => {
  const { hub } = makeHub()
  const crewB = open(hub, { keyId: 'k-crew-b', userId: 'crew-b-pm', teamId: 'team-b' })
  const sent = await emitAgentEventWith(hub, lookups({ 'crew-b-pm': ['team-b'] }), 'crew-b-pm', moveFor(teamBoard, false, 'crew-b-pm'))
  assert.equal(sent, false)
  assert.equal(crewB.text(), '')

  // The pm of team-a is found only through a crew row for team-a, and only when exactly one crew has it.
  const accounts = [{ id: 'pm-a', email: 'a-pm@crew.invalid', crewId: 'crew-a' }]
  assert.deepEqual(crewPeopleFrom([{ id: 'crew-a', slug: 'a' }], accounts), [{ userId: 'pm-a', key: 'pm' }])
  assert.deepEqual(crewPeopleFrom([{ id: 'crew-a', slug: 'a' }, { id: 'crew-x', slug: 'x' }], accounts), [])
  // A team-pinned key sees only its own team's staff events.
  assert.equal(deliverableTo({ audience: 'staff', teamId: 'team-a' }, 'team-b'), false)
})

test('a personal board reaches its owner only: no crew pm is added, and another user is not a recipient', async () => {
  // tellAgentsOfMove adds the crew pm only when the board has a team, so a personal board's recipients are the card's people.
  assert.deepEqual(moveRecipients({ assigneeId: 'ann', createdBy: 'ann' }, 'ann', []), [])
  assert.deepEqual(moveRecipients({ assigneeId: 'ann', createdBy: 'ann' }, 'mover', []), ['ann'])

  const { hub } = makeHub()
  const ann = open(hub, { keyId: 'k-ann', userId: 'ann', teamId: null })
  assert.equal(await emitAgentEventWith(hub, lookups(), 'ann', moveFor(personalBoard, false, 'ann')), true)
  assert.match(ann.text(), /^event: task_moved$/m)

  const bob = open(hub, { keyId: 'k-bob', userId: 'bob', teamId: null })
  assert.equal(await emitAgentEventWith(hub, lookups(), 'bob', moveFor(personalBoard, false, 'ann')), false)
  assert.equal(bob.text(), '')
})

test('a summary goes out only when moves were counted: one move in a window sends nothing more', () => {
  const sent: { payload: string, more: number }[] = []
  const timers: { fn: () => void, ms: number }[] = []
  let at = 1_000
  const coalescer = createMoveCoalescer<string>({
    send: (payload, more) => sent.push({ payload, more }),
    now: () => at,
    schedule: (fn, ms) => timers.push({ fn, ms })
  })
  coalescer.offer('board|pm|internal', 'only')
  assert.equal(timers[0]?.ms, MOVE_WINDOW_MS)
  at += MOVE_WINDOW_MS
  for (const timer of timers.splice(0)) timer.fn()
  assert.deepEqual(sent, [{ payload: 'only', more: 0 }])
})
