// The agent event stream (CH1). The hub, the audience, the frames and the stream lifecycle
// run on their own; the live cases need a dev server and a key that is not valid:
//   node --env-file-if-exists=.env --import tsx --test tests/agent-events.test.ts
// Set AGENT_EVENTS_LIVE=1 to run them (AGENT_EVENTS_BASE, default http://localhost:3000).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AgentEventHub, audienceOfEvent, cleanEventText, deliverableTo, emitAgentEventWith, emitInBackground,
  crewPeopleFrom, emitGithubEventWith, frameOfEvent, GITHUB_EVENT_KINDS, githubAudience, parseLastEventId, replyRecipients, stillMember
} from '../server/utils/agentEvents'
import type { AgentEventInput, AgentEventRecord, AudienceLookups, CloseReason, GithubEventKind, GithubLookups, Membership, StreamKey, Verify } from '../server/utils/agentEvents'

const DAY = 24 * 60 * 60_000
const BASE = 1_000_000

class FakeConnection {
  chunks: string[] = []
  ended = false
  aborted = false
  queued = 0
  failWrites = false
  write(chunk: string) {
    if (this.failWrites) throw new Error('socket gone')
    this.chunks.push(chunk)
  }

  pending() {
    return this.queued
  }

  end() {
    this.ended = true
  }

  abort() {
    this.aborted = true
  }

  text() { return this.chunks.join('') }
}

function makeHub(overrides: Partial<ConstructorParameters<typeof AgentEventHub>[0]> = {}) {
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
    now: () => time,
    ...overrides
  })
  return {
    hub,
    advance: (ms: number) => {
      time += ms
    }
  }
}

const noVerify: Verify = async () => null

/** Takes a slot and opens it, as the route does. Returns the connection and the slot. */
function open(hub: AgentEventHub, key: StreamKey, lastEventId?: number, membership: Membership = { teamIds: [], customerIds: [] }, verify: Verify = noVerify) {
  const slot = hub.reserve(key)
  if (typeof slot === 'string') throw new Error(`reserve refused: ${slot}`)
  const connection = new FakeConnection()
  assert.equal(slot.activate(lastEventId, connection, membership, verify), true)
  return { connection, slot }
}

function kept(over: Partial<Omit<AgentEventRecord, 'id' | 'at'>> = {}): Omit<AgentEventRecord, 'id' | 'at'> {
  return {
    kind: 'task_moved', board: 'board-1', task: 'task-1', from: 'Sam', origin: null, title: 'Card',
    ref: null, needsFeedbackFromMe: false, assignedToMe: false, isPm: false, isBoss: false, audience: 'staff', teamId: null, customerId: null, ...over
  }
}

const teamBoard = { id: 'board-1', userId: 'pm', teamId: 'team-a', customerId: null }
const customerBoard = { id: 'board-2', userId: 'pm', teamId: null, customerId: 'acme' }

function eventFor(over: Partial<AgentEventInput> = {}): AgentEventInput {
  return {
    kind: 'task_created',
    board: teamBoard,
    task: { id: 'task-1', title: 'Fix the thing', assigneeId: null },
    from: 'Sam',
    origin: 'agent',
    customerVisible: false,
    ...over
  }
}

function lookups(members: Record<string, string[]> = {}, contacts: Record<string, string[]> = {}): AudienceLookups {
  return {
    isMember: async (userId, teamId) => (members[userId] ?? []).includes(teamId),
    customerIds: async userId => contacts[userId] ?? []
  }
}

const ids = (text: string) => [...text.matchAll(/^id: (\d+)$/gm)].map(match => Number(match[1]))
const key = (keyId: string, userId: string, teamId: string | null = null): StreamKey => ({ keyId, userId, teamId })

// ── Live: a request with no valid key is refused ──────────────────────

const LIVE = process.env.AGENT_EVENTS_LIVE === '1'
const BASE_URL = process.env.AGENT_EVENTS_BASE ?? 'http://localhost:3000'

test('live: a request with no key is refused with 401', { skip: !LIVE }, async () => {
  const res = await fetch(`${BASE_URL}/api/agent/events`)
  assert.equal(res.status, 401)
  await res.body?.cancel()
})

test('live: a key that is not in the database is refused with 401', { skip: !LIVE }, async () => {
  const res = await fetch(`${BASE_URL}/api/agent/events`, { headers: { Authorization: 'Bearer arn_not-a-real-key' } })
  assert.equal(res.status, 401)
  await res.body?.cancel()
})

// ── Audience ──────────────────────────────────────────────────────────

test('audience: staff see everything, a contact only what is customer-visible, anyone else nothing', () => {
  assert.equal(audienceOfEvent(false, { staff: true, contact: false }), 'staff')
  assert.equal(audienceOfEvent(true, { staff: true, contact: false }), 'staff')
  assert.equal(audienceOfEvent(true, { staff: false, contact: true }), 'customer')
  assert.equal(audienceOfEvent(false, { staff: false, contact: true }), null)
  assert.equal(audienceOfEvent(true, { staff: false, contact: false }), null)
})

test('a customer contact never gets an internal event, and gets the customer-visible one', async () => {
  const { hub } = makeHub()
  const { connection } = open(hub, key('k-contact', 'contact'))
  const people = lookups({}, { contact: ['acme'] })

  assert.equal(await emitAgentEventWith(hub, people, 'contact', eventFor({ board: customerBoard, customerVisible: false })), false)
  assert.equal(connection.text(), '')

  assert.equal(await emitAgentEventWith(hub, people, 'contact', eventFor({ board: customerBoard, customerVisible: true })), true)
  assert.match(connection.text(), /^event: task_created$/m)
})

test('a user nobody has streamed to gets nothing kept or sent', async () => {
  const { hub } = makeHub()
  assert.equal(await emitAgentEventWith(hub, lookups({ stranger: ['team-a'] }), 'stranger', eventFor()), false)
  assert.equal(hub.watches('stranger'), false)
})

test('emitInBackground does no work while nobody is watched', () => {
  let ran = 0
  emitInBackground(async () => {
    ran++
  })
  assert.equal(ran, 0)
})

// ── Crew isolation and membership ─────────────────────────────────────

test('crew isolation: a crew member is not told of another crew\'s board', async () => {
  const { hub } = makeHub()
  const { connection } = open(hub, key('k-crew-b', 'crew-b-worker', 'team-b'))
  const emitted = await emitAgentEventWith(hub, lookups({ 'crew-b-worker': ['team-b'] }), 'crew-b-worker', eventFor({ board: teamBoard }))
  assert.equal(emitted, false)
  assert.equal(connection.text(), '')
})

test('crew isolation: a team-pinned key gets only that team\'s staff events, a personal key none of them', () => {
  const teamEvent = { audience: 'staff' as const, teamId: 'team-a' }
  assert.equal(deliverableTo(teamEvent, 'team-a'), true)
  assert.equal(deliverableTo(teamEvent, 'team-b'), false)
  assert.equal(deliverableTo(teamEvent, null), false)
  assert.equal(deliverableTo({ audience: 'staff', teamId: null }, null), true)
  assert.equal(deliverableTo({ audience: 'staff', teamId: null }, 'team-a'), false)
  assert.equal(deliverableTo({ audience: 'customer', teamId: 'team-a' }, null), true)
  assert.equal(deliverableTo({ audience: 'customer', teamId: 'team-a' }, 'team-a'), false)
})

test('a resume replays nothing of a team or customer the user has left', () => {
  const teamA = { ...kept({ teamId: 'team-a' }), id: 1, at: 0 }
  const acme = { ...kept({ audience: 'customer', teamId: null, customerId: 'acme' }), id: 2, at: 0 }
  const own = { ...kept({ teamId: null }), id: 3, at: 0 }
  assert.equal(stillMember(teamA, { teamIds: ['team-b'], customerIds: [] }), false)
  assert.equal(stillMember(teamA, { teamIds: ['team-a'], customerIds: [] }), true)
  assert.equal(stillMember(acme, { teamIds: [], customerIds: [] }), false)
  assert.equal(stillMember(acme, { teamIds: [], customerIds: ['acme'] }), true)
  assert.equal(stillMember(own, { teamIds: [], customerIds: [] }), true)
})

test('a resume after a team was left replays only what the user still belongs to', () => {
  const { hub } = makeHub()
  const seed = open(hub, key('k-seed', 'u-member'))
  seed.slot.release()
  hub.publish('u-member', kept({ teamId: 'team-a' }))
  hub.publish('u-member', kept({ teamId: 'team-b' }))
  hub.publish('u-member', kept({ teamId: null }))
  const pinned = open(hub, key('k-resume', 'u-member', 'team-a'), BASE - 1, { teamIds: [], customerIds: [] })
  assert.deepEqual(ids(pinned.connection.text()), [], 'a team the user left is not replayed')
  const { connection } = open(hub, key('k-own', 'u-member'), BASE - 1, { teamIds: [], customerIds: [] })
  assert.deepEqual(ids(connection.text()), [BASE + 2], 'the personal event is still replayed')
})

// ── Frames and text ───────────────────────────────────────────────────

test('SSE injection: a title with newlines and a fake event line stays one data field', async () => {
  const { hub } = makeHub()
  const { connection } = open(hub, key('k-pm', 'pm', 'team-a'))
  const hostile = 'Fix\nevent: task_moved\r\ndata: {"x":1}' + String.fromCharCode(0x2028) + ' more\0'
  await emitAgentEventWith(hub, lookups({ pm: ['team-a'] }), 'pm', eventFor({ task: { id: 'task-9', title: hostile } }))

  const lines = connection.text().split('\n')
  assert.deepEqual(lines.slice(0, 4).map(line => line.split(':')[0]), ['id', 'event', 'data', ''])
  assert.equal(lines[1], 'event: task_created')
  assert.equal(lines.filter(line => line.startsWith('event:')).length, 1)
  assert.equal(connection.text().split('').filter(ch => ch === '\r' || ch === String.fromCharCode(0x2028) || ch === '\0').length, 0)
  assert.equal(JSON.parse(lines[2]!.slice('data: '.length)).title, 'Fixevent: task_moveddata: {"x":1} more')
})

test('a title is cut to 120 characters, counted as characters not bytes', () => {
  assert.equal(cleanEventText('a'.repeat(300)).length, 120)
  assert.equal(Array.from(cleanEventText('\u{1F600}'.repeat(130))).length, 120)
  assert.equal(cleanEventText('short'), 'short')
})

test('the frame carries ids, the flags and the cut title, and no other field', () => {
  const record: AgentEventRecord = { ...kept({ kind: 'task_created', origin: 'agent', title: 'x', assignedToMe: true }), id: 7, at: 0, customerId: null }
  const frame = frameOfEvent(record)
  assert.ok(frame.startsWith('id: 7\nevent: task_created\ndata: '))
  assert.ok(frame.endsWith('\n\n'))
  const data = JSON.parse(frame.split('\n')[2]!.slice('data: '.length))
  assert.deepEqual(Object.keys(data), ['kind', 'task', 'board', 'from', 'origin', 'title', 'ref', 'needs_feedback_from_me', 'assigned_to_me', 'is_pm', 'is_boss'])
  assert.equal(data.origin, 'agent')
  assert.equal(data.assigned_to_me, true)
})

test('assigned_to_me is true only when the card is assigned to this user at emit time', async () => {
  const { hub } = makeHub()
  const { connection } = open(hub, key('k-w', 'worker', 'team-a'))
  await emitAgentEventWith(hub, lookups({ worker: ['team-a'] }), 'worker', eventFor({ board: teamBoard, task: { id: 't1', title: 'mine', assigneeId: 'worker' } }))
  await emitAgentEventWith(hub, lookups({ worker: ['team-a'] }), 'worker', eventFor({ board: teamBoard, task: { id: 't2', title: 'theirs', assigneeId: 'other' } }))
  const flags = [...connection.text().matchAll(/"assigned_to_me":(true|false)/g)].map(match => match[1])
  assert.deepEqual(flags, ['true', 'false'])
})

// ── GitHub events: who hears them ─────────────────────────────────────

/** The data of each frame a connection was sent, parsed. */
function framesOf(connection: FakeConnection): Record<string, unknown>[] {
  return connection.text().split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice('data: '.length)))
}

const crewBoard = { id: 'board-c', userId: 'pm-user', teamId: 'team-c', customerId: null }
const crewMembers = { 'pm-user': ['team-c'], 'boss-user': ['team-c'], 'w1-user': ['team-c'], 'w2-user': ['team-c'] }
const crewPeople = [
  { userId: 'pm-user', key: 'pm' },
  { userId: 'boss-user', key: 'boss' },
  { userId: 'w1-user', key: 'w1' },
  { userId: 'w2-user', key: 'w2' }
]

function githubLookups(members: Record<string, string[]>, people: { userId: string, key: string }[], contacts: Record<string, string[]> = {}): GithubLookups {
  return { ...lookups(members, contacts), crewPeople: async () => people }
}

/** A stream for each of the users, all team-pinned to the team, and their connections by user. */
function streamsFor(hub: AgentEventHub, users: string[], teamId: string) {
  return Object.fromEntries(users.map(user => [user, open(hub, key(`k-${user}`, user, teamId), undefined, { teamIds: [teamId], customerIds: [] }).connection]))
}

test('GitHub audience: owners and the pm hear all four; the boss the merges and a passed pipeline in Verify only', () => {
  const owner = { owner: true, pm: false, boss: false }
  const pm = { owner: false, pm: true, boss: false }
  const boss = { owner: false, pm: false, boss: true }
  const nobody = { owner: false, pm: false, boss: false }
  for (const kind of GITHUB_EVENT_KINDS) {
    assert.equal(githubAudience(kind, owner, false), true)
    assert.equal(githubAudience(kind, pm, false), true)
    assert.equal(githubAudience(kind, nobody, true), false)
  }
  assert.equal(githubAudience('pipeline_failed', boss, true), false)
  assert.equal(githubAudience('pipeline_passed', boss, true), true)
  assert.equal(githubAudience('pipeline_passed', boss, false), false)
  assert.equal(githubAudience('merged_staging', boss, false), true)
  assert.equal(githubAudience('merged_production', boss, false), true)
})

test('a GitHub change reaches the owners, the crew pm and boss by their rule, and no other crew member', async () => {
  const { hub } = makeHub()
  const streams = streamsFor(hub, ['pm-user', 'boss-user', 'w1-user', 'w2-user'], 'team-c')
  const crew = githubLookups(crewMembers, crewPeople)
  const task = { id: 'T1', title: 'Fix login', assigneeId: 'w1-user', createdBy: 'pm-user', column: 'Verify' }
  assert.equal(await emitGithubEventWith(hub, crew, { kind: 'pipeline_failed', board: crewBoard, task, ref: '#12 feature/login' }), 2)
  assert.equal(await emitGithubEventWith(hub, crew, { kind: 'merged_staging', board: crewBoard, task, ref: '#12 feature/login' }), 3)
  const kinds = (user: string) => framesOf(streams[user]!).map(data => data.kind)
  assert.deepEqual(kinds('pm-user'), ['pipeline_failed', 'merged_staging'])
  assert.deepEqual(kinds('w1-user'), ['pipeline_failed', 'merged_staging'], 'the assignee hears all four')
  assert.deepEqual(kinds('boss-user'), ['merged_staging'], 'Boss never hears a failed pipeline')
  assert.deepEqual(kinds('w2-user'), [], 'a worker who is not on the card hears nothing')
})

test('the frame tells the client who the recipient is: is_pm, is_boss and assigned_to_me, and the ref', async () => {
  const { hub } = makeHub()
  const streams = streamsFor(hub, ['pm-user', 'boss-user', 'w1-user'], 'team-c')
  const task = { id: 'T2', title: 'Ship it', assigneeId: 'w1-user', createdBy: 'pm-user', column: 'Verify' }
  await emitGithubEventWith(hub, githubLookups(crewMembers, crewPeople), { kind: 'pipeline_passed', board: crewBoard, task, ref: '#7' })
  const flags = (user: string) => framesOf(streams[user]!).map(data => [data.is_pm, data.is_boss, data.assigned_to_me, data.ref, data.origin])
  assert.deepEqual(flags('pm-user'), [[true, false, false, '#7', 'github']])
  assert.deepEqual(flags('boss-user'), [[false, true, false, '#7', 'github']])
  assert.deepEqual(flags('w1-user'), [[false, false, true, '#7', 'github']])
})

test('pipeline_passed reaches Boss only while the card is in Verify', async () => {
  const { hub } = makeHub()
  const streams = streamsFor(hub, ['boss-user', 'pm-user'], 'team-c')
  const task = { id: 'T3', title: 'Not yet', assigneeId: null, createdBy: 'pm-user', column: 'In progress' }
  assert.equal(await emitGithubEventWith(hub, githubLookups(crewMembers, crewPeople), { kind: 'pipeline_passed', board: crewBoard, task }), 1)
  assert.deepEqual(framesOf(streams['boss-user']!), [], 'Boss gets nothing while the card is not in Verify')
  assert.equal(await emitGithubEventWith(hub, githubLookups(crewMembers, crewPeople), { kind: 'merged_production', board: crewBoard, task }), 2)
  assert.deepEqual(framesOf(streams['boss-user']!).map(data => data.kind), ['merged_production'])
})

test('a team that is not a crew: its owners and assignee only, and nobody else on the team', async () => {
  const { hub } = makeHub()
  const board = { id: 'board-d', userId: 'owner-user', teamId: 'team-d', customerId: null }
  const streams = streamsFor(hub, ['owner-user', 'w1-user', 'other-user'], 'team-d')
  const members = { 'owner-user': ['team-d'], 'w1-user': ['team-d'], 'other-user': ['team-d'] }
  const task = { id: 'T4', title: 'Plain team', assigneeId: 'w1-user', createdBy: 'owner-user', column: 'Verify' }
  assert.equal(await emitGithubEventWith(hub, githubLookups(members, []), { kind: 'merged_staging', board, task }), 2)
  assert.deepEqual(framesOf(streams['other-user']!), [])
  assert.deepEqual(framesOf(streams['w1-user']!).map(data => data.kind), ['merged_staging'])
})

test('a customer never hears a GitHub change, even on a customer-visible card they are on', async () => {
  const { hub } = makeHub()
  const board = { id: 'board-e', userId: 'pm-user', teamId: 'team-c', customerId: 'acme' }
  const contact = open(hub, key('k-contact', 'cust-user', null), undefined, { teamIds: [], customerIds: ['acme'] }).connection
  const task = { id: 'T5', title: 'For the customer', assigneeId: 'cust-user', createdBy: 'pm-user', column: 'Verify' }
  const kept = await emitGithubEventWith(hub, githubLookups(crewMembers, crewPeople, { 'cust-user': ['acme'] }), { kind: 'merged_production', board, task })
  assert.equal(kept, 0)
  assert.deepEqual(framesOf(contact), [])
})

test('a GitHub title is cut to 120 characters and a ref to 60, both stripped of control characters; no line can break out', async () => {
  const { hub } = makeHub()
  const streams = streamsFor(hub, ['pm-user'], 'team-c')
  const hostile = `x\nevent: evil\r\ndata: {}\u2028${'y'.repeat(300)}`
  const task = { id: 'T6', title: hostile, assigneeId: null, createdBy: 'pm-user', column: 'Verify' }
  await emitGithubEventWith(hub, githubLookups(crewMembers, crewPeople), { kind: 'pipeline_failed', board: crewBoard, task, ref: `#9 ${'z'.repeat(300)}\n\u0007` })
  const [data] = framesOf(streams['pm-user']!)
  assert.equal((data!.title as string).length, 120)
  assert.equal((data!.ref as string).length, 60)
  assert.equal(data!.from, null, 'no name of a person on a GitHub event: nothing from GitHub is a person')
  const text = streams['pm-user']!.text()
  assert.ok(!/\nevent: evil/.test(text), 'the title cannot start a frame')
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u2028]/.test(text.replace(/\n/g, '')), 'no control characters or separators reach the stream')
})

test('a core event never carries a ref, and a customer-audience record never does', async () => {
  const { hub } = makeHub()
  const contact = open(hub, key('k-cust', 'cust-user', null), undefined, { teamIds: [], customerIds: ['acme'] }).connection
  const input = { ...eventFor({ kind: 'reply', board: customerBoard, customerVisible: true, task: { id: 'task-c', title: 'Visible', assigneeId: null } }), ref: '#5 leaked' } as AgentEventInput
  assert.equal(await emitAgentEventWith(hub, lookups({}, { 'cust-user': ['acme'] }), 'cust-user', input), true)
  const [data] = framesOf(contact)
  assert.equal(data!.kind, 'reply')
  assert.equal(data!.ref, null)
})

test('an unknown kind is refused: no GitHub event goes out, and no frame names one', async () => {
  const { hub } = makeHub()
  const streams = streamsFor(hub, ['pm-user'], 'team-c')
  const bad = 'pipeline_failed\nevent: evil' as GithubEventKind
  const task = { id: 'T7', title: 'x', assigneeId: null, createdBy: 'pm-user', column: 'Verify' }
  assert.equal(await emitGithubEventWith(hub, githubLookups(crewMembers, crewPeople), { kind: bad, board: crewBoard, task }), 0)
  assert.equal(streams['pm-user']!.text(), '')
  assert.throws(() => frameOfEvent({ ...kept({ kind: bad as never }), id: 1, at: 0 }))
  hub.publish('pm-user', { ...kept({ kind: bad as never, teamId: 'team-c', audience: 'staff' }) })
  assert.equal(streams['pm-user']!.text(), '')
})

test('Boss as the card assignee hears pipeline_failed like any owner; Boss as a bystander does not', async () => {
  const { hub } = makeHub()
  const streams = streamsFor(hub, ['boss-user', 'w2-user'], 'team-c')
  const task = { id: 'T8', title: 'Boss owns it', assigneeId: 'boss-user', createdBy: 'pm-user', column: 'Verify' }
  await emitGithubEventWith(hub, githubLookups(crewMembers, crewPeople), { kind: 'pipeline_failed', board: crewBoard, task })
  assert.deepEqual(framesOf(streams['boss-user']!).map(data => data.kind), ['pipeline_failed'])
  assert.deepEqual(framesOf(streams['w2-user']!), [])
  const bystander = { ...task, id: 'T9', assigneeId: 'w1-user', createdBy: 'pm-user' }
  await emitGithubEventWith(hub, githubLookups(crewMembers, crewPeople), { kind: 'pipeline_failed', board: crewBoard, task: bystander })
  assert.deepEqual(framesOf(streams['boss-user']!).map(data => data.kind), ['pipeline_failed'], 'a bystander Boss gets no pipeline_failed')
})

test('a team with two crew rows is no crew, and an account outside the crew is skipped', () => {
  assert.deepEqual(crewPeopleFrom([{ id: 'c1', slug: 'acme' }, { id: 'c2', slug: 'other' }], []), [])
  const accounts = [
    { id: 'u1', email: 'acme-pm@crew.invalid', crewId: 'c1' },
    { id: 'u2', email: 'stranger@crew.invalid', crewId: 'c1' },
    { id: 'u3', email: 'acme-w1@example.com', crewId: 'c1' },
    { id: 'u4', email: 'acme-boss@crew.invalid', crewId: 'c2' }
  ]
  assert.deepEqual(crewPeopleFrom([{ id: 'c1', slug: 'acme' }], accounts), [{ userId: 'u1', key: 'pm' }])
})

test('no team lookup is made while nobody is watched', async () => {
  const { hub } = makeHub()
  let asked = 0
  const crew: GithubLookups = githubLookups(crewMembers, crewPeople)
  crew.crewPeople = async () => {
    asked++
    return crewPeople
  }
  const task = { id: 'T10', title: 'Quiet', assigneeId: 'w1-user', createdBy: 'pm-user', column: 'Verify' }
  assert.equal(await emitGithubEventWith(hub, crew, { kind: 'merged_staging', board: crewBoard, task }), 0)
  assert.equal(asked, 0)
})
test('a Last-Event-ID is read only when it is a plain number', () => {
  assert.equal(parseLastEventId('12'), 12)
  assert.equal(parseLastEventId(' 0 '), 0)
  assert.equal(parseLastEventId(undefined), undefined)
  assert.equal(parseLastEventId('x'), undefined)
  assert.equal(parseLastEventId('1\nevent: x'), undefined)
  assert.equal(parseLastEventId('99999999999999999999'), undefined)
})

// ── Ids, resume and the backlog ───────────────────────────────────────

test('ids are monotonic per user, and a resume sends only what came after the given id', () => {
  const { hub } = makeHub()
  const first = open(hub, key('k1', 'u1'))
  hub.publish('u1', kept({ title: 'one' }))
  hub.publish('u1', kept({ title: 'two' }))
  hub.publish('u1', kept({ title: 'three' }))
  assert.deepEqual(ids(first.connection.text()), [BASE, BASE + 1, BASE + 2])
  first.slot.release()

  const again = open(hub, key('k1', 'u1'), BASE, { teamIds: [], customerIds: [] })
  assert.deepEqual(ids(again.connection.text()), [BASE + 1, BASE + 2])
  assert.doesNotMatch(again.connection.text(), /backlog_cut/)
})

test('ids do not restart after a restart: a new process starts above the old ids', () => {
  const old = makeHub()
  open(old.hub, key('k-old', 'u9'))
  old.hub.publish('u9', kept())
  const restarted = makeHub({ now: () => BASE + 5_000 })
  const fresh = open(restarted.hub, key('k-new', 'u9'))
  restarted.hub.publish('u9', kept())
  assert.deepEqual(ids(fresh.connection.text()), [BASE + 5_000])

  const resumed = open(restarted.hub, key('k-resume', 'u9'), BASE, { teamIds: [], customerIds: [] })
  assert.ok(resumed.connection.text().startsWith('event: backlog_cut'), 'an id from before the restart is a gap, said first')
})

test('a resume past a cut backlog is told so first, with the oldest id kept', () => {
  const { hub } = makeHub({ backlogEvents: 5 })
  open(hub, key('k-seed', 'u2'))
  for (let n = 0; n < 8; n++) hub.publish('u2', kept({ title: `event ${n}` }))

  const resumed = open(hub, key('k-resume', 'u2'), BASE, { teamIds: [], customerIds: [] })
  assert.ok(resumed.connection.text().startsWith(`event: backlog_cut\ndata: {"kind":"backlog_cut","oldest":${BASE + 3}}\n\n`))
  assert.deepEqual(ids(resumed.connection.text()), [BASE + 3, BASE + 4, BASE + 5, BASE + 6, BASE + 7])
})

test('a backlog older than 24 hours is cut, and so is an id past the latest issued', () => {
  const { hub, advance } = makeHub()
  open(hub, key('k-seed', 'u3'))
  hub.publish('u3', kept())
  hub.publish('u3', kept())
  advance(DAY + 1)
  hub.publish('u3', kept())

  const aged = open(hub, key('k-aged', 'u3'), BASE, { teamIds: [], customerIds: [] })
  assert.ok(aged.connection.text().includes(`"oldest":${BASE + DAY + 1}`))
  assert.deepEqual(ids(aged.connection.text()), [BASE + DAY + 1])

  const ahead = open(hub, key('k-ahead', 'u3'), BASE + DAY + 1000, { teamIds: [], customerIds: [] })
  assert.ok(ahead.connection.text().startsWith('event: backlog_cut'))
})

test('the total backlog cap drops the backlog of an idle user, and a resume to it is cut', () => {
  const { hub } = makeHub({ backlogTotal: 3 })
  const a = open(hub, key('k-a', 'idle-a'))
  hub.publish('idle-a', kept())
  hub.publish('idle-a', kept())
  a.slot.release()
  const b = open(hub, key('k-b', 'idle-b'))
  hub.publish('idle-b', kept())
  hub.publish('idle-b', kept())
  b.slot.release()

  const resumed = open(hub, key('k-ra', 'idle-a'), BASE, { teamIds: [], customerIds: [] })
  assert.ok(resumed.connection.text().startsWith('event: backlog_cut'))
  assert.deepEqual(ids(resumed.connection.text()), [])
})

// ── Caps, rate, replacement and the zombie ────────────────────────────

test('a cap on connections per instance refuses a new key, and a key may replace its own stream', () => {
  const { hub } = makeHub({ maxConnections: 2 })
  open(hub, key('k1', 'u1'))
  open(hub, key('k2', 'u2'))
  assert.equal(hub.reserve(key('k3', 'u3')), 'full')
  open(hub, key('k1', 'u1'))
  assert.equal(hub.streamCount, 2)
})

test('one user with many keys holds at most three streams; the oldest is replaced', () => {
  const { hub } = makeHub()
  const first = open(hub, key('k1', 'multi'))
  open(hub, key('k2', 'multi'))
  open(hub, key('k3', 'multi'))
  open(hub, key('k4', 'multi'))
  assert.equal(first.connection.ended, true)
  assert.equal(hub.streamCount, 3)
})

test('connects per key are limited per minute', () => {
  const { hub, advance } = makeHub({ connectsPerMinute: 3 })
  for (let n = 0; n < 3; n++) {
    const slot = hub.reserve(key('k1', 'u1'))
    assert.notEqual(typeof slot, 'string')
    if (typeof slot !== 'string') slot.release()
  }
  assert.equal(hub.reserve(key('k1', 'u1')), 'rate')
  advance(60_001)
  assert.notEqual(typeof hub.reserve(key('k1', 'u1')), 'string')
})

test('a second connection on a key replaces the first, which is ended; the old release does not touch the new one', () => {
  const { hub } = makeHub()
  const first = open(hub, key('k1', 'u1'))
  const second = open(hub, key('k1', 'u1'))
  assert.equal(first.connection.ended, true)
  assert.equal(hub.streamCount, 1)
  hub.publish('u1', kept({ title: 'after' }))
  assert.equal(first.connection.text(), '')
  assert.deepEqual(ids(second.connection.text()), [BASE])

  first.slot.release()
  hub.publish('u1', kept({ title: 'still' }))
  assert.deepEqual(ids(second.connection.text()), [BASE, BASE + 1], 'the old stream closing must not end the new one')
})

test('a slot released before the stream starts never opens (the reader left during the audit)', () => {
  const { hub } = makeHub()
  const slot = hub.reserve(key('k-gone', 'u-gone'))
  assert.notEqual(typeof slot, 'string')
  if (typeof slot === 'string') return
  slot.release()
  assert.equal(slot.activate(undefined, new FakeConnection(), { teamIds: [], customerIds: [] }, noVerify), false)
  assert.equal(hub.streamCount, 0)
  assert.equal(hub.timerCount, 0)
})

test('500 streams opened and aborted leave no streams and no timers behind', () => {
  const { hub } = makeHub({ maxConnections: 500 })
  const opened: { connection: FakeConnection, slot: ReturnType<typeof open>['slot'] }[] = []
  for (let n = 0; n < 500; n++) opened.push(open(hub, key(`k-${n}`, `user-${n}`)))
  assert.equal(hub.streamCount, 500)
  assert.equal(hub.timerCount, 1000)

  for (const { slot } of opened) slot.release()
  for (const { slot } of opened) slot.release()
  assert.equal(hub.streamCount, 0)
  assert.equal(hub.timerCount, 0)
  assert.ok(opened.every(({ connection }) => connection.aborted))
  assert.equal(hub.reserve(key('after', 'user-after')) === 'full', false, 'the freed slots are usable again')
})

test('a stream that is over its queue limit is aborted, and the slot and timers go with it', () => {
  const { hub } = makeHub({ queueLimitBytes: 1000 })
  const stalled = open(hub, key('k-slow', 'u-slow'))
  stalled.connection.queued = 5000
  hub.publish('u-slow', kept())
  assert.equal(stalled.connection.aborted, true)
  assert.equal(hub.streamCount, 0)
  assert.equal(hub.timerCount, 0)
})

test('a write that fails ends the stream at once', () => {
  const { hub } = makeHub()
  const broken = open(hub, key('k-broken', 'u-broken'))
  broken.connection.failWrites = true
  hub.publish('u-broken', kept())
  assert.equal(broken.connection.aborted, true)
  assert.equal(hub.streamCount, 0)
})

test('a ping comment goes out on the interval and stops when the stream is released', async () => {
  const { hub } = makeHub({ pingMs: 10 })
  const { connection, slot } = open(hub, key('k-ping', 'u5'))
  const pings = () => connection.chunks.filter(chunk => chunk === ': ping\n\n').length
  await until(() => pings() >= 2, 2_000)

  slot.release()
  const after = connection.chunks.length
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(connection.chunks.length, after)
  assert.equal(hub.timerCount, 0)
})

test('a key that may no longer stream is told why and its stream ends', async () => {
  const { hub } = makeHub({ recheckMs: 5 })
  let reason: CloseReason | null = null
  const { connection } = open(hub, key('k-revoked', 'u-revoked'), undefined, { teamIds: [], customerIds: [] }, async () => reason)
  reason = 'key_revoked'
  await until(() => connection.ended, 2_000)
  assert.ok(connection.text().endsWith('event: closed\ndata: {"kind":"closed","reason":"key_revoked"}\n\n'))
  assert.equal(connection.ended, true)
  assert.equal(hub.streamCount, 0)
  assert.equal(hub.timerCount, 0)
})

test('a failed re-check keeps the stream open; a clean one leaves it alone', async () => {
  const { hub } = makeHub({ recheckMs: 5 })
  let calls = 0
  const { connection, slot } = open(hub, key('k-flaky', 'u-flaky'), undefined, { teamIds: [], customerIds: [] }, async () => {
    calls++
    if (calls === 1) throw new Error('database blip')
    return null
  })
  await until(() => calls >= 2, 2_000)
  assert.ok(calls >= 2)
  assert.equal(connection.ended, false)
  assert.equal(hub.streamCount, 1)
  slot.release()
})

test('the global backlog stays bounded under many users', () => {
  const { hub } = makeHub({ backlogTotal: 50, backlogEvents: 500 })
  for (let user = 0; user < 40; user++) {
    const { slot } = open(hub, key(`k-${user}`, `bulk-${user}`))
    for (let n = 0; n < 10; n++) hub.publish(`bulk-${user}`, kept())
    slot.release()
  }
  const { connection } = open(hub, key('k-check', 'bulk-0'), BASE, { teamIds: [], customerIds: [] })

  assert.ok(connection.text().startsWith('event: backlog_cut'))
})

// ── Round 3: watching ends with the stream and the backlog; reply recipients; key checks ──

async function until(check: () => boolean, ms = 2_000) {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > ms) throw new Error('timed out waiting')
    await new Promise(resolve => setTimeout(resolve, 2))
  }
}

test('the last stream closed and the backlog aged out: no emit work, and no per-user state is left', async () => {
  const { hub, advance } = makeHub()
  const { slot } = open(hub, key('k-last', 'u-last'))
  hub.publish('u-last', kept())
  slot.release()
  assert.equal(hub.watches('u-last'), true, 'a young backlog keeps the user watched')
  advance(DAY + 1)
  assert.equal(hub.watches('u-last'), false)
  assert.equal(hub.hasWatchers(), false)

  let lookupsRun = 0
  const counting: AudienceLookups = {
    isMember: async () => {
      lookupsRun++
      return true
    },
    customerIds: async () => {
      lookupsRun++
      return []
    }
  }
  assert.equal(await emitAgentEventWith(hub, counting, 'u-last', eventFor({ board: teamBoard })), false)
  assert.equal(lookupsRun, 0, 'no database lookup while nobody is watched')

  hub.sweep()
  assert.deepEqual(hub.footprint, { users: 0, backlogs: 0, dropped: 0, retired: 0, streams: 0 })
})

test('a stream closed with nothing kept leaves no state behind once past the TTL', () => {
  const { hub, advance } = makeHub()
  const { slot } = open(hub, key('k-empty', 'u-empty'))
  slot.release()
  advance(DAY + 1)
  hub.sweep()
  assert.deepEqual(hub.footprint, { users: 0, backlogs: 0, dropped: 0, retired: 0, streams: 0 })
})

test('ids stay above every id issued before the user state was cleared', () => {
  const { hub, advance } = makeHub()
  const first = open(hub, key('k-ids-a', 'u-ids'))
  hub.publish('u-ids', kept())
  const [before] = ids(first.connection.text())
  first.slot.release()
  advance(DAY + 1)
  hub.sweep()
  const second = open(hub, key('k-ids-b', 'u-ids'))
  hub.publish('u-ids', kept())
  const [after] = ids(second.connection.text())
  assert.ok(after! > before!, `${after} should be above ${before}`)
})

test('a user with a stream stays watched through a sweep, and keeps receiving', () => {
  const { hub } = makeHub()
  const { connection, slot } = open(hub, key('k-live', 'u-live'))
  hub.sweep()
  assert.equal(hub.watches('u-live'), true)
  hub.publish('u-live', kept())
  assert.deepEqual(ids(connection.text()), [BASE])
  slot.release()
})

test('a reply reaches every watched person on the card, a PM who only commented included, and nobody unwatched', () => {
  const watched = new Set(['pm', 'worker', 'parent-author', 'customer'])
  const recipients = replyRecipients({
    actorId: 'customer',
    owners: ['worker', null],
    writers: [
      { id: 'c1', userId: 'pm', body: 'looks fine' },
      { id: 'c2', userId: 'parent-author', body: 'QUESTION: which branch?' },
      { id: 'c3', userId: 'stranger', body: 'hi' },
      { id: 'c4', userId: 'customer', body: 'answer' }
    ],
    replyToId: 'c2',
    watches: userId => watched.has(userId)
  })
  assert.deepEqual(recipients.map(r => r.userId).sort(), ['parent-author', 'pm', 'worker'])
  assert.equal(recipients.find(r => r.userId === 'parent-author')!.needsFeedbackFromMe, true)
  assert.equal(recipients.find(r => r.userId === 'pm')!.needsFeedbackFromMe, false)
})

test('a key check that fails transiently is tolerated, but three in a row end the stream', async () => {
  const { hub } = makeHub({ recheckMs: 5 })
  let calls = 0
  const { connection } = open(hub, key('k-down', 'u-down'), undefined, { teamIds: [], customerIds: [] }, async () => {
    calls++
    throw new Error('database down')
  })
  await until(() => connection.ended)
  assert.equal(calls, 3)
  assert.equal(connection.text(), '', 'no closed frame for a transient failure')
  assert.equal(hub.streamCount, 0)
  assert.equal(hub.timerCount, 0)
})

test('a successful check between failures starts the count again', async () => {
  const { hub } = makeHub({ recheckMs: 5 })
  const pattern = [true, true, false, true, true, false]
  let calls = 0
  const { connection, slot } = open(hub, key('k-blip', 'u-blip'), undefined, { teamIds: [], customerIds: [] }, async () => {
    const fail = pattern[calls] ?? false
    calls++
    if (fail) throw new Error('blip')
    return null
  })
  await until(() => calls >= 8)
  assert.equal(connection.ended, false)
  slot.release()
})

test('a reconnect after more than the TTL away is cut, since nothing was kept meanwhile', () => {
  const { hub, advance } = makeHub()
  const first = open(hub, key('k-away', 'u-away'))
  hub.publish('u-away', kept())
  first.slot.release()
  advance(DAY + 1)
  const back = open(hub, key('k-back', 'u-away'), BASE, { teamIds: [], customerIds: [] })
  assert.ok(back.connection.text().startsWith('event: backlog_cut'))
})

test('a disconnect shorter than the TTL keeps what happens meanwhile for the resume', () => {
  const { hub, advance } = makeHub()
  const first = open(hub, key('k-brief', 'u-brief'))
  hub.publish('u-brief', kept())
  first.slot.release()
  advance(60_000)
  hub.publish('u-brief', kept())
  const back = open(hub, key('k-brief-2', 'u-brief'), BASE, { teamIds: [], customerIds: [] })
  assert.deepEqual(ids(back.connection.text()), [BASE + 60_000])
  assert.doesNotMatch(back.connection.text(), /backlog_cut/)
})

test('the backlog counter equals the kept events through publish, eviction, the total cap and sweep', () => {
  const { hub, advance } = makeHub({ backlogEvents: 3, backlogTotal: 5 })
  const agree = (expected: number) => {
    assert.equal(hub.backlogCounts.counter, hub.backlogCounts.sum)
    assert.equal(hub.backlogCounts.sum, expected)
  }
  const a = open(hub, key('k-cnt-a', 'cnt-a'))
  for (let n = 0; n < 4; n++) hub.publish('cnt-a', kept())
  agree(3)
  a.slot.release()

  const b = open(hub, key('k-cnt-b', 'cnt-b'))
  for (let n = 0; n < 3; n++) hub.publish('cnt-b', kept())
  agree(3)
  b.slot.release()

  advance(DAY + 1)
  hub.sweep()
  agree(0)

  const c = open(hub, key('k-cnt-c', 'cnt-c'))
  hub.publish('cnt-c', kept())
  agree(1)
  c.slot.release()
})

test('a sweep removes only the users past the TTL, and the counter goes down by what it removed', () => {
  const { hub, advance } = makeHub()
  const live = open(hub, key('k-cnt-live', 'cnt-live'))
  hub.publish('cnt-live', kept())
  const gone = open(hub, key('k-cnt-gone', 'cnt-gone'))
  hub.publish('cnt-gone', kept())
  hub.publish('cnt-gone', kept())
  gone.slot.release()
  advance(DAY + 1)
  hub.publish('cnt-live', kept())
  hub.sweep()
  assert.equal(hub.backlogCounts.counter, hub.backlogCounts.sum)
  assert.equal(hub.backlogCounts.sum, 1)
  live.slot.release()
})

test('a reserved stream evicted by a newer one for its key cannot start, and writes nothing', () => {
  const { hub } = makeHub()
  const first = hub.reserve(key('k-same', 'u-same'))
  const second = hub.reserve(key('k-same', 'u-same'))
  if (typeof first === 'string' || typeof second === 'string') throw new Error('reserve refused')
  const connection = new FakeConnection()
  assert.equal(first.activate(undefined, connection, { teamIds: [], customerIds: [] }, noVerify), false)
  assert.equal(connection.chunks.length, 0)
  assert.equal(hub.streamCount, 1)
  second.release()
  assert.equal(hub.streamCount, 0)
})
