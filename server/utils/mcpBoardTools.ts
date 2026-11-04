// The kanban tools Taskmanager exposes over MCP: everything the board UI can do —
// boards, columns, tasks, ordering and updates — reachable by an agent with a
// `boards:*` key. They run against the database here, scoped to the workspace of
// the API key, and mirror the HTTP endpoints the browser uses so a board changed
// by an agent is indistinguishable from one changed by hand.
import { and, asc, count, eq, gt, inArray, isNull } from 'drizzle-orm'
import { db } from '../db'
import { projects, projectColumns, projectTasks, taskComments, user, apiKeys } from '../db/schema'
import type { Project, ProjectColumn, ProjectTask } from '../db/schema'
import type { ApiKeyContext } from './api-keys'
import { audienceOf, boardFilter, readableTasksIn, requireStaffAudience } from './mcpAccess'
import { commentVisibilityFilter, taskVisibilityFilter, type Audience } from './auth-helpers'
import { htmlToMarkdown, htmlToPlainText, markdownToHtml } from './markdown'
import { columnTasksOrdered, positionBetween, projectColumnsOrdered, renumberColumnTasks, RESTORED, nextSubtaskPosition, subtasksOrdered } from './projects'
import { ACCENT_COLORS, isAccentColor } from '#shared/utils/colors'
import { McpToolError, asToolError, asToolErrorAsync, excerpt, idFromReference, newId, optionalBoolean, optionalLimit, optionalString, optionalStringArray, requireString } from './mcpToolKit'
import type { McpToolDefinition } from './mcpToolKit'
import { MAX_PROJECT_DESCRIPTION, PROJECT_STATUSES, parseDueOn, parseProjectStatus } from './taskFields'
import { projectPeople } from './people'
import { readTaskGithubLinks } from './githubTaskLinks'
import { notifyAssigned, notifyTaskChange } from './notifyEvents'
import { tellUnblockedAfterBulk, tellUnblockedOnTrash, unfinishedTasksOn } from './unblockedWatch'
import { announceTaskCreated } from './agentEvents'
import { recordAgentAction } from './agentAudit'
import { pmDiscard, pmGet, pmList, pmQueueStatus, pmRetry, type FailureState } from './githubDeliveryFailures'
import { fireRules, newRuleChain } from './ruleEngine'
import type { TriggerKind } from './ruleSpec'
import { changesToTask, inboxBriefs, logActivity } from './taskActivity'
import { checkFieldValues, describeFieldValues, listFields, loadFieldValues, setFieldValues } from './customFields'
import { attachReplyPreviews, signedName } from './taskComments'
import { addBlocker, blockedState, blockedStatesOn, listBlockers, NOT_ON_BOARD, removeBlocker } from './taskDependencyService'
import type { Actor, Tx } from './taskDependencyService'
import { blockedMark, checkLinkCount, linkOrFail } from './mcpBlockerLinks'
import type { BlockedMark } from './mcpBlockerLinks'
import { capThread, parseSinceTime, readThreadOptions, selectUpdates, SINCE_REFUSAL, THREAD_CAP, THREAD_CAP_NOTE } from './threadOptions'
import type { ThreadOptions } from './threadOptions'

const MAX_LABELS = 10
const DEFAULT_COLUMN_NAMES = ['Backlog', 'To do', 'Verify', 'Done']

// The kanban card shows one line of the description; board-shaped results carry
// the same 160 characters so what an agent reads matches what the user sees.
const SUMMARY_LENGTH = 160

// A board is read column by column. The cap is per column rather than per board
// so a long Backlog cannot crowd out the Done column an agent came to look at.
const DEFAULT_COLUMN_TASKS = 50
const MAX_COLUMN_TASKS = 200

// Nothing an agent can reach removes a board, a column or a task for good. A
// delete over MCP puts the row in the board's trash, where the user can see it
// under "Show trashed" and put it back — and where it is removed on its own
// after a week. Permanent deletion stays in the app, in front of a human.
function agentDeletion(context: ApiKeyContext) {
  return {
    deletedAt: Date.now(),
    deletedBy: context.userId,
    deletedVia: 'mcp' as const
  }
}

// ─── lookups ──────────────────────────────────────────────────────────────────

// The boards a key can reach are the ones its person can open in the browser;
// see mcpAccess.ts for the rule and for what each audience may do on them.
export async function accessibleBoards(context: ApiKeyContext): Promise<Project[]> {
  return db.select().from(projects).where(await boardFilter(context))
}

/**
 * Boards are addressable by id, by name, or by a link copied out of the app, so
 * an agent can use whichever the user handed it.
 */
export async function findBoard(reference: string, context: ApiKeyContext): Promise<Project> {
  const ref = idFromReference(reference)
  const boards = await accessibleBoards(context)
  const match = boards.find(board => board.id === ref)
    ?? boards.find(board => board.name.toLowerCase() === ref.trim().toLowerCase())

  if (!match) {
    const known = boards.map(board => board.name).join(', ')
    throw new McpToolError(
      `No board "${ref}" in this workspace.`
      + (known ? ` Available boards: ${known}.` : ' The workspace has no boards yet; create one with create_board.')
    )
  }
  return match
}

/** A board, for something only its team may do; a customer's contact is refused by name. */
export async function findStaffBoard(reference: string, context: ApiKeyContext, doing: string): Promise<Project> {
  const board = await findBoard(reference, context)
  requireStaffAudience(context, board, doing)
  return board
}

/** Columns likewise: an id, or the column name as it reads on the board. */
async function findColumn(board: Project, ref: string): Promise<ProjectColumn> {
  const columns = await projectColumnsOrdered(board.id)
  const match = columns.find(column => column.id === ref)
    ?? columns.find(column => column.name.toLowerCase() === ref.trim().toLowerCase())

  if (!match) {
    throw new McpToolError(
      `Board "${board.name}" has no column "${ref}". Its columns are: ${columns.map(c => c.name).join(', ')}.`
    )
  }
  return match
}

export async function findTask(
  reference: string,
  context: ApiKeyContext,
  // `staff` names what is being done when only the board's team may do it.
  options: { includeDeleted?: boolean, staff?: string } = {}
): Promise<{ task: ProjectTask, board: Project }> {
  // A board link with a task open names that task, which is what a user copying
  // out of the address bar will have in hand.
  const id = idFromReference(reference, 'task')
  const missing = options.includeDeleted
    ? `No task with id "${id}" exists.`
    : `No task with id "${id}" exists, or it is in the board's trash — restore_task brings it back.`

  const [task] = await db
    .select()
    .from(projectTasks)
    .where(and(
      eq(projectTasks.id, id),
      options.includeDeleted ? undefined : isNull(projectTasks.deletedAt)
    ))
  if (!task) throw new McpToolError(missing)

  const [board] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, task.projectId), await boardFilter(context)))
  if (!board) throw new McpToolError(`Task "${id}" is not in this workspace.`)

  // What the person cannot see is not there for the agent either: an internal
  // task, or a trashed one, is reported as missing to a customer's contact.
  if (audienceOf(context, board) === 'customer' && (task.visibility === 'internal' || task.deletedAt)) {
    throw new McpToolError(missing)
  }
  if (options.staff) requireStaffAudience(context, board, options.staff)

  return { task, board }
}

export function touchBoard(boardId: string) {
  return db.update(projects).set({ updatedAt: Date.now() }).where(eq(projects.id, boardId))
}

// ─── blocked-by links ─────────────────────────────────────────────────────────

/** Whether a task waits for an open blocker, as the audience may read it (see blockedMark). */
export async function blockedFor(taskId: string, audience: Audience): Promise<BlockedMark> {
  return blockedMark(await blockedState(taskId), audience)
}

/** The task ids a call names under `key`, by id or pasted link, each once, each on this board. */
async function blockerIdsOn(args: Record<string, unknown>, key: string, board: Project, context: ApiKeyContext, options: { deleted?: boolean } = {}): Promise<string[]> {
  const listed = optionalStringArray(args, key) ?? []
  checkLinkCount(listed, key)
  const ids = [...new Set(listed.map(ref => idFromReference(ref, 'task')).filter(Boolean))]
  for (const id of ids) {
    const { task } = await findTask(id, context, { includeDeleted: options.deleted })
    if (task.projectId !== board.id) throw new McpToolError(NOT_ON_BOARD)
  }
  return ids
}

/**
 * Makes and removes blocked-by links for one task, inside the caller's transaction. A refused link
 * throws, so the transaction that holds the task's own write rolls back with it.
 */
async function changeBlockers(tx: Tx, board: Project, taskId: string, actor: Actor, adds: string[], removes: string[]): Promise<void> {
  for (const blockerId of adds) linkOrFail(await addBlocker(board.id, taskId, blockerId, actor, tx))
  for (const blockerId of removes) linkOrFail(await removeBlocker(board.id, taskId, blockerId, actor, tx))
}

// ─── people and schedule ──────────────────────────────────────────────────────

/** Who can be named on a board's tasks, by id, so cards can say who has them. */
export async function peopleNames(board: Project): Promise<Map<string, string>> {
  return new Map((await projectPeople(board)).map(person => [person.id, person.name || person.email]))
}

/** A person on the board, found by id, email or name as the app shows it. */
async function findPerson(board: Project, reference: string): Promise<string> {
  const people = await projectPeople(board)
  const needle = reference.trim().toLowerCase()
  const match = people.find(person => person.id === reference)
    ?? people.find(person => person.email.toLowerCase() === needle)
    ?? people.find(person => (person.name || '').toLowerCase() === needle)
  if (!match) {
    throw new McpToolError(
      `"${reference}" is not on board "${board.name}". People who can be assigned: ${people.map(person => person.name || person.email).join(', ')}.`
    )
  }
  return match.id
}

/**
 * The schedule, assignee and done mark from a create or update call, checked by
 * the same rules as the panel. An empty string clears a date or the assignee.
 */
async function readTaskFields(args: Record<string, unknown>, board: Project, current?: ProjectTask) {
  const dueOn = optionalString(args, 'dueOn')
  const startOn = optionalString(args, 'startOn')
  const assignee = optionalString(args, 'assignee')
  const completed = optionalBoolean(args, 'completed')

  return {
    ...(dueOn !== undefined ? { dueOn: asToolError(() => parseDueOn(dueOn)) } : {}),
    ...(startOn !== undefined ? { startOn: asToolError(() => parseDueOn(startOn)) } : {}),
    ...(assignee !== undefined ? { assigneeId: assignee.trim() ? await findPerson(board, assignee) : null } : {}),
    // Ticking a task that is already done keeps the moment it was finished.
    ...(completed !== undefined ? { completedAt: completed ? (current?.completedAt ?? Date.now()) : null } : {})
  }
}

const TASK_FIELD_PROPERTIES = {
  dueOn: { type: 'string', description: 'Due date as YYYY-MM-DD. Pass an empty string to clear it.' },
  startOn: { type: 'string', description: 'Start date as YYYY-MM-DD, shown as the left edge of the task on the timeline. Pass an empty string to clear it.' },
  assignee: { type: 'string', description: 'Who has the task: a person on the board by name, email or id. Pass an empty string to unassign.' },
  completed: { type: 'boolean', description: 'Mark the task done (true) or not done (false). This is separate from its column.' },
  fields: { type: 'object', description: 'Custom field values by field name, e.g. {"Priority": "High", "Estimate (hours)": 3}. list_fields shows what the board has; a select takes one of its option labels, and null clears a value.' }
}

/** The `fields` argument: a map of field name to value, checked later against the board's fields. */
function readFieldMap(args: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = args.fields
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new McpToolError('"fields" must be an object of field name to value.')
  }
  return value as Record<string, unknown>
}

// ─── shapes ───────────────────────────────────────────────────────────────────

function normalizeLabels(labels: string[]): string[] {
  return [...new Set(labels.map(label => label.replace(/^#/, '').trim().toLowerCase()).filter(Boolean))].slice(0, MAX_LABELS)
}

async function commentCounts(taskIds: string[]): Promise<Map<string, number>> {
  if (!taskIds.length) return new Map()
  const rows = await db
    .select({ taskId: taskComments.taskId, total: count() })
    .from(taskComments)
    .where(inArray(taskComments.taskId, taskIds))
    .groupBy(taskComments.taskId)

  return new Map(rows.map(row => [row.taskId, Number(row.total)]))
}

/** A task's custom field values by field name, left out when it has none. */
async function describedFields(board: Project, task: ProjectTask) {
  const fields = await listFields(board.id)
  if (!fields.length) return {}
  const described = describeFieldValues(fields, (await loadFieldValues([task.id]))[task.id])
  return Object.keys(described).length ? { fields: described } : {}
}

/** Dates, assignee and the done mark, for the tasks that have them. */
function taskSchedule(task: ProjectTask, people?: Map<string, string>) {
  return {
    ...(task.dueOn ? { dueOn: task.dueOn } : {}),
    ...(task.startOn ? { startOn: task.startOn } : {}),
    ...(task.assigneeId ? { assignee: people?.get(task.assigneeId) ?? task.assigneeId } : {}),
    ...(task.completedAt ? { completed: true, completedAt: new Date(task.completedAt).toISOString() } : {})
  }
}

function boardSummary(board: Project, columns: number, tasks: number) {
  return {
    id: board.id,
    name: board.name,
    ...(board.status ? { status: board.status } : {}),
    columns,
    tasks,
    createdAt: new Date(board.createdAt).toISOString(),
    updatedAt: new Date(board.updatedAt).toISOString()
  }
}

/**
 * How much of a task a list-shaped result carries. Reading a board used to hand
 * back every description in full, which on a real board is most of the payload
 * and almost none of what the caller asked for.
 *
 * - `titles`: the card without its text — the cheapest way to see the shape of a board
 * - `summary`: the card as it renders, with the opening of the description (default)
 * - `full`: every description in Markdown, for the rare sweep that really needs them
 */
export type TaskDetail = 'titles' | 'summary' | 'full'

function readDetail(args: Record<string, unknown>): TaskDetail {
  const value = optionalString(args, 'detail')
  if (value === undefined) return 'summary'
  if (value !== 'titles' && value !== 'summary' && value !== 'full') {
    throw new McpToolError('"detail" must be one of "titles", "summary" or "full".')
  }
  return value
}

/**
 * A task as the board draws it: title, labels and a line of the description.
 * The whole description and the thread of updates live behind get_task, so a
 * board of 200 tasks reads as a board and not as 200 documents.
 *
 * `column` and `board` are named only where the nesting does not already say so
 * — search results carry them, a board's own columns do not.
 */
function taskCard(task: ProjectTask, options: {
  detail?: TaskDetail
  updates?: number
  terms?: string[]
  column?: string
  parent?: string
  board?: string
  people?: Map<string, string>
  fields?: Record<string, string | number>
  blocked?: BlockedMark
} = {}) {
  const detail = options.detail ?? 'summary'
  const terms = options.terms ?? []

  return {
    id: task.id,
    ...(options.board ? { board: options.board } : {}),
    ...(options.column ? { column: options.column } : {}),
    ...(options.parent ? { parent: options.parent } : {}),
    title: task.title,
    labels: task.tags,
    ...(options.blocked ?? {}),
    // Like the update count, a field nobody has filled in is left out.
    ...taskSchedule(task, options.people),
    ...(options.fields && Object.keys(options.fields).length ? { fields: options.fields } : {}),
    ...(detail === 'titles'
      ? {}
      : detail === 'full'
        ? { description: task.description ? htmlToMarkdown(task.description) : '' }
        // An excerpt centred on the query when there is one, otherwise the
        // opening of the text. A trailing ellipsis is the signal that get_task
        // has more to give.
        : { summary: excerpt(htmlToPlainText(task.description), terms, SUMMARY_LENGTH, terms.length ? 60 : 0) }),
    // A task nobody has posted on says so by leaving the field out.
    ...(options.updates ? { updates: options.updates } : {}),
    updatedAt: new Date(task.updatedAt).toISOString()
  }
}

/**
 * The moment get_task's since names: a zoned ISO time, or the time of an update this caller
 * can see on the task. Any other id reads as unknown, so a hidden update leaks nothing.
 */
async function sinceMoment(taskId: string, since: string, audience: Audience): Promise<number> {
  const time = parseSinceTime(since)
  if (time !== undefined) return time
  const [marker] = await db
    .select({ createdAt: taskComments.createdAt })
    .from(taskComments)
    .where(and(eq(taskComments.id, since), eq(taskComments.taskId, taskId), commentVisibilityFilter(audience)))
  if (!marker) throw new McpToolError(SINCE_REFUSAL)
  return marker.createdAt
}

async function taskDetail(task: ProjectTask, board: Project, context: ApiKeyContext, thread: ThreadOptions) {
  const audience = audienceOf(context, board)
  const columns = await projectColumnsOrdered(board.id)
  const column = columns.find(c => c.id === task.columnId)
  const blockers = await listBlockers(task.id, { userId: context.userId, audience })

  const sinceAt = thread.since === undefined ? undefined : await sinceMoment(task.id, thread.since, audience)
  const fetched = await db
    .select({
      id: taskComments.id,
      body: taskComments.body,
      replyToId: taskComments.replyToId,
      createdAt: taskComments.createdAt,
      visibility: taskComments.visibility,
      createdVia: taskComments.createdVia,
      authorName: user.name,
      keyName: apiKeys.name
    })
    .from(taskComments)
    .leftJoin(user, eq(user.id, taskComments.userId))
    .leftJoin(apiKeys, eq(apiKeys.id, taskComments.apiKeyId))
    .where(and(eq(taskComments.taskId, task.id), commentVisibilityFilter(audience), sinceAt === undefined ? undefined : gt(taskComments.createdAt, sinceAt)))
    .orderBy(asc(taskComments.createdAt))
    .limit(THREAD_CAP + 1)

  // The filters and the limit apply to what this caller may see, so the counts never include internal updates for a customer.
  // The read stops one past the cap, so a longer thread is seen and reported rather than loaded whole.
  const { rows: updates, truncated } = capThread(fetched)
  const selected = selectUpdates(updates, thread, audience)

  return {
    id: task.id,
    board: { id: board.id, name: board.name },
    column: column?.name ?? task.columnId,
    title: task.title,
    labels: task.tags,
    ...taskSchedule(task, await peopleNames(board)),
    ...(audience === 'staff' ? await describedFields(board, task) : {}),
    ...(await blockedFor(task.id, audience)),
    ...(blockers.length ? { blockers } : {}),
    description: task.description ? htmlToMarkdown(task.description) : '',
    // The GitHub links the caller may see, with what GitHub says about each (see githubTaskLinks).
    github: (await readTaskGithubLinks({ taskId: task.id, audience })).links,
    // The subtasks the caller may see; a subtask names its parent.
    subtasks: await subtaskCards(task, board, context),
    ...(task.parentTaskId ? { parent: task.parentTaskId } : {}),
    createdAt: new Date(task.createdAt).toISOString(),
    updatedAt: new Date(task.updatedAt).toISOString(),
    // Update bodies are stored as the inline Markdown they were written in, by
    // an agent here or by a person in the app, so they pass through untouched.
    // An agent's update is attributed to its key, not to the key's owner, so a
    // thread reads back as the conversation it was.
    updates: (await attachReplyPreviews(task.id, selected.shown, audience)).map(update => ({
      id: update.id,
      author: update.createdVia === 'mcp'
        ? `${update.keyName ?? 'MCP key'} (agent)`
        : signedName({ createdVia: update.createdVia, userName: update.authorName }) ?? 'Unknown',
      body: update.body,
      at: new Date(update.createdAt).toISOString(),
      // The comment this one answers, as the app shows it (see taskComments.ts).
      replyTo: update.replyTo
    })),
    updatesMatched: selected.matched,
    updatesShown: selected.shown.length,
    ...(truncated ? { threadNote: THREAD_CAP_NOTE } : {})
  }
}

/** A task's live subtasks as the caller may see them: id, title, assignee and done state. */
async function subtaskCards(task: ProjectTask, board: Project, context: ApiKeyContext) {
  const audience = audienceOf(context, board)
  const people = await peopleNames(board)
  return (await subtasksOrdered(task.id))
    .filter(sub => audience === 'staff' || sub.visibility === 'customer')
    .map(sub => ({
      id: sub.id,
      title: sub.title,
      ...(sub.assigneeId ? { assignee: people.get(sub.assigneeId) ?? sub.assigneeId } : {}),
      completed: !!sub.completedAt
    }))
}

// ─── ordering ─────────────────────────────────────────────────────────────────

async function renumberTasks(ids: string[]) {
  for (const [index, id] of ids.entries()) {
    await db.update(projectTasks).set({ position: index * 1000 }).where(eq(projectTasks.id, id))
  }
}

async function renumberColumns(ids: string[]) {
  for (const [index, id] of ids.entries()) {
    await db.update(projectColumns).set({ position: index * 1000 }).where(eq(projectColumns.id, id))
  }
}

type Placement = 'top' | 'bottom'

function readPlacement(args: Record<string, unknown>): Placement {
  const value = optionalString(args, 'position')
  if (value === undefined) return 'bottom'
  if (value !== 'top' && value !== 'bottom') {
    throw new McpToolError('"position" must be either "top" or "bottom".')
  }
  return value
}

/**
 * Where a task lands in a column: at either end, or directly after a named task.
 * `after` wins over `position` when both are given.
 */
async function taskPosition(columnId: string, placement: Placement, afterTaskId: string | undefined, excludeTaskId?: string) {
  const siblings = (await columnTasksOrdered(columnId))
    .filter(task => task.id !== excludeTaskId)
    .map(task => ({ id: task.id, position: task.position }))

  let beforeId: string | null = null
  let afterId: string | null = null

  if (afterTaskId) {
    const index = siblings.findIndex(task => task.id === afterTaskId)
    if (index < 0) throw new McpToolError(`Task "${afterTaskId}" is not in the target column, so nothing can be placed after it.`)
    beforeId = siblings[index]!.id
    afterId = siblings[index + 1]?.id ?? null
  } else if (placement === 'top') {
    afterId = siblings[0]?.id ?? null
  } else {
    beforeId = siblings.at(-1)?.id ?? null
  }

  return positionBetween(siblings, beforeId, afterId, renumberTasks)
}

// Where a column sits on the board: at either end, or directly after another.
type ColumnSpot = { at: 'start' } | { at: 'end' } | { at: 'after', columnId: string }

async function columnPosition(boardId: string, spot: ColumnSpot, excludeColumnId?: string) {
  const siblings = (await projectColumnsOrdered(boardId))
    .filter(column => column.id !== excludeColumnId)
    .map(column => ({ id: column.id, position: column.position }))

  if (spot.at === 'start') return positionBetween(siblings, null, siblings[0]?.id ?? null, renumberColumns)
  if (spot.at === 'end') return positionBetween(siblings, siblings.at(-1)?.id ?? null, null, renumberColumns)

  const index = siblings.findIndex(column => column.id === spot.columnId)
  if (index < 0) throw new McpToolError('The column named in "after" is not on this board.')
  return positionBetween(siblings, siblings[index]!.id, siblings[index + 1]?.id ?? null, renumberColumns)
}

/** Reads the optional "after" argument into a spot on the board. */
function columnSpot(afterRef: string | undefined, resolvedId: string | undefined): ColumnSpot {
  if (afterRef === undefined) return { at: 'end' }
  // An explicit empty "after" means "nothing before it" — the far left.
  if (!afterRef.trim()) return { at: 'start' }
  return { at: 'after', columnId: resolvedId! }
}

// ─── tools ────────────────────────────────────────────────────────────────────

// The PM's delivery tools (GH6c). Staff only: a key sees the failed deliveries of the repositories its team's projects
// link, and a delivery of any other repository is refused with the same words as one that does not exist
// (githubDeliveryFailures: managedRepos, pmGet and the others). Retry and discard are audited, refusals included.
const DELIVERY_ID = { type: 'string', description: 'The delivery id, from list_failed_deliveries.' }
const DELIVERY_STATES = ['failed', 'retried', 'discarded', 'resolved', 'all']

const LIST_FAILED_DELIVERIES: McpToolDefinition = {
  name: 'list_failed_deliveries',
  title: 'List failed GitHub deliveries',
  description: 'The GitHub deliveries that gave up, newest first, for the repositories of your team\'s projects: the event, the repository, the class (transient or permanent), the attempts, the state and the reason in one line. Metadata only, never the payload. Read one with get_failed_delivery; retry it or discard it after that.',
  scope: 'boards:read',
  readOnly: true,
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'How many to show, newest first. Default 50, at most 200.' },
      state: { type: 'string', enum: DELIVERY_STATES, description: 'The state to show. Default failed.' }
    }
  },
  async handler(args, context) {
    const state = optionalString(args, 'state') ?? 'failed'
    if (!DELIVERY_STATES.includes(state)) throw new McpToolError('"state" must be failed, retried, discarded, resolved or all.')
    return pmList(context, { limit: optionalLimit(args, 'limit', 50, 200), state: state as FailureState | 'all' })
  }
}

const GET_FAILED_DELIVERY: McpToolDefinition = {
  name: 'get_failed_delivery',
  title: 'Read a failed GitHub delivery',
  description: 'One failed GitHub delivery: its metadata and a short preview of its payload (the event, the action, the repository, the issue or pull request number, and the title cut to 120 characters). Never the payload or the body.',
  scope: 'boards:read',
  readOnly: true,
  audit: true,
  inputSchema: {
    type: 'object',
    properties: { id: DELIVERY_ID },
    required: ['id']
  },
  async handler(args, context) {
    return pmGet(context, requireString(args, 'id'))
  }
}

const RETRY_FAILED_DELIVERY: McpToolDefinition = {
  name: 'retry_failed_delivery',
  title: 'Retry a failed GitHub delivery',
  description: 'Crew pm key only. Send a failed GitHub delivery back into the queue once, with the payload GitHub sent. Use it when the cause is gone (the database or the broker was down). It answers retried, already retried, not failed, payload expired, or claim expired — retried again when an earlier retry had stalled. A second call changes nothing.',
  scope: 'boards:write',
  readOnly: false,
  inputSchema: {
    type: 'object',
    properties: { id: DELIVERY_ID },
    required: ['id']
  },
  async handler(args, context) {
    const id = requireString(args, 'id')
    try {
      return await pmRetry(context, id)
    } catch (error) {
      if (error instanceof McpToolError) await recordAgentAction(RETRY_FAILED_DELIVERY, args, { deliveryId: id, outcome: 'refused', message: error.message }, context)
      throw error
    }
  }
}

const DISCARD_FAILED_DELIVERY: McpToolDefinition = {
  name: 'discard_failed_delivery',
  title: 'Discard a failed GitHub delivery',
  description: 'Crew pm key only. Drop a failed GitHub delivery for good, with a reason of 3 to 300 characters that is kept in the audit. The GitHub change it carried is not applied. The payload stays in the record until its retention ends, for the audit.',
  scope: 'boards:write',
  readOnly: false,
  inputSchema: {
    type: 'object',
    properties: {
      id: DELIVERY_ID,
      reason: { type: 'string', description: 'Why the delivery is dropped, 3 to 300 characters.' }
    },
    required: ['id', 'reason']
  },
  async handler(args, context) {
    const id = requireString(args, 'id')
    try {
      const reason = requireString(args, 'reason').trim()
      if (reason.length < 3 || reason.length > 300) throw new McpToolError('"reason" must be 3 to 300 characters: say why the delivery is dropped.')
      return await pmDiscard(context, id, reason)
    } catch (error) {
      if (error instanceof McpToolError) await recordAgentAction(DISCARD_FAILED_DELIVERY, args, { deliveryId: id, outcome: 'refused', message: error.message }, context)
      throw error
    }
  }
}

const GITHUB_QUEUE_STATUS: McpToolDefinition = {
  name: 'github_queue_status',
  title: 'GitHub delivery queue status',
  description: 'The state of the queue GitHub deliveries wait in: the broker state as a fixed word with a sentence, how many wait, how many gave up for good, and the failed rows of your repositories by state. The broker address, its credentials, any host and any port are never shown. Not audited: a read.',
  scope: 'boards:read',
  readOnly: true,
  inputSchema: { type: 'object', properties: {} },
  async handler(_args, context) {
    return pmQueueStatus(context)
  }
}

const DELIVERY_TOOLS: McpToolDefinition[] = [LIST_FAILED_DELIVERIES, GET_FAILED_DELIVERY, RETRY_FAILED_DELIVERY, DISCARD_FAILED_DELIVERY, GITHUB_QUEUE_STATUS]
export const MCP_BOARD_TOOLS: McpToolDefinition[] = [
  {
    name: 'list_boards',
    title: 'List boards',
    description: 'List the kanban boards in the workspace, most recently updated first, with how many columns and tasks each holds. Start here when you do not know which board the user means.',
    scope: 'boards:read',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum boards to return (default 25, max 200).' }
      }
    },
    async handler(args, context) {
      const limit = optionalLimit(args, 'limit', 25, 200)
      const boards = (await accessibleBoards(context)).sort((a, b) => b.updatedAt - a.updatedAt)
      if (!boards.length) return { total: 0, boards: [] }

      // Only the boards that are actually returned need counting.
      const ids = boards.slice(0, limit).map(board => board.id)
      const [columns, tasks] = await Promise.all([
        db
          .select({ projectId: projectColumns.projectId, total: count() })
          .from(projectColumns)
          .where(and(inArray(projectColumns.projectId, ids), isNull(projectColumns.deletedAt)))
          .groupBy(projectColumns.projectId),
        db
          .select({ projectId: projectTasks.projectId, total: count() })
          .from(projectTasks)
          .where(and(readableTasksIn(context, boards.slice(0, limit)), isNull(projectTasks.deletedAt)))
          .groupBy(projectTasks.projectId)
      ])

      const countBy = (rows: { projectId: string, total: number }[]) =>
        new Map(rows.map(row => [row.projectId, Number(row.total)]))
      const columnCounts = countBy(columns)
      const taskCounts = countBy(tasks)

      return {
        total: boards.length,
        boards: boards.slice(0, limit).map(board =>
          boardSummary(board, columnCounts.get(board.id) ?? 0, taskCounts.get(board.id) ?? 0)
        )
      }
    }
  },
  {
    name: 'get_board',
    title: 'Read a board',
    description: 'Read a board the way it is drawn: its columns in order, and in each the tasks with their title, labels and the opening line of the description. Call this before creating or moving tasks so board, column and task names match exactly, then get_task for the full description and updates of the one you care about. Narrow a big board with "columns", and pass detail:"titles" for the cheapest overview. A task that waits for an open blocker reads blocked: true with blockedBy (the open blocker ids, team only); blocked: false means it is ready.',
    scope: 'boards:read',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        board: { type: 'string', description: 'Board id, board name, or a link to the board copied from the app.' },
        columns: { type: 'array', items: { type: 'string' }, description: 'Only read these columns (ids or names, e.g. ["To do", "Verify"]). Omit for the whole board.' },
        detail: { type: 'string', description: '"titles" for titles and labels only, "summary" (default) to add the opening of each description, "full" for every description in Markdown — expensive on a large board.' },
        limit: { type: 'number', description: `Maximum tasks per column (default ${DEFAULT_COLUMN_TASKS}, max ${MAX_COLUMN_TASKS}). Anything past it is reported as "omitted" on the column.` }
      },
      required: ['board']
    },
    async handler(args, context) {
      const board = await findBoard(requireString(args, 'board'), context)
      const detail = readDetail(args)
      const perColumn = optionalLimit(args, 'limit', DEFAULT_COLUMN_TASKS, MAX_COLUMN_TASKS)
      const requested = optionalStringArray(args, 'columns')
        ?.map(ref => ref.trim().toLowerCase())
        .filter(Boolean)

      const allColumns = await projectColumnsOrdered(board.id)
      const columns = requested?.length
        ? allColumns.filter(column => requested.includes(column.id.toLowerCase()) || requested.includes(column.name.toLowerCase()))
        : allColumns

      if (requested?.length && !columns.length) {
        throw new McpToolError(
          `Board "${board.name}" has none of those columns. Its columns are: ${allColumns.map(column => column.name).join(', ')}.`
        )
      }

      const tasks = columns.length
        ? await db
            .select()
            .from(projectTasks)
            .where(and(
              inArray(projectTasks.columnId, columns.map(column => column.id)),
              isNull(projectTasks.parentTaskId),
              isNull(projectTasks.deletedAt),
              taskVisibilityFilter(audienceOf(context, board))
            ))
            .orderBy(asc(projectTasks.position))
        : []

      // The board's real size, which `tasks` does not carry when the read was
      // narrowed to a few columns.
      const [total] = await db
        .select({ tasks: count() })
        .from(projectTasks)
        .where(and(eq(projectTasks.projectId, board.id), isNull(projectTasks.deletedAt), isNull(projectTasks.parentTaskId), taskVisibilityFilter(audienceOf(context, board))))

      // Clip each column before counting updates: the counts are only needed for
      // the tasks that make it into the answer.
      const grouped = columns.map((column) => {
        const all = tasks.filter(task => task.columnId === column.id)
        return { column, total: all.length, shown: all.slice(0, perColumn) }
      })
      const counts = await commentCounts(grouped.flatMap(group => group.shown.map(task => task.id)))
      const audience = audienceOf(context, board)
      // One read of the board's links for every card shown, not one per card.
      const states = await blockedStatesOn(board.id, grouped.flatMap(group => group.shown).map(task => task.id))
      const marks = new Map([...states].map(([id, state]) => [id, blockedMark(state, audience)] as const))
      const people = await peopleNames(board)
      // Custom fields are the team's own; a contact's board has none to show.
      const fieldDefs = audienceOf(context, board) === 'staff' ? await listFields(board.id) : []
      const fieldValues = fieldDefs.length ? await loadFieldValues(grouped.flatMap(group => group.shown.map(task => task.id))) : {}

      return {
        id: board.id,
        name: board.name,
        ...(board.status ? { status: board.status } : {}),
        ...(board.description ? { description: board.description } : {}),
        updatedAt: new Date(board.updatedAt).toISOString(),
        taskCount: Number(total?.tasks ?? 0),
        // Say which columns were left out, so a narrowed read does not look like
        // the whole board to whoever reads the result.
        ...(columns.length < allColumns.length
          ? { otherColumns: allColumns.filter(column => !columns.includes(column)).map(column => column.name) }
          : {}),
        columns: grouped.map(({ column, total, shown }) => ({
          id: column.id,
          name: column.name,
          taskCount: total,
          ...(total > shown.length ? { omitted: total - shown.length } : {}),
          tasks: shown.map(task => taskCard(task, {
            detail,
            updates: counts.get(task.id),
            blocked: marks.get(task.id),
            people,
            fields: describeFieldValues(fieldDefs, fieldValues[task.id])
          }))
        }))
      }
    }
  },
  {
    name: 'get_task',
    title: 'Read a task',
    description: 'Read one task in full: its column, Markdown description, labels, the GitHub items linked to it (the ones the key\'s person may see, with their state and pull requests) and the thread of updates posted on it. Blocked-by links are listed as blockers, and blocked is true while one of them is open. This is where the complete description lives — get_board and search_tasks only carry the opening of it. By default, returns the last 5 updates newest first, to keep context lean. On a long one, read a slice: "limit" (1 to 200) with "order" to choose how many and in which order; "since" keeps updates after a full ISO 8601 time with a zone (such as 2026-11-02T10:00:00Z) or after an update id; "prefix" keeps updates whose body starts with that text, ignoring case. Filters apply before the limit. One example per option: {"id":"<task id>","limit":10,"order":"oldest"} gives the ten oldest updates; {"id":"<task id>","order":"oldest"} gives all updates oldest first; {"id":"<task id>","since":"2026-11-02T10:00:00Z"} gives the updates after that time; {"id":"<task id>","prefix":"QUESTION"} gives only the updates that start with QUESTION. The result says updatesMatched (how many matched in all) and updatesShown (how many came back): when they differ you have a slice. Counts cover only the updates you may see, and the id of an update you may not see is refused as unknown. There is no paging: to read on, pass since with the id of the last update you have, which is the cursor to prefer. since is strictly after, so with either form an update made in the same millisecond as the mark is left out. A thread over 5000 updates is cut and the result says so (threadNote): use since.',
    scope: 'boards:read',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The task id, or a link to the task copied from the app.' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Most updates to return, 1 to 200. Keeps the oldest updates, or the newest when order is "oldest". Default is 5 with order "newest".' },
        order: { type: 'string', enum: ['oldest', 'newest'], description: 'Order of the updates: "oldest" first or "newest" first (the default).' },
        since: { type: 'string', description: 'Only updates strictly after this: a full ISO 8601 time with a zone, such as 2026-11-02T10:00:00Z, or the id of an update on this task you can see. An update in the same millisecond is left out.' },
        prefix: { type: 'string', description: 'Only updates whose body starts with this text, ignoring case, such as NITPICKER: or QUESTION.' }
      },
      required: ['id']
    },
    async handler(args, context) {
      const thread = readThreadOptions(args)
      const { task, board } = await findTask(requireString(args, 'id'), context)
      return taskDetail(task, board, context, thread)
    }
  },
  {
    name: 'search_tasks',
    title: 'Search tasks',
    description: 'Search tasks across every board by text and labels. All words in the query must appear in the title or description. Results carry an excerpt around the match — follow up with get_task to read one in full. Narrow to one board or column when you know it.',
    scope: 'boards:read',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to search for. An empty string matches every task.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Only return tasks carrying all of these labels.' },
        board: { type: 'string', description: 'Restrict the search to one board (id or name).' },
        column: { type: 'string', description: 'Restrict the search to one column name, e.g. "Done". Requires "board".' },
        detail: { type: 'string', description: '"titles", "summary" (default, an excerpt around the match) or "full" for whole descriptions.' },
        limit: { type: 'number', description: 'Maximum tasks to return (default 25, max 100).' }
      },
      required: ['query']
    },
    async handler(args, context) {
      const query = optionalString(args, 'query') ?? ''
      const labels = normalizeLabels(optionalStringArray(args, 'labels') ?? [])
      const boardRef = optionalString(args, 'board')
      const columnRef = optionalString(args, 'column')
      const limit = optionalLimit(args, 'limit', 25, 100)
      const detail = readDetail(args)
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean)

      if (columnRef && !boardRef) {
        throw new McpToolError('Pass "board" as well when filtering by "column" — column names repeat across boards.')
      }

      const boards = boardRef
        ? [await findBoard(boardRef, context)]
        : await accessibleBoards(context)
      if (!boards.length) return { total: 0, tasks: [] }

      const boardsById = new Map(boards.map(board => [board.id, board]))
      const columns = await db
        .select()
        .from(projectColumns)
        .where(and(
          inArray(projectColumns.projectId, [...boardsById.keys()]),
          isNull(projectColumns.deletedAt)
        ))
      const columnsById = new Map(columns.map(column => [column.id, column]))

      const targetColumn = columnRef ? await findColumn(boards[0]!, columnRef) : null

      const rows = await db
        .select()
        .from(projectTasks)
        .where(and(
          readableTasksIn(context, boards),
          // Subtasks are reached through their card, not listed as cards of their own.
          isNull(projectTasks.parentTaskId),
          isNull(projectTasks.deletedAt)
        ))
        .orderBy(asc(projectTasks.position))

      const matches = rows.filter((task) => {
        if (targetColumn && task.columnId !== targetColumn.id) return false
        if (!labels.every(label => task.tags.includes(label))) return false
        if (!terms.length) return true
        const haystack = `${task.title} ${htmlToPlainText(task.description)}`.toLowerCase()
        return terms.every(term => haystack.includes(term))
      })

      return {
        total: matches.length,
        tasks: matches.slice(0, limit).map(task => taskCard(task, {
          detail,
          terms,
          board: boardsById.get(task.projectId)?.name ?? task.projectId,
          column: columnsById.get(task.columnId)?.name ?? task.columnId
        }))
      }
    }
  },
  {
    name: 'list_task_labels',
    title: 'List task labels',
    description: 'List the labels used on tasks with how many tasks carry each. Use it to match the user\'s existing labels instead of inventing near-duplicates.',
    scope: 'boards:read',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        board: { type: 'string', description: 'Only count labels on this board (id or name). Omit for the whole workspace.' }
      }
    },
    async handler(args, context) {
      const boardRef = optionalString(args, 'board')
      const boards = boardRef ? [await findBoard(boardRef, context)] : await accessibleBoards(context)
      if (!boards.length) return { labels: [] }

      const rows = await db
        .select({ tags: projectTasks.tags })
        .from(projectTasks)
        .where(and(
          readableTasksIn(context, boards),
          isNull(projectTasks.deletedAt)
        ))

      const counts = new Map<string, number>()
      for (const row of rows) {
        for (const label of row.tags) counts.set(label, (counts.get(label) ?? 0) + 1)
      }

      return {
        labels: [...counts.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([label, count]) => ({ label, count }))
      }
    }
  },
  {
    name: 'create_board',
    title: 'Create a board',
    description: 'Create a kanban board. It starts with the columns Backlog, To do, Verify and Done unless you pass your own.',
    scope: 'boards:write',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Board name.' },
        columns: { type: 'array', items: { type: 'string' }, description: 'Column names, left to right. Defaults to Backlog, To do, Verify, Done.' },
        description: { type: 'string', description: 'What the project is for, shown on its Overview.' },
        status: { type: 'string', description: `Project health: ${PROJECT_STATUSES.join(', ')}.` }
      },
      required: ['name']
    },
    async handler(args, context) {
      const name = requireString(args, 'name').trim()
      const requested = (optionalStringArray(args, 'columns') ?? [])
        .map(columnName => columnName.trim())
        .filter(Boolean)
      const columnNames = requested.length ? requested : DEFAULT_COLUMN_NAMES
      const description = optionalString(args, 'description')
      const status = optionalString(args, 'status')
      const now = Date.now()
      const id = newId()

      const [board] = await db.insert(projects).values({
        id,
        userId: context.userId,
        teamId: context.teamId,
        name,
        ...(description !== undefined ? { description: description.slice(0, MAX_PROJECT_DESCRIPTION) } : {}),
        ...(status !== undefined ? { status: asToolError(() => parseProjectStatus(status)) } : {}),
        createdAt: now,
        updatedAt: now
      }).returning()

      await db.insert(projectColumns).values(
        columnNames.map((columnName, index) => ({
          id: newId(),
          projectId: id,
          name: columnName,
          position: index * 1000,
          createdAt: now
        }))
      )

      return { ...boardSummary(board!, columnNames.length, 0), columnNames }
    }
  },
  {
    name: 'update_board',
    title: 'Update a board',
    description: 'Rename a board, or change its description or health status. Only the fields you pass change.',
    scope: 'boards:write',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        board: { type: 'string', description: 'Board id or current name.' },
        name: { type: 'string', description: 'New board name.' },
        description: { type: 'string', description: 'Complete replacement description, shown on the board\'s Overview. Pass an empty string to clear it.' },
        status: { type: 'string', description: `Project health: ${PROJECT_STATUSES.join(', ')}. Pass an empty string to clear it.` }
      },
      required: ['board']
    },
    async handler(args, context) {
      const board = await findStaffBoard(requireString(args, 'board'), context, 'changing the board')
      const name = optionalString(args, 'name')?.trim()
      const description = optionalString(args, 'description')
      const status = optionalString(args, 'status')

      if (!name && description === undefined && status === undefined) {
        throw new McpToolError('Pass at least one of "name", "description" or "status".')
      }

      const [updated] = await db
        .update(projects)
        .set({
          ...(name ? { name } : {}),
          ...(description !== undefined ? { description: description.slice(0, MAX_PROJECT_DESCRIPTION) } : {}),
          ...(status !== undefined ? { status: asToolError(() => parseProjectStatus(status)) } : {}),
          updatedAt: Date.now()
        })
        .where(eq(projects.id, board.id))
        .returning()

      return {
        updated: true,
        id: updated!.id,
        name: updated!.name,
        ...(name && name !== board.name ? { renamedFrom: board.name } : {}),
        ...(updated!.status ? { status: updated!.status } : {})
      }
    }
  },
  // There is deliberately no delete_board tool. A board is the one thing here
  // whose loss an agent cannot undo — its columns, tasks and updates go with it
  // — and no agent workflow needs to destroy one. Deleting a board stays in the
  // app, behind a confirmation, in front of the person who owns it.
  {
    name: 'create_column',
    title: 'Add a column',
    description: 'Add a column to a board. It goes on the right unless you name the column it should follow.',
    scope: 'boards:write',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        board: { type: 'string', description: 'Board id or name.' },
        name: { type: 'string', description: 'Column name.' },
        after: { type: 'string', description: 'Place the new column directly after this one (id or name).' }
      },
      required: ['board', 'name']
    },
    async handler(args, context) {
      const board = await findStaffBoard(requireString(args, 'board'), context, 'adding a column')
      const name = requireString(args, 'name').trim()
      const afterRef = optionalString(args, 'after')
      const after = afterRef?.trim() ? await findColumn(board, afterRef) : undefined

      const [column] = await db.insert(projectColumns).values({
        id: newId(),
        projectId: board.id,
        name,
        position: await columnPosition(board.id, columnSpot(afterRef, after?.id)),
        createdAt: Date.now()
      }).returning()

      await touchBoard(board.id)
      const columns = await projectColumnsOrdered(board.id)
      return {
        created: true,
        board: { id: board.id, name: board.name },
        column: { id: column!.id, name: column!.name },
        columnOrder: columns.map(c => c.name)
      }
    }
  },
  {
    name: 'update_column',
    title: 'Rename, recolour or move a column',
    description: 'Rename a column, give it a colour, move it to another place on the board, or any combination. Renaming keeps every task in it.',
    scope: 'boards:write',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        board: { type: 'string', description: 'Board id or name.' },
        column: { type: 'string', description: 'Column id or current name.' },
        name: { type: 'string', description: 'New column name.' },
        color: { type: 'string', description: `The colour of the column's dot on the board — one of: ${ACCENT_COLORS.join(', ')}. Pass an empty string to go back to the colour derived from the column's name.` },
        after: { type: 'string', description: 'Move the column to directly after this one (id or name). Pass an empty string to move it to the far left.' }
      },
      required: ['board', 'column']
    },
    async handler(args, context) {
      const board = await findStaffBoard(requireString(args, 'board'), context, 'changing a column')
      const column = await findColumn(board, requireString(args, 'column'))
      const name = optionalString(args, 'name')?.trim()
      const colorRef = optionalString(args, 'color')?.trim().toLowerCase()
      const afterRef = optionalString(args, 'after')

      if (!name && colorRef === undefined && afterRef === undefined) {
        throw new McpToolError('Pass "name" to rename the column, "color" to recolour it, "after" to move it, or any combination.')
      }

      const patch: { name?: string, color?: string | null, position?: number } = {}
      if (name) patch.name = name
      if (colorRef !== undefined) {
        if (colorRef && !isAccentColor(colorRef)) {
          throw new McpToolError(`"${colorRef}" is not a colour here. Pick one of: ${ACCENT_COLORS.join(', ')}.`)
        }
        patch.color = colorRef || null
      }
      if (afterRef !== undefined) {
        const after = afterRef.trim() ? await findColumn(board, afterRef) : undefined
        patch.position = await columnPosition(board.id, columnSpot(afterRef, after?.id), column.id)
      }

      const [updated] = await db
        .update(projectColumns)
        .set(patch)
        .where(eq(projectColumns.id, column.id))
        .returning()

      await touchBoard(board.id)
      const columns = await projectColumnsOrdered(board.id)
      return {
        updated: true,
        board: { id: board.id, name: board.name },
        column: { id: updated!.id, name: updated!.name, ...(updated!.color ? { color: updated!.color } : {}) },
        columnOrder: columns.map(c => c.name)
      }
    }
  },
  {
    name: 'delete_column',
    title: 'Trash a column',
    description: 'Move a column to the board\'s trash. Its tasks are not lost: they move to the column on its left, or to the one on its right when it was the first; the only column of a board takes its tasks into the trash with it. Reversible with restore_column, and the user can restore it from the board.',
    scope: 'boards:write',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        board: { type: 'string', description: 'Board id or name.' },
        column: { type: 'string', description: 'Column id or name.' }
      },
      required: ['board', 'column']
    },
    async handler(args, context) {
      const board = await findStaffBoard(requireString(args, 'board'), context, 'deleting a column')
      const column = await findColumn(board, requireString(args, 'column'))

      const columns = await projectColumnsOrdered(board.id)
      const index = columns.findIndex(candidate => candidate.id === column.id)
      const target = columns[index > 0 ? index - 1 : index + 1]
      const affected = (await columnTasksOrdered(column.id)).length
      const stamp = agentDeletion(context)

      // The cards below are changed in bulk: the tasks unfinished before are read first, so the news can be sent (GH #36).
      const unfinished = await unfinishedTasksOn(board, column.id)
      if (target) {
        // Where they came from is recorded, so restore_column brings them home
        // rather than handing back an empty column.
        await db.update(projectTasks)
          .set({ columnId: target.id, previousColumnId: column.id })
          .where(and(eq(projectTasks.columnId, column.id), isNull(projectTasks.deletedAt)))
        // The moved tasks carry the old column's positions, which collide with
        // the ones already there; a renumber gives the merged column one order.
        await renumberColumnTasks(target.id)
      } else {
        // No neighbour to hand them to, so they go to the trash alongside the
        // column, carrying its exact timestamp — that is how restore_column
        // later tells them from cards trashed on their own.
        await db.update(projectTasks)
          .set(stamp)
          .where(and(eq(projectTasks.columnId, column.id), isNull(projectTasks.deletedAt)))
      }

      await db.update(projectColumns).set(stamp).where(eq(projectColumns.id, column.id))
      await tellUnblockedAfterBulk(board, unfinished, context.userId)
      await touchBoard(board.id)

      return {
        trashed: true,
        board: { id: board.id, name: board.name },
        column: { id: column.id, name: column.name },
        restoreWith: 'restore_column',
        ...(target
          ? { tasksMovedTo: target.name, tasksMoved: affected }
          : { tasksTrashed: affected })
      }
    }
  },
  {
    name: 'restore_column',
    title: 'Restore a column',
    description: 'Bring a column back out of the board\'s trash, along with the tasks that went with it. Use this to undo a delete_column — yours or anyone else\'s — while it is still in the trash.',
    scope: 'boards:write',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The column id, as returned by delete_column.' }
      },
      required: ['id']
    },
    async handler(args, context) {
      const id = requireString(args, 'id')
      const [column] = await db.select().from(projectColumns).where(eq(projectColumns.id, id))
      if (!column) throw new McpToolError(`No column with id "${id}" exists. It may have been removed for good.`)

      const board = await findStaffBoard(column.projectId, context, 'restoring a column')
      if (!column.deletedAt) return { id, alreadyActive: true, column: column.name }

      const withColumn = await db
        .update(projectTasks)
        .set(RESTORED)
        .where(and(eq(projectTasks.columnId, id), eq(projectTasks.deletedAt, column.deletedAt)))
        .returning({ id: projectTasks.id })

      // Tasks handed to a neighbour on the way out, unless they have since been
      // filed somewhere on purpose — moving a task clears the marker.
      const relocated = await db
        .update(projectTasks)
        .set({ columnId: id, previousColumnId: null })
        .where(and(eq(projectTasks.previousColumnId, id), isNull(projectTasks.deletedAt)))
        .returning({ id: projectTasks.id })

      await db.update(projectColumns).set(RESTORED).where(eq(projectColumns.id, id))
      await renumberColumnTasks(id)
      await touchBoard(board.id)

      return {
        restored: true,
        board: { id: board.id, name: board.name },
        column: { id: column.id, name: column.name },
        tasksRestored: withColumn.length + relocated.length
      }
    }
  },
  {
    name: 'create_task',
    title: 'Create a task',
    description: 'Create a task in a column. The description is Markdown and labels are the board\'s task labels (priority, workstream, …). New tasks go to the bottom of the column unless told otherwise. Pass "parent" to make a subtask of a card instead; it is kept in that card\'s panel, not on the board. Pass blockedBy to make the new task wait for tasks on the same board.',
    scope: 'boards:write',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        board: { type: 'string', description: 'Board id or name. Required unless parent is given.' },
        column: { type: 'string', description: 'Column id or name, e.g. "Backlog". Required unless parent is given; a subtask takes its parent\'s column.' },
        title: { type: 'string', description: 'Task title. Keep it short — detail belongs in the description.' },
        description: { type: 'string', description: 'Markdown description. Supports headings, lists, "- [ ]" checklists, tables and fenced code. A ```mermaid block is drawn as a diagram; a ```chart block is drawn as a bar, line or pie chart from lines like "type: bar", "labels: Jan, Feb" and "Sales: 12, 19".' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Labels for the task, without the # prefix.' },
        position: { type: 'string', description: '"top" or "bottom" of the column. Defaults to "bottom".' },
        after: { type: 'string', description: 'Place the task directly after this task id instead.' },
        parent: { type: 'string', description: 'The id, or a link, of a card to make this a subtask of. A subtask lives in its parent\'s panel: it takes the parent\'s board, column and visibility and goes to the bottom of the parent\'s subtasks.' },
        blockedBy: { type: 'array', items: { type: 'string' }, description: 'Ids, or links, of tasks on this board that the new task waits for. It is blocked while any of them is open. Team only.' },
        ...TASK_FIELD_PROPERTIES
      },
      required: ['title']
    },
    async handler(args, context) {
      // A subtask is made under a parent card: it takes that card's board and column and sits in its panel.
      const parentRef = optionalString(args, 'parent')?.trim()
      const parent = parentRef
        ? await findTask(parentRef, context).catch((error: unknown) => {
            // Missing, trashed and on a board the key cannot open read alike, so the answer does not show that the task exists.
            if (error instanceof McpToolError) {
              throw new McpToolError(`No task "${idFromReference(parentRef, 'task')}" you can open. It may be missing, in a board's trash, or on a board you cannot open.`)
            }
            throw error
          })
        : null
      if (parent) requireStaffAudience(context, parent.board, 'making a subtask')
      const board = parent ? parent.board : await findBoard(requireString(args, 'board'), context)
      const boardRef = optionalString(args, 'board')
      if (parent && boardRef !== undefined && (await findBoard(boardRef, context)).id !== board.id) {
        throw new McpToolError('The parent task is not on that board: it is on ' + board.name + '.')
      }
      // A customer's contact files a request; dates, assignee, the done mark and
      // custom fields are the team's to set, as they are in the app.
      if (audienceOf(context, board) === 'customer') {
        const planning = ['dueOn', 'startOn', 'assignee', 'completed', 'fields', 'blockedBy'].filter(key => args[key] !== undefined)
        if (planning.length) {
          throw new McpToolError(`You work on "${board.name}" as a customer, so you can file a task but not set its ${planning.join(', ')}: that is for the team.`)
        }
      }
      // A subtask sits in its parent's column, so a column named with one must be that column.
      const columnRef = optionalString(args, 'column')
      const column = await findColumn(board, parent ? parent.task.columnId : requireString(args, 'column'))
      if (parent && columnRef !== undefined && (await findColumn(board, columnRef)).id !== column.id) {
        throw new McpToolError('A subtask takes its parent\'s column: ' + column.name + '.')
      }
      const title = requireString(args, 'title').trim()
      const markdown = optionalString(args, 'description') ?? ''
      const labels = normalizeLabels(optionalStringArray(args, 'labels') ?? [])
      const fields = await readTaskFields(args, board)
      // Checked before the task exists, so a bad value does not leave a half-made one.
      const fieldMap = readFieldMap(args)
      const fieldDefs = fieldMap ? await listFields(board.id) : []
      if (fieldMap) asToolError(() => checkFieldValues(fieldDefs, fieldMap))
      const blockers = await blockerIdsOn(args, 'blockedBy', board, context)
      const now = Date.now()

      const actor: Actor = { userId: context.userId, audience: audienceOf(context, board), via: 'mcp' }
      // The task and its blocked-by links are one write: a refused link leaves no task behind.
      const [task] = await db.transaction(async (tx) => {
        const created = await tx.insert(projectTasks).values({
          id: newId(),
          projectId: board.id,
          columnId: column.id,
          title,
          description: markdown ? markdownToHtml(markdown) : '',
          tags: labels,
          ...fields,
          ...(parent ? { parentTaskId: parent.task.id, visibility: parent.task.visibility } : {}),
          createdBy: context.userId,
          position: parent ? await nextSubtaskPosition(parent.task.id) : await taskPosition(column.id, readPlacement(args), optionalString(args, 'after')),
          createdAt: now,
          updatedAt: now
        }).returning()
        await changeBlockers(tx, board, created[0]!.id, actor, blockers, [])
        return created
      })

      await logActivity(task!, context.userId, [{ kind: 'created' }], 'mcp')
      announceTaskCreated(board, task!, context.userId, 'agent')
      if (task!.assigneeId) await notifyAssigned(board, task!, context.userId, task!.assigneeId)
      const storedValues = fieldMap ? await asToolErrorAsync(() => setFieldValues(task!.id, fieldDefs, fieldMap)) : undefined
      await touchBoard(board.id)
      // Rules hear about the saved task, as they do from the app. A failure there never fails this call.
      await fireRules({ type: 'task_added', projectId: board.id, taskId: task!.id, actorId: context.userId, actorIsAgent: true, detail: null }, newRuleChain()).catch(() => {})
      // The caller wrote the description; echoing it back with an empty update
      // thread teaches it nothing. The ids and the card are the useful receipt.
      return {
        created: true,
        board: { id: board.id, name: board.name },
        task: taskCard(task!, { column: column.name, parent: parent?.task.id, people: await peopleNames(board), fields: describeFieldValues(fieldDefs, storedValues), blocked: await blockedFor(task!.id, audienceOf(context, board)) })
      }
    }
  },
  {
    name: 'update_task',
    title: 'Update a task',
    description: 'Update a task\'s title, description, labels, dates, assignee or done mark. Only the fields you pass change, and each replaces its value entirely — read the task first when editing part of a description. Use move_task to change its column. Use blockedBy and unblockedBy to add or remove the tasks this one waits for, by id or link, on the same board.',
    scope: 'boards:write',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The task id.' },
        title: { type: 'string', description: 'New title.' },
        description: { type: 'string', description: 'Complete replacement Markdown description.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Complete replacement label list, without the # prefix. Pass an empty array to clear them.' },
        blockedBy: { type: 'array', items: { type: 'string' }, description: 'Ids, or links, of tasks on this board that this task now waits for. Team only.' },
        unblockedBy: { type: 'array', items: { type: 'string' }, description: 'Ids, or links, of tasks this task no longer waits for. Team only.' },
        ...TASK_FIELD_PROPERTIES
      },
      required: ['id']
    },
    async handler(args, context) {
      const { task, board } = await findTask(requireString(args, 'id'), context, { staff: 'changing tasks' })
      const title = optionalString(args, 'title')?.trim()
      const markdown = optionalString(args, 'description')
      const labels = optionalStringArray(args, 'labels')
      const fields = await readTaskFields(args, board, task)
      const fieldMap = readFieldMap(args)

      const linked = args.blockedBy !== undefined || args.unblockedBy !== undefined
      if (title === undefined && markdown === undefined && labels === undefined && !Object.keys(fields).length && !fieldMap && !linked) {
        throw new McpToolError('Pass at least one of "title", "description", "labels", "dueOn", "startOn", "assignee", "completed", "fields", "blockedBy" or "unblockedBy".')
      }
      // Checked before anything is saved, so a bad value changes nothing.
      const fieldDefs = fieldMap ? await listFields(board.id) : []
      if (fieldMap) asToolError(() => checkFieldValues(fieldDefs, fieldMap))
      // The links and the save are one write: a refused link leaves the task as it was.
      const adds = await blockerIdsOn(args, 'blockedBy', board, context)
      const removes = await blockerIdsOn(args, 'unblockedBy', board, context, { deleted: true })
      const actor: Actor = { userId: context.userId, audience: audienceOf(context, board), via: 'mcp' }
      const [updated] = await db.transaction(async (tx) => {
        await changeBlockers(tx, board, task.id, actor, adds, removes)
        return await tx
          .update(projectTasks)
          .set({
            ...(title ? { title } : {}),
            ...(markdown !== undefined ? { description: markdown ? markdownToHtml(markdown) : '' } : {}),
            ...(labels !== undefined ? { tags: normalizeLabels(labels) } : {}),
            ...fields,
            updatedAt: Date.now()
          })
          .where(eq(projectTasks.id, task.id))
          .returning()
      })

      const entries = await changesToTask(task, { ...fields, ...(title ? { title } : {}) })
      await logActivity(task, context.userId, entries, 'mcp')
      await notifyTaskChange(board, updated!, context.userId, inboxBriefs(entries))
      if (fields.assigneeId && fields.assigneeId !== task.assigneeId) await notifyAssigned(board, updated!, context.userId, fields.assigneeId)
      if (fieldMap) await asToolErrorAsync(() => setFieldValues(task.id, fieldDefs, fieldMap))
      // Rules hear about each change the update made, as they do from the app.
      const changes: { type: TriggerKind, detail: string | null }[] = []
      if (fields.completedAt !== undefined && !!fields.completedAt !== !!task.completedAt) {
        changes.push({ type: fields.completedAt ? 'task_completed' : 'task_reopened', detail: null })
      }
      if (fields.assigneeId && fields.assigneeId !== task.assigneeId) changes.push({ type: 'task_assigned', detail: fields.assigneeId })
      if (fields.dueOn && fields.dueOn !== task.dueOn) changes.push({ type: 'due_set', detail: null })
      for (const change of changes) {
        await fireRules({ ...change, projectId: board.id, taskId: task.id, actorId: context.userId, actorIsAgent: true }, newRuleChain()).catch(() => {})
      }

      const column = await findColumn(board, task.columnId)
      await touchBoard(board.id)
      return {
        updated: true,
        board: { id: board.id, name: board.name },
        task: taskCard(updated!, { column: column.name, people: await peopleNames(board), fields: (await describedFields(board, updated!)).fields, blocked: await blockedFor(updated!.id, audienceOf(context, board)) })
      }
    }
  },
  {
    name: 'move_task',
    title: 'Move a task',
    description: 'Move a task to another column of its board — this is how a task is marked done — or reorder it inside the column it is already in.',
    scope: 'boards:write',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The task id.' },
        column: { type: 'string', description: 'Target column id or name. Omit to reorder within the current column.' },
        position: { type: 'string', description: '"top" or "bottom" of the target column. Defaults to "bottom".' },
        after: { type: 'string', description: 'Place the task directly after this task id in the target column instead.' }
      },
      required: ['id']
    },
    async handler(args, context) {
      const { task, board } = await findTask(requireString(args, 'id'), context, { staff: 'moving tasks' })
      // A subtask moves with its parent, as the app's route has it; finishing one is update_task completed.
      if (task.parentTaskId) {
        throw new McpToolError('A subtask moves with its parent. To finish it, use update_task with completed: true.')
      }
      const columnRef = optionalString(args, 'column')
      const from = await findColumn(board, task.columnId)
      const column = columnRef ? await findColumn(board, columnRef) : from

      const [updated] = await db
        .update(projectTasks)
        .set({
          columnId: column.id,
          // Filing a card somewhere deliberately overrides where it came from,
          // so restoring its old column later leaves this one where it is.
          previousColumnId: null,
          position: await taskPosition(column.id, readPlacement(args), optionalString(args, 'after'), task.id),
          updatedAt: Date.now()
        })
        .where(eq(projectTasks.id, task.id))
        .returning()

      await touchBoard(board.id)
      if (column.id !== from.id) {
        const entries = await changesToTask(task, { columnId: column.id })
        await logActivity(task, context.userId, entries, 'mcp')
        await notifyTaskChange(board, updated!, context.userId, inboxBriefs(entries))
      }
      // Rules hear about a card that changed column, as they do from the app.
      if (column.id !== from.id) {
        await fireRules({ type: 'task_moved', projectId: board.id, taskId: task.id, actorId: context.userId, actorIsAgent: true, detail: column.id }, newRuleChain()).catch(() => {})
      }
      // `board` sits at the top level because the MCP endpoint reads it to tell
      // the open browsers which board changed — without it a move only raises
      // the coarse signal, and the readers of a shared board see nothing at all.
      return {
        moved: true,
        board: { id: board.id, name: board.name },
        from: from.name,
        to: column.name,
        task: taskCard(updated!, { column: column.name })
      }
    }
  },
  {
    name: 'delete_task',
    title: 'Trash a task',
    description: 'Move a task to the board\'s trash, where restore_task or the user can bring it back. Nothing is permanently deleted, but the trash is emptied after 7 days — and moving a finished task to a "Done" column with move_task is usually what the user actually wants.',
    scope: 'boards:write',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The task id.' }
      },
      required: ['id']
    },
    async handler(args, context) {
      const { task, board } = await findTask(requireString(args, 'id'), context, { staff: 'deleting tasks' })
      await db.update(projectTasks).set(agentDeletion(context)).where(eq(projectTasks.id, task.id))
      // Trashing the last open blocker of a task counts as finishing it (GH #36 slice 5).
      await tellUnblockedOnTrash(board, task.id, context.userId)
      await touchBoard(board.id)
      return {
        trashed: true,
        id: task.id,
        title: task.title,
        board: { id: board.id, name: board.name },
        restoreWith: 'restore_task'
      }
    }
  },
  {
    name: 'restore_task',
    title: 'Restore a task',
    description: 'Bring a task back out of the board\'s trash, into the column it was in. Use this to undo a delete_task while it is still in the trash.',
    scope: 'boards:write',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The task id.' }
      },
      required: ['id']
    },
    async handler(args, context) {
      const { task, board } = await findTask(requireString(args, 'id'), context, { includeDeleted: true, staff: 'restoring tasks' })
      if (!task.deletedAt) return { id: task.id, alreadyActive: true, title: task.title }

      const [column] = await db.select().from(projectColumns).where(eq(projectColumns.id, task.columnId))
      let columnId = task.columnId

      if (column?.deletedAt) {
        // Its column is in the trash too; the card needs it back to be drawn at
        // all. The column's other trashed cards stay where they are.
        await db.update(projectColumns).set(RESTORED).where(eq(projectColumns.id, column.id))
      } else if (!column) {
        const [first] = await projectColumnsOrdered(board.id)
        if (!first) throw new McpToolError(`Board "${board.name}" has no column to restore this task into.`)
        columnId = first.id
      }

      await db
        .update(projectTasks)
        .set({ ...RESTORED, columnId, updatedAt: Date.now() })
        .where(eq(projectTasks.id, task.id))
      await renumberColumnTasks(columnId)
      await touchBoard(board.id)

      const [restored] = await db.select().from(projectColumns).where(eq(projectColumns.id, columnId))
      return {
        restored: true,
        id: task.id,
        title: task.title,
        board: { id: board.id, name: board.name },
        column: restored?.name ?? columnId
      }
    }
  },
  ...DELIVERY_TOOLS
]
