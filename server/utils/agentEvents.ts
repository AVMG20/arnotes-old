// The agent event stream (CH1): what happened on the boards a key's owner works on,
// pushed to the agent over Server-Sent Events. Events are emitted where the change
// happens, kept in a bounded backlog per user so a reconnect can resume, and sent only
// to keys whose audience may read them. Titles are cut and stripped of control
// characters, and no body text ever leaves the server.
//
// The stream, one event at a time:
//   id: <n>             monotonic per user: max(last + 1, Date.now()), so it does not restart
//   event: <kind>       task_created | task_assigned | reply | task_moved | mention
//                       pipeline_failed | pipeline_passed | merged_staging | merged_production
//                       delivery_failed (the crew's pm only; task is null; ids, class, attempts and a code, never the reason or the payload)
//   data: {"kind","task","board","from","origin","title","ref","needs_feedback_from_me","assigned_to_me","is_pm","is_boss"}
//                       task and board are ids; from is the name of who did it; origin is
//                       person|agent|github|rule on task_created, github on the GitHub kinds, null otherwise;
//                       title is cut to 120 characters with control characters removed; the two
//                       *_me fields are booleans (assigned_to_me: the card's assignee is this
//                       user when the event was made); ref is the pull request number and the branch on the
//                       GitHub kinds, cut to 60 characters, else null; is_pm and is_boss are booleans,
//                       true when this user is the crew's pm or boss key (on the GitHub kinds, else false)
//   event: backlog_cut  data: {"kind":"backlog_cut","oldest":<id>}, before a replay that has a gap
//   event: closed       data: {"kind":"closed","reason":"key_revoked"|"disabled"}, then the stream ends
//   : ping              every 25 s
// The GitHub kinds come from announceGithubEvent and carry origin "github". They never hold a body, a comment or a
// check log. The server decides who hears them: an owner (assignee or creator) and the crew's pm hear all four; the
// crew's boss hears merged_staging, merged_production, and pipeline_passed on a card in Verify (pipeline_failed only as the card's assignee or creator).
// Nobody else, and never a customer. A team that is not a crew gets its owners only.
// delivery_failed goes to the crew's pm only (a team that is not a crew: its owners), with ids, the class, the attempts and a code; never a customer.
import { and, asc, eq, sql } from 'drizzle-orm'
import { db } from '../db'
import { apiKeys, crews, member, projectGithubRepos, projects, user } from '../db/schema'
import { customerIdsOf, isTeamMember } from './auth-helpers'
import { crewAccountLive, isCrewAddress, normalizeAddress, personKeyOf } from './crewAccounts'
import { projectPeople } from './people'

const CORE_EVENT_KINDS = ['task_created', 'task_assigned', 'reply', 'task_moved', 'mention'] as const
// What GitHub did to a card's pull request. Only announceGithubEvent emits them.
export const GITHUB_EVENT_KINDS = ['pipeline_failed', 'pipeline_passed', 'merged_staging', 'merged_production'] as const
// What a delivery of GitHub that gave up tells the crew's pm. Only announceDeliveryFailed emits it.
export const DELIVERY_EVENT_KINDS = ['delivery_failed'] as const
export const AGENT_EVENT_KINDS = [...CORE_EVENT_KINDS, ...GITHUB_EVENT_KINDS, ...DELIVERY_EVENT_KINDS] as const
export type DeliveryEventKind = (typeof DELIVERY_EVENT_KINDS)[number]
export type GithubEventKind = (typeof GITHUB_EVENT_KINDS)[number]
export type AgentEventKind = (typeof AGENT_EVENT_KINDS)[number]
export type AgentEventOrigin = 'person' | 'agent' | 'github' | 'rule'
export type AgentAudience = 'staff' | 'customer'
export type CloseReason = 'key_revoked' | 'disabled'

const MINUTE = 60_000
const SWEEP_MS = 10 * MINUTE
const TITLE_LIMIT = 120
// A ref (the pull request number and its branch) is cut shorter than a title.
const REF_LIMIT = 60
// Consecutive failed key checks before a stream gives up; one transient error is tolerated.
const MAX_FAILED_CHECKS = 3
// A key check that takes longer than this counts as a failed check.
const VERIFY_TIMEOUT_MS = 30_000
// A question an agent or a person asked on a card; the answer to it is what the asker is waiting for.
const QUESTION = /^QUESTION:/i
// Control characters and the Unicode line separators: a title must stay one line of data.
// eslint-disable-next-line no-control-regex
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]', 'g')

/** Strips what could break a frame, then cuts to the limit (by character, not byte). */
export function cleanEventText(text: string): string {
  return Array.from(text.replace(CONTROL, '')).slice(0, TITLE_LIMIT).join('')
}

export interface AgentBoard { id: string, userId: string, teamId: string | null, customerId: string | null }
export interface AgentTaskRef { id: string, title: string, assigneeId?: string | null }

/** One thing that happened, as the code that made it knows it. */
export interface AgentEventInput {
  kind: Exclude<AgentEventKind, GithubEventKind | DeliveryEventKind>
  board: AgentBoard
  task: AgentTaskRef
  /** Who did it, by name. */
  from: string | null
  /** Set for task_created: where the card came from. */
  origin?: AgentEventOrigin | null
  /** Whether a customer may see this item: the card is customer-visible and, for a comment, so is the comment. */
  customerVisible: boolean
  needsFeedbackFromMe?: boolean
}

/** One GitHub change to a card's pull request. The card's owners are its assignee and its creator. */
export interface GithubEventInput {
  kind: GithubEventKind
  board: AgentBoard
  task: AgentTaskRef & { createdBy?: string | null, column?: string | null }
  /** The pull request number and branch, as the event names them. Cut and cleaned like the title. */
  ref?: string | null
}

/** An event as it is kept in the backlog. The audience and the board's team and customer stay server-side. */
export interface AgentEventRecord {
  id: number
  at: number
  kind: AgentEventKind
  board: string
  task: string | null
  from: string | null
  origin: AgentEventOrigin | null
  title: string
  ref: string | null
  needsFeedbackFromMe: boolean
  assignedToMe: boolean
  /** The crew's pm and boss, for the recipient: true on the GitHub kinds only. */
  isPm: boolean
  isBoss: boolean
  audience: AgentAudience
  teamId: string | null
  customerId: string | null
}

export interface StreamKey { keyId: string, userId: string, teamId: string | null }

/** The teams and customers a user belongs to now, read when a stream opens. */
export interface Membership { teamIds: string[], customerIds: string[] }

/** What the socket of one stream offers the hub. Writes never wait on a reader. */
export interface StreamConnection {
  /** Throws when the write cannot be made. */
  write(chunk: string): void
  /** Bytes queued for the reader and not yet sent. */
  pending(): number
  /** Sends what is queued, then closes. */
  end(): void
  /** Closes at once, dropping what is queued. */
  abort(): void
}

/** Returns a reason when the key may no longer stream, or null when it still may. Throws on a transient error. */
export type Verify = () => Promise<CloseReason | null>

export interface StreamSlot {
  /** Starts the stream. False when the slot was released first (the client went away). */
  activate(lastEventId: number | undefined, connection: StreamConnection, membership: Membership, verify: Verify): boolean
  /** Frees the slot and closes any stream on it. Safe to call more than once. */
  release(): void
}

export interface AgentEventHubOptions {
  /** Streams this instance holds at once, reserved or open, across all keys. */
  maxConnections: number
  /** Streams one user may hold; the oldest is replaced. */
  perUserStreams: number
  /** How often a `: ping` comment goes out on every stream. */
  pingMs: number
  /** How often a stream checks that its key still may stream. */
  recheckMs: number
  /** Bytes a stream may have queued for its reader before it is ended. */
  queueLimitBytes: number
  /** Events kept per user for a resume. */
  backlogEvents: number
  /** Events kept across all users; the backlog of an idle user goes first. */
  backlogTotal: number
  /**
   * The TTL. A user is watched while they stream, or while their backlog or their last
   * stream closing is younger than this. Older than this, nothing is kept for them.
   */
  backlogMs: number
  /** Connects one key may open in a minute. */
  connectsPerMinute: number
  now: () => number
}

/** Whether a customer, a team member or the owner may see the item. Null means nobody may. */
export function audienceOfEvent(customerVisible: boolean, membership: { staff: boolean, contact: boolean }): AgentAudience | null {
  if (membership.staff) return 'staff'
  if (membership.contact && customerVisible) return 'customer'
  return null
}

/**
 * Whether a key may receive a kept event. A team-pinned key sees only that team's
 * boards, as the browser does for the same team; a personal key sees its own boards and
 * the customer boards it is a contact of. A crew account is a member of its crew's team
 * only, so it never gets another crew's events.
 */
export function deliverableTo(record: Pick<AgentEventRecord, 'audience' | 'teamId'>, keyTeamId: string | null): boolean {
  if (keyTeamId) return record.audience === 'staff' && record.teamId === keyTeamId
  return record.audience === 'customer' || (record.audience === 'staff' && record.teamId === null)
}

/** Whether a user still belongs to the team or customer a kept event is about. Used on a resume. */
export function stillMember(record: Pick<AgentEventRecord, 'audience' | 'teamId' | 'customerId'>, membership: Membership): boolean {
  if (record.audience === 'customer') return record.customerId !== null && membership.customerIds.includes(record.customerId)
  return record.teamId === null || membership.teamIds.includes(record.teamId)
}

/** The SSE frame for one event. Only ids, the kind, the names, the origin and the cut title. */
export function frameOfEvent(record: AgentEventRecord): string {
  // The kind is written raw into the event line, so only a known kind may make a frame: a line break in it would break the stream.
  if (!isAgentEventKind(record.kind)) throw new Error('an agent event must have a known kind')
  const data = JSON.stringify({
    kind: record.kind,
    task: record.task,
    board: record.board,
    from: record.from,
    origin: record.origin,
    title: record.title,
    ref: record.ref,
    needs_feedback_from_me: record.needsFeedbackFromMe,
    assigned_to_me: record.assignedToMe,
    is_pm: record.isPm,
    is_boss: record.isBoss
  })
  return `id: ${record.id}\nevent: ${record.kind}\ndata: ${data}\n\n`
}

/** A Last-Event-ID header as a number; anything else means no resume. */
export function parseLastEventId(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d{1,15}$/.test(raw.trim())) return undefined
  return Number(raw.trim())
}

export interface ReplyWriter { id: string, userId: string, body: string }

/**
 * Who hears of a reply to a card: everyone who has commented on it, its owners, and the
 * author of the comment replied to. Only the watched ones are considered at all, so the
 * work is bounded by the people actually streaming. needsFeedbackFromMe is true for a
 * person who asked a question on the card.
 */
export function replyRecipients(input: {
  actorId: string | null
  owners: (string | null | undefined)[]
  writers: ReplyWriter[]
  replyToId: string | null
  watches: (userId: string) => boolean
}): { userId: string, needsFeedbackFromMe: boolean }[] {
  const parent = input.replyToId ? input.writers.find(writer => writer.id === input.replyToId)?.userId : undefined
  const askers = new Set(input.writers.filter(writer => QUESTION.test(writer.body.trim())).map(writer => writer.userId))
  const candidates = new Set<string>([
    ...input.owners.filter((id): id is string => !!id),
    ...input.writers.map(writer => writer.userId),
    ...(parent ? [parent] : [])
  ])
  return [...candidates]
    .filter(userId => userId !== input.actorId && input.watches(userId))
    .map(userId => ({ userId, needsFeedbackFromMe: askers.has(userId) }))
}

/** Rejects when a check takes longer than the limit, so a stalled lookup counts as a failed check. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the key check timed out')), ms)
    timer.unref()
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

interface Stream {
  token: number
  keyId: string
  userId: string
  teamId: string | null
  connection: StreamConnection | null
  membership: Membership | null
  timers: ReturnType<typeof setInterval>[]
  failedChecks: number
  closed: boolean
}

export class AgentEventHub {
  private readonly streams = new Map<number, Stream>()
  // Streams held per user, reserved or open: what makes a user watched while they stream.
  private readonly perUser = new Map<string, number>()
  private nextToken = 1
  private readonly backlogs = new Map<string, AgentEventRecord[]>()
  // The last id issued per user. Dropped with the rest of the user's state once it is past the TTL.
  // Ids stay monotonic without it: each is max(last + 1, now), and now only grows.
  private readonly lastIds = new Map<string, number>()
  // The newest id dropped from a user's backlog, by age, size or the total cap.
  private readonly dropped = new Map<string, number>()
  // When a user's last stream closed. Events for them are kept for a TTL after that.
  private readonly retiredAt = new Map<string, number>()
  private readonly connects = new Map<string, number[]>()
  private backlogSize = 0
  private readonly startedAt: number

  constructor(readonly options: AgentEventHubOptions) {
    this.startedAt = options.now()
    setInterval(() => this.sweep(), SWEEP_MS).unref()
  }

  /** Streams held now, reserved or open. */
  get streamCount(): number {
    return this.streams.size
  }

  /** Timers running for streams now. Zero when no stream is held. */
  get timerCount(): number {
    let total = 0
    for (const stream of this.streams.values()) total += stream.timers.length
    return total
  }

  /** Per-user state the hub holds, for tests and for the proof that nothing is left behind. */
  /** The counter kept for the total cap next to what the backlogs hold; the two must agree. */
  get backlogCounts() {
    let sum = 0
    for (const list of this.backlogs.values()) sum += list.length
    return { counter: this.backlogSize, sum }
  }

  get footprint() {
    return {
      users: this.lastIds.size,
      backlogs: this.backlogs.size,
      dropped: this.dropped.size,
      retired: this.retiredAt.size,
      streams: this.streams.size
    }
  }

  /** A user is watched while they have a stream, reserved or open, or had activity within the TTL. */
  watches(userId: string): boolean {
    return this.streamsOf(userId) > 0 || this.isRecent(this.lastActivity(userId))
  }

  /** Whether anyone is watched. Emit work is skipped entirely when nobody is. */
  hasWatchers(): boolean {
    if (this.streams.size > 0) return true
    for (const userId of new Set([...this.backlogs.keys(), ...this.retiredAt.keys()])) {
      if (this.isRecent(this.lastActivity(userId))) return true
    }
    return false
  }

  /**
   * Takes a slot for a stream before anything is awaited, so the cap counts it at once. A
   * key that already has a stream replaces it; a user over their per-user limit replaces
   * their oldest stream. Returns 'rate' or 'full' when the stream may not open.
   */
  reserve(key: StreamKey): StreamSlot | 'rate' | 'full' {
    const now = this.options.now()
    const recent = (this.connects.get(key.keyId) ?? []).filter(time => now - time < MINUTE)
    if (recent.length >= this.options.connectsPerMinute) {
      this.connects.set(key.keyId, recent)
      return 'rate'
    }

    const streams = [...this.streams.values()]
    const same = streams.find(stream => stream.keyId === key.keyId)
    const own = streams
      .filter(stream => stream.userId === key.userId && stream !== same)
      .sort((a, b) => a.token - b.token)
    const evict = Math.max(0, own.length + 1 - this.options.perUserStreams)
    if (this.streams.size - (same ? 1 : 0) - evict + 1 > this.options.maxConnections) return 'full'

    recent.push(now)
    this.connects.set(key.keyId, recent)
    if (same) this.retire(same, 'end')
    for (const stream of own.slice(0, evict)) this.retire(stream, 'end')

    const stream: Stream = {
      token: this.nextToken++,
      keyId: key.keyId,
      userId: key.userId,
      teamId: key.teamId,
      connection: null,
      membership: null,
      timers: [],
      failedChecks: 0,
      closed: false
    }
    this.streams.set(stream.token, stream)
    this.perUser.set(stream.userId, this.streamsOf(stream.userId) + 1)
    return {
      activate: (lastEventId, connection, membership, verify) => this.activate(stream, lastEventId, connection, membership, verify),
      release: () => this.retire(stream, 'abort')
    }
  }

  /** Keeps an event for a user and sends it to each open stream that may read it. Never blocks on a reader. */
  publish(userId: string, data: Omit<AgentEventRecord, 'id' | 'at'>): void {
    if (!isAgentEventKind(data.kind)) {
      rejectKind(data.kind)
      return
    }
    if (!this.watches(userId)) return
    const now = this.options.now()
    // Ms since the epoch, and always above the last one: ids never restart, even after a restart.
    const id = Math.max((this.lastIds.get(userId) ?? 0) + 1, now)
    this.lastIds.set(userId, id)
    const record: AgentEventRecord = { ...data, id, at: now }

    const backlog = this.pruned(userId)
    backlog.push(record)
    this.backlogSize++
    while (backlog.length > this.options.backlogEvents) this.evictOldest(userId, backlog)
    this.trimTotal()

    const frame = frameOfEvent(record)
    for (const stream of [...this.streams.values()]) {
      if (stream.userId === userId && stream.connection && deliverableTo(record, stream.teamId)) this.send(stream, frame)
    }
  }

  /**
   * Removes what is past the TTL: a user who is not streaming and has had no activity
   * within it loses their last id, backlog, dropped mark and close time together.
   * The id only restarts after this, when nobody can hold a backlog.
   */
  sweep() {
    const userIds = new Set([...this.lastIds.keys(), ...this.backlogs.keys(), ...this.dropped.keys(), ...this.retiredAt.keys()])
    for (const userId of userIds) {
      if (this.streamsOf(userId) > 0 || this.isRecent(this.lastActivity(userId))) continue
      this.backlogSize -= this.backlogs.get(userId)?.length ?? 0
      this.backlogs.delete(userId)
      this.lastIds.delete(userId)
      this.dropped.delete(userId)
      this.retiredAt.delete(userId)
    }
    const now = this.options.now()
    for (const [keyId, times] of [...this.connects]) {
      const recent = times.filter(time => now - time < MINUTE)
      if (recent.length) this.connects.set(keyId, recent)
      else this.connects.delete(keyId)
    }
  }

  private streamsOf(userId: string): number {
    return this.perUser.get(userId) ?? 0
  }

  /** Activity happened, and it is within the TTL. Zero means none ever. */
  private isRecent(last: number): boolean {
    return last > 0 && last >= this.cutoff()
  }

  private cutoff(): number {
    return this.options.now() - this.options.backlogMs
  }

  /** The newest of: the youngest kept event, and the close of the user's last stream. Zero when neither. */
  private lastActivity(userId: string): number {
    const list = this.backlogs.get(userId)
    const youngest = list?.length ? list[list.length - 1]!.at : 0
    return Math.max(youngest, this.retiredAt.get(userId) ?? 0)
  }

  private activate(
    stream: Stream,
    lastEventId: number | undefined,
    connection: StreamConnection,
    membership: Membership,
    verify: Verify
  ): boolean {
    if (stream.closed) return false
    stream.connection = connection
    stream.membership = membership
    if (!this.lastIds.has(stream.userId)) this.lastIds.set(stream.userId, 0)
    // Nobody was watching this user while they were away: anything may have happened.
    const unwatched = this.streamsOf(stream.userId) === 1 && !this.isRecent(this.lastActivity(stream.userId))
    if (lastEventId !== undefined) this.replay(stream, lastEventId, membership, unwatched)
    if (stream.closed) return false

    stream.timers.push(setInterval(() => this.send(stream, ': ping\n\n'), this.options.pingMs))
    stream.timers.push(setInterval(() => this.recheck(stream, verify), this.options.recheckMs))
    for (const timer of stream.timers) timer.unref()
    return true
  }

  /**
   * Closes a stream once, whatever the path: the reader left, it was replaced, its key
   * stopped working or its writes failed. The one place a stream's timers and socket are let go.
   */
  private retire(stream: Stream, how: 'end' | 'abort', closing?: string) {
    if (stream.closed) return
    stream.closed = true
    this.streams.delete(stream.token)
    const left = this.streamsOf(stream.userId) - 1
    if (left > 0) {
      this.perUser.set(stream.userId, left)
    } else {
      this.perUser.delete(stream.userId)
      this.retiredAt.set(stream.userId, this.options.now())
    }
    for (const timer of stream.timers) clearInterval(timer)
    stream.timers = []
    const connection = stream.connection
    stream.connection = null
    if (!connection) return
    try {
      if (how === 'end') {
        if (closing) connection.write(closing)
        connection.end()
        return
      }
    } catch {
      // The socket is already unusable: fall through to the abort.
    }
    try {
      connection.abort()
    } catch {
      // Already gone.
    }
  }

  private send(stream: Stream, chunk: string) {
    const connection = stream.connection
    if (!connection || stream.closed) return
    try {
      connection.write(chunk)
      // A reader that is not keeping up is cut off; it reconnects with its Last-Event-ID.
      if (connection.pending() > this.options.queueLimitBytes) this.retire(stream, 'abort')
    } catch {
      this.retire(stream, 'abort')
    }
  }

  /**
   * Asks whether the key may still stream. A failed check (a transient error) is tolerated;
   * after MAX_FAILED_CHECKS in a row the stream ends without a frame, and the client
   * reconnects with its Last-Event-ID.
   */
  private recheck(stream: Stream, verify: Verify) {
    Promise.resolve()
      .then(() => withTimeout(verify(), VERIFY_TIMEOUT_MS))
      .then(
        (reason) => {
          stream.failedChecks = 0
          if (reason) this.retire(stream, 'end', `event: closed\ndata: ${JSON.stringify({ kind: 'closed', reason })}\n\n`)
        },
        () => {
          stream.failedChecks++
          if (stream.failedChecks >= MAX_FAILED_CHECKS) this.retire(stream, 'end')
        }
      )
  }

  private replay(stream: Stream, lastEventId: number, membership: Membership, unwatched: boolean) {
    const userId = stream.userId
    const latest = this.lastIds.get(userId) ?? 0
    const backlog = this.pruned(userId)
    const oldest = backlog[0]?.id ?? latest + 1
    const dropped = this.dropped.get(userId) ?? 0
    // A gap: events the reader has not seen were dropped, were never kept, or the id is from before this process started.
    // A future id (above latest) gets a cut too: the reader resets to 0 and may see duplicates, so delivery is at least once.
    if (unwatched || lastEventId > latest || lastEventId < dropped || lastEventId < this.startedAt) {
      this.send(stream, `event: backlog_cut\ndata: ${JSON.stringify({ kind: 'backlog_cut', oldest })}\n\n`)
    }
    for (const record of backlog) {
      if (stream.closed) return
      if (record.id > lastEventId && deliverableTo(record, stream.teamId) && stillMember(record, membership)) {
        this.send(stream, frameOfEvent(record))
      }
    }
  }

  private pruned(userId: string): AgentEventRecord[] {
    const list = this.backlogs.get(userId) ?? []
    const cutoff = this.cutoff()
    let gone = 0
    while (gone < list.length && list[gone]!.at < cutoff) gone++
    if (gone) {
      this.noteDropped(userId, list[gone - 1]!.id)
      list.splice(0, gone)
      this.backlogSize -= gone
    }
    this.backlogs.set(userId, list)
    return list
  }

  private evictOldest(userId: string, backlog: AgentEventRecord[]) {
    const gone = backlog.shift()!
    this.backlogSize--
    this.noteDropped(userId, gone.id)
  }

  private noteDropped(userId: string, id: number) {
    this.dropped.set(userId, Math.max(this.dropped.get(userId) ?? 0, id))
  }

  /**
   * Over the total cap: whole backlogs of users who are not streaming go, the first such
   * user in insertion order, until the total is under the cap. Each one's resume is then cut.
   */
  private trimTotal() {
    while (this.backlogSize > this.options.backlogTotal) {
      const victim = [...this.backlogs.entries()].find(([userId, list]) => list.length && this.streamsOf(userId) === 0)
      if (!victim) return
      const [userId, list] = victim
      this.noteDropped(userId, list[list.length - 1]!.id)
      this.backlogSize -= list.length
      this.backlogs.delete(userId)
    }
  }
}

function optionsFromEnv(): AgentEventHubOptions {
  const number = (raw: string | undefined, fallback: number) => {
    const value = Number(raw)
    return raw && Number.isFinite(value) && value > 0 ? value : fallback
  }
  return {
    maxConnections: number(process.env.AGENT_EVENTS_MAX_CONNECTIONS, 200),
    perUserStreams: 3,
    pingMs: number(process.env.AGENT_EVENTS_PING_MS, 25_000),
    recheckMs: MINUTE,
    queueLimitBytes: 256 * 1024,
    backlogEvents: 500,
    backlogTotal: 100_000,
    backlogMs: 24 * 60 * MINUTE,
    connectsPerMinute: 30,
    now: () => Date.now()
  }
}

/** The one hub of this server process. The stream is in memory: one instance is assumed. */
export const agentEventHub = new AgentEventHub(optionsFromEnv())

export interface AudienceLookups {
  isMember(userId: string, teamId: string): Promise<boolean>
  customerIds(userId: string): Promise<string[]>
}

export const databaseLookups: AudienceLookups = {
  isMember: isTeamMember,
  customerIds: customerIdsOf
}

/**
 * Keeps an event for one user if they may see it. Unwatched users get nothing, and so
 * does a user the item is not for. Returns whether it was kept for them.
 */
export async function emitAgentEventWith(
  hub: AgentEventHub,
  lookups: AudienceLookups,
  userId: string,
  input: AgentEventInput
): Promise<boolean> {
  if (!hub.watches(userId)) return false
  const staff = input.board.teamId
    ? await lookups.isMember(userId, input.board.teamId)
    : input.board.userId === userId
  const contact = !staff && !!input.board.customerId
    && (await lookups.customerIds(userId)).includes(input.board.customerId)
  const audience = audienceOfEvent(input.customerVisible, { staff, contact })
  if (!audience) return false

  hub.publish(userId, {
    kind: input.kind,
    board: input.board.id,
    task: input.task.id,
    from: input.from ? cleanEventText(input.from) || null : null,
    origin: input.origin ?? null,
    title: cleanEventText(input.task.title),
    ref: null,
    needsFeedbackFromMe: input.needsFeedbackFromMe ?? false,
    assignedToMe: input.task.assigneeId === userId,
    isPm: false,
    isBoss: false,
    audience,
    teamId: input.board.teamId,
    customerId: input.board.customerId
  })
  return true
}

/** Emits one event to one user, awaitable. Used by the background work below. */
export function emitAgentEventAsync(userId: string, event: AgentEventInput): Promise<boolean> {
  return emitAgentEventWith(agentEventHub, databaseLookups, userId, event)
}

/**
 * Runs emit work off the request path. Never throws, never waits, and does no database
 * work at all while nobody is watched. A failure is logged and never fails the save that
 * caused it.
 */
export function emitInBackground(work: () => Promise<unknown>): void {
  if (!agentEventHub.hasWatchers()) return
  try {
    work().catch(error => console.error('[agent-events] could not emit', error))
  } catch (error) {
    console.error('[agent-events] could not emit', error)
  }
}

/**
 * Who hears a GitHub change on a card. The card's owners (assignee and creator) hear all four, and that includes
 * Boss: a Boss who is the assignee or creator gets pipeline_failed like any owner. The crew's pm hears all four.
 * A Boss who is not an owner hears the two merges, and pipeline_passed while the card is in Verify, never a
 * failed pipeline. Nobody else does.
 */
export function githubAudience(kind: GithubEventKind, role: { owner: boolean, pm: boolean, boss: boolean }, inVerify: boolean): boolean {
  if (role.owner || role.pm) return true
  if (!role.boss || kind === 'pipeline_failed') return false
  return kind !== 'pipeline_passed' || inVerify
}

/** A person of a crew, with the key the crew gave them (pm, boss, w1...). */
export interface CrewPerson { userId: string, key: string }

export interface GithubLookups extends AudienceLookups {
  /** The people of the crew that owns this team, with their keys. Empty unless exactly one crew has the team. */
  crewPeople(teamId: string): Promise<CrewPerson[]>
}

/**
 * The people of a crew from its rows. crews.teamId is an index, not unique: a team is a crew's only when exactly one
 * crew row has it, otherwise nobody gets a key. An account whose address does not start with the crew's slug is skipped.
 */
export function crewPeopleFrom(
  crewRows: { id: string, slug: string }[],
  accounts: { id: string, email: string, crewId: string | null }[]
): CrewPerson[] {
  if (crewRows.length !== 1) return []
  const crew = crewRows[0]!
  return accounts
    .filter(account => account.crewId === crew.id)
    .filter(account => isCrewAddress(account.email) && normalizeAddress(account.email).startsWith(crew.slug + '-'))
    .map(account => ({ userId: account.id, key: personKeyOf(crew.slug, account.email) }))
}

async function crewPeopleOf(teamId: string): Promise<CrewPerson[]> {
  const crewRows = await db.select({ id: crews.id, slug: crews.slug }).from(crews).where(eq(crews.teamId, teamId))
  if (crewRows.length !== 1) return []
  const accounts = await db.select({ id: user.id, email: user.email, crewId: user.crewId })
    .from(user).where(eq(user.crewId, crewRows[0]!.id))
  return crewPeopleFrom(crewRows, accounts)
}

export const githubDatabaseLookups: GithubLookups = { ...databaseLookups, crewPeople: crewPeopleOf }

/** Whether a kind is one of the agent event kinds: the only kinds a frame may name. */
export function isAgentEventKind(kind: string): kind is AgentEventKind {
  return (AGENT_EVENT_KINDS as readonly string[]).includes(kind)
}

const rejectedKinds = new Set<string>()

/** Logs a kind that is not known, once per kind. Nothing is emitted for it. */
function rejectKind(kind: string): void {
  if (rejectedKinds.has(kind)) return
  rejectedKinds.add(kind)
  console.error('[agent-events] rejected an event of an unknown kind', JSON.stringify(kind).slice(0, 60))
}

/** The ref as an event names it: cleaned like a title, then cut to REF_LIMIT characters. */
function refText(ref: string): string | null {
  return Array.from(cleanEventText(ref)).slice(0, REF_LIMIT).join('') || null
}

/**
 * Keeps a GitHub change for each person who may hear it (githubAudience). Staff only: a customer never hears of one.
 * An unknown kind emits nothing. No database is read while nobody is watched. Returns how many people it was kept for.
 * The caller reads task.column from the database at emit time: inVerify trusts it.
 */
export async function emitGithubEventWith(hub: AgentEventHub, lookups: GithubLookups, input: GithubEventInput): Promise<number> {
  if (!(GITHUB_EVENT_KINDS as readonly string[]).includes(input.kind)) {
    rejectKind(input.kind)
    return 0
  }
  if (!hub.hasWatchers()) return 0
  const { board, task } = input
  const owners = [task.assigneeId, task.createdBy].filter((id): id is string => !!id)
  const crew = board.teamId ? await lookups.crewPeople(board.teamId) : []
  const keyOf = new Map(crew.map(person => [person.userId, person.key]))
  const candidates = new Set([...owners, ...crew.filter(person => person.key === 'pm' || person.key === 'boss').map(person => person.userId)])
  const inVerify = task.column?.toLowerCase() === 'verify'
  const ref = input.ref ? refText(input.ref) : null
  let kept = 0
  for (const userId of candidates) {
    if (!hub.watches(userId)) continue
    const staff = board.teamId ? await lookups.isMember(userId, board.teamId) : board.userId === userId
    if (!staff) continue
    const key = keyOf.get(userId)
    const role = { owner: owners.includes(userId), pm: key === 'pm', boss: key === 'boss' }
    if (!githubAudience(input.kind, role, inVerify)) continue
    hub.publish(userId, {
      kind: input.kind,
      board: board.id,
      task: task.id,
      from: null,
      origin: 'github',
      title: cleanEventText(task.title),
      ref,
      needsFeedbackFromMe: false,
      assignedToMe: task.assigneeId === userId,
      isPm: role.pm,
      isBoss: role.boss,
      audience: 'staff',
      teamId: board.teamId,
      customerId: board.customerId
    })
    kept++
  }
  return kept
}

/**
 * A GitHub change to a card's pull request (the webhook path calls this). Off the request path: it never throws,
 * and does no database work while nobody is watched.
 */
export function announceGithubEvent(input: GithubEventInput): void {
  if (!(GITHUB_EVENT_KINDS as readonly string[]).includes(input.kind)) {
    rejectKind(input.kind)
    return
  }
  emitInBackground(() => emitGithubEventWith(agentEventHub, githubDatabaseLookups, input))
}

/** A delivery that gave up, as the crew's pm hears of it: ids, the repository, the class, the attempts and a short code. */
export interface DeliveryFailure {
  deliveryId: string
  event: string
  owner: string
  repo: string
  class: 'transient' | 'permanent'
  attempts: number
  /** A short code for the reason (failureCode in githubDeliveryFailures): never the reason text. */
  code: string
}

/** The lookups of a delivery notice: the GitHub ones, the board a repository is linked to, and a team's owners. */
export interface DeliveryLookups extends GithubLookups {
  linkedBoard(owner: string, repo: string): Promise<AgentBoard | null>
  teamOwners(teamId: string): Promise<string[]>
}

/** Text from GitHub or a request: control characters stripped, cut to max characters. */
function plainText(text: string, max: number): string {
  return Array.from(text.replace(CONTROL, '')).slice(0, max).join('')
}

/**
 * Keeps a delivery_failed notice for the crew's pm only. A team that is not a crew gets it for its owners; a personal
 * board for its owner. The frame carries ids, the repository, the class, the attempts and a code, never the reason
 * text or the payload. Returns how many people it was kept for. No database is read while nobody is watched.
 */
export async function emitDeliveryFailedWith(hub: AgentEventHub, lookups: DeliveryLookups, input: DeliveryFailure): Promise<number> {
  if (!hub.hasWatchers()) return 0
  const board = await lookups.linkedBoard(input.owner, input.repo)
  if (!board) return 0
  const crew = board.teamId ? await lookups.crewPeople(board.teamId) : []
  const keyOf = new Map(crew.map(person => [person.userId, person.key]))
  let recipients: string[]
  if (!board.teamId) recipients = [board.userId]
  else if (crew.length) recipients = crew.filter(person => person.key === 'pm').map(person => person.userId)
  else recipients = await lookups.teamOwners(board.teamId)
  const title = cleanEventText(`${plainText(input.event, 40)} ${plainText(input.owner, 100)}/${plainText(input.repo, 100)}: ${input.class}, ${input.attempts} attempts (${plainText(input.code, 40)})`)
  const ref = refText(input.deliveryId)
  let kept = 0
  for (const userId of new Set(recipients)) {
    if (!hub.watches(userId)) continue
    const staff = board.teamId ? await lookups.isMember(userId, board.teamId) : board.userId === userId
    if (!staff) continue
    hub.publish(userId, {
      kind: 'delivery_failed',
      board: board.id,
      task: null,
      from: null,
      origin: 'github',
      title,
      ref,
      needsFeedbackFromMe: false,
      assignedToMe: false,
      isPm: keyOf.get(userId) === 'pm',
      isBoss: false,
      audience: 'staff',
      teamId: board.teamId,
      customerId: null
    })
    kept++
  }
  return kept
}

/**
 * The board and people of a delivery notice in the database: the first project that links the repository, its
 * team's crew (or owners), and the membership checks of GithubLookups.
 */
export const databaseDeliveryLookups: DeliveryLookups = {
  ...githubDatabaseLookups,
  async linkedBoard(owner, repo) {
    const [row] = await db.select({ id: projects.id, userId: projects.userId, teamId: projects.teamId, customerId: projects.customerId })
      .from(projectGithubRepos)
      .innerJoin(projects, eq(projects.id, projectGithubRepos.projectId))
      .where(and(
        sql`lower(${projectGithubRepos.owner}) = ${owner.toLowerCase()}`,
        sql`lower(${projectGithubRepos.repo}) = ${repo.toLowerCase()}`
      ))
      .orderBy(asc(projectGithubRepos.createdAt))
      .limit(1)
    return row ?? null
  },
  async teamOwners(teamId) {
    const rows = await db.select({ userId: member.userId }).from(member)
      .where(and(eq(member.organizationId, teamId), eq(member.role, 'owner')))
    return rows.map(row => row.userId)
  }
}

/**
 * A delivery of GitHub gave up for good and its row is written. Off the request path: it never throws, and it reads
 * nothing while nobody is watched. The consumer calls it only for a row that did not exist before.
 */
export function announceDeliveryFailed(input: DeliveryFailure): void {
  emitInBackground(() => emitDeliveryFailedWith(agentEventHub, databaseDeliveryLookups, input))
}
/** The name of who did a thing, for the event's `from`. */
export async function actorNameOf(userId: string | null): Promise<string | null> {
  if (!userId) return null
  const [row] = await db.select({ name: user.name }).from(user).where(eq(user.id, userId))
  return row?.name ?? null
}

/** The teams and customers a user belongs to right now. */
export async function currentMembership(userId: string): Promise<Membership> {
  const teams = await db.select({ teamId: member.organizationId }).from(member).where(eq(member.userId, userId))
  return { teamIds: teams.map(team => team.teamId), customerIds: await customerIdsOf(userId) }
}

/**
 * Whether a stream's key may still stream: the key exists, has not expired, still has
 * boards:read, its owner's crew is live and its team membership holds. Null when it may.
 */
export async function streamVerdict(key: StreamKey): Promise<CloseReason | null> {
  const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, key.keyId))
  if (!row || row.userId !== key.userId) return 'key_revoked'
  if (row.expiresAt && row.expiresAt <= Date.now()) return 'disabled'
  if (!row.scopes.includes('boards:read')) return 'disabled'
  if (!(await crewAccountLive(key.userId))) return 'disabled'
  if (row.teamId && !(await isTeamMember(key.userId, row.teamId))) return 'disabled'
  return null
}

/**
 * A card was created: each person on its board who is watched and may see it hears of
 * it. Origin says where the card came from (a person, an agent key, GitHub or a rule).
 */
export function announceTaskCreated(
  board: AgentBoard,
  task: AgentTaskRef & { visibility: 'internal' | 'customer' },
  actorId: string | null,
  origin: AgentEventOrigin
): void {
  emitInBackground(async () => {
    const watched = (await projectPeople(board)).filter(person => agentEventHub.watches(person.id))
    if (!watched.length) return
    const from = await actorNameOf(actorId)
    for (const person of watched) {
      await emitAgentEventAsync(person.id, {
        kind: 'task_created',
        board,
        task,
        from,
        origin,
        customerVisible: task.visibility === 'customer'
      })
    }
  })
}
