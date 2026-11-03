// The "unblocked" news (GH #36, slice 5): when the last open blocker of a task finishes, the task's
// assignee gets an Inbox note and an agent event, and the crew's pm gets the agent event. Nothing moves
// by itself. Blocked-ness is derived (taskDependencyService), so a dependent is told only when it was
// blocked before this change and is not blocked now: the blocker is the one that just finished.
// Called once per real change: from notifyTaskChange (moves, completion) and from the two trash paths and the bulk column paths (tellUnblockedAfterBulk).
// Pure parts first (tested on their own); the database part reads the board and sends.
// The Inbox notes wait for a short window to close so a burst becomes one note: the windows live in this process,
// so a note whose window is still open when the server stops is not sent (the agent events are in memory too and are not replayed).
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '../db'
import { projectColumns, projectTasks, taskActivity, taskDependencies, user } from '../db/schema'
import { terminalColumnIds } from '../../shared/utils/board'
import { notify } from './notifications'
import { createMoveCoalescer, MOVE_WINDOW_MS } from './moveWatch'
import { blockedStatesOn, isFinishedTask } from './taskDependencyService'
import { emitAgentEventAsync, emitInBackground, githubDatabaseLookups } from './agentEvents'

// The brief the task's log writes for a completion or a reopen (taskActivity.briefOf); a move starts "Moved to ".
export const MARKED_DONE = 'Marked done'
export const REOPENED = 'Reopened'
const MOVED_TO = 'Moved to '

/**
 * Whether a save took the task from unfinished to finished. `changes` are the briefs the save logged;
 * `completedNow` and `columnNowFinished` describe the task after the save. A move needs the finished-ness
 * of the column it came from, and null when that cannot be read: then nothing is told, so nothing is told twice.
 */
export function wasUnfinished(input: {
  changes: readonly string[]
  completedNow: boolean
  columnNowFinished: boolean
  movedFromFinished: boolean | null
}): boolean {
  const moved = input.changes.some(change => change.startsWith(MOVED_TO))
  if (moved && input.movedFromFinished === null) return false
  const completedBefore = input.changes.includes(MARKED_DONE)
    ? false
    : input.changes.includes(REOPENED) ? true : input.completedNow
  const columnBefore = moved ? input.movedFromFinished === true : input.columnNowFinished
  return !completedBefore && !columnBefore
}

/** The dependents that are no longer blocked. Each was blocked before, because the finished blocker was open then. */
export function unblockedIds(taskIds: readonly string[], blockedNow: ReadonlyMap<string, { blocked: boolean }>): string[] {
  // A state that was not read counts as unknown, so nobody is told on a gap.
  return taskIds.filter((id) => {
    const state = blockedNow.get(id)
    return !!state && !state.blocked
  })
}

/**
 * Holds the notes of one window per key: the first is kept and the rest are counted, and the window's note is sent
 * when the window closes. Window state is held only while a window is open, as in createMoveCoalescer.
 */
export function createNoteCoalescer<T>(options: {
  /** Called with the first payload of the window and how many more it stands for. */
  send: (first: T, more: number) => void
  windowMs?: number
  /** Runs `fn` after `ms`. Defaults to an unref'd timer, so an open window never keeps the process alive. */
  schedule?: (fn: () => void, ms: number) => void
}) {
  const windowMs = options.windowMs ?? MOVE_WINDOW_MS
  const schedule = options.schedule ?? ((fn: () => void, ms: number) => {
    const timer = setTimeout(fn, ms)
    timer.unref?.()
  })
  const open = new Map<string, { first: T, more: number }>()

  return {
    /** Offers a note. Only the window's own timer closes it, so a later window for the same key starts after it. */
    offer(key: string, payload: T): void {
      const entry = open.get(key)
      if (entry) {
        entry.more++
        return
      }
      open.set(key, { first: payload, more: 0 })
      schedule(() => {
        const closing = open.get(key)
        if (!closing) return
        open.delete(key)
        options.send(closing.first, closing.more)
      }, windowMs)
    },
    /** How many windows are open now. */
    openWindows(): number {
      return open.size
    }
  }
}

/** The tasks a bulk change left finished that were unfinished before it: the blockers it freed. */
export function freedByBulk(unfinishedBefore: readonly string[], rowsNow: readonly TaskState[], finished: ReadonlySet<string>): string[] {
  const now = new Map(rowsNow.map(row => [row.id, row]))
  return unfinishedBefore.filter((id) => {
    const row = now.get(id)
    return !!row && isFinishedTask(row, finished)
  })
}

/** Who hears of an unblocked task: its assignee and the crew's pm, once each, never the person who made the change. */
export function unblockedRecipients(assigneeId: string | null | undefined, actorId: string | null, pmIds: string[]): string[] {
  const all = [assigneeId, ...pmIds].filter((id): id is string => !!id && id !== actorId)
  return [...new Set(all)]
}

type BoardRef = { id: string, name: string, userId: string, teamId: string | null, customerId: string | null }
type TaskRef = { id: string, title: string, visibility: 'internal' | 'customer', assigneeId?: string | null, createdBy?: string | null }

// A task as a bulk change finds it: where it is and whether it is done.
type TaskState = Parameters<typeof isFinishedTask>[0] & { id: string }
// A finished blocker as it is read: its title and visibility are what the Inbox note may name.
type Blocker = { id: string, title: string, visibility: 'internal' | 'customer' }

// Several unblocks in one window for the same person are sent as one, counted, like task moves (moveWatch.ts).
type UnblockPayload = { recipient: string, board: BoardRef, task: TaskRef, from: string, customerVisible: boolean }
const unblockCoalescer = createMoveCoalescer<UnblockPayload>({
  send: (payload, more) => {
    emitInBackground(() => emitAgentEventAsync(payload.recipient, {
      kind: 'unblocked',
      board: payload.board,
      task: payload.task,
      // A summary has no single task of its own: its count goes where the task's title goes.
      from: more > 0 ? `${more} more unblocked tasks on ${payload.board.name}` : payload.from,
      customerVisible: payload.customerVisible
    }))
  }
})

// The Inbox notes of the unblocks for one assignee in one window are one note: it waits for the window to close, names
// its first task and counts the rest. The agent events above send their first at once; the note carries the count.
type NotePayload = { board: BoardRef, task: TaskRef, recipient: string, actorId: string | null, body: string }
const noteCoalescer = createNoteCoalescer<NotePayload>({
  send: (first, more) => {
    const title = more > 0 ? `"${first.task.title}" and ${more} more tasks are unblocked` : `"${first.task.title}" is unblocked`
    void notify({ project: first.board, task: first.task, actorId: first.actorId, type: 'update', recipients: [first.recipient], title, body: first.body })
      .catch(error => console.error('[unblocked] could not send the Inbox note', error))
  }
})

async function nameOf(userId: string | null): Promise<string> {
  if (!userId) return 'Someone'
  const [row] = await db.select({ name: user.name }).from(user).where(eq(user.id, userId))
  return row?.name ?? 'Someone'
}

async function finishedColumnsOf(boardId: string): Promise<{ columns: { id: string, name: string }[], finished: Set<string> }> {
  const columns = await db
    .select({ id: projectColumns.id, name: projectColumns.name })
    .from(projectColumns)
    .where(and(eq(projectColumns.projectId, boardId), isNull(projectColumns.deletedAt)))
    .orderBy(projectColumns.position)
  return { columns, finished: new Set(terminalColumnIds(columns)) }
}

/** The name of the column the task was last moved from, read from the log the save wrote just before. */
async function movedFromName(taskId: string): Promise<string | null> {
  const [row] = await db
    .select({ detail: taskActivity.detail })
    .from(taskActivity)
    .where(and(eq(taskActivity.taskId, taskId), eq(taskActivity.kind, 'moved')))
    .orderBy(desc(taskActivity.createdAt))
    .limit(1)
  return row?.detail.from ?? null
}

async function guarded(work: () => Promise<void>): Promise<void> {
  try {
    await work()
  } catch (error) {
    console.error('[unblocked] could not tell the people on a blocked task', error)
  }
}

/** A task was changed (moved, completed or reopened). Tells the people of the tasks it was the last blocker of. */
export async function tellUnblockedOnChange(board: BoardRef, taskId: string, actorId: string | null, changes: readonly string[]): Promise<void> {
  // Only a move, a completion or a reopen can finish a task: decide that before any query.
  if (!changes.some(change => change.startsWith(MOVED_TO) || change === MARKED_DONE || change === REOPENED)) return
  await guarded(async () => {
    const [row] = await db
      .select({ id: projectTasks.id, title: projectTasks.title, visibility: projectTasks.visibility, columnId: projectTasks.columnId, completedAt: projectTasks.completedAt, deletedAt: projectTasks.deletedAt })
      .from(projectTasks)
      .where(eq(projectTasks.id, taskId))
    if (!row || row.deletedAt) return
    const { columns, finished } = await finishedColumnsOf(board.id)
    if (!isFinishedTask(row, finished)) return

    const moved = changes.some(change => change.startsWith(MOVED_TO))
    const fromName = moved ? await movedFromName(taskId) : null
    const movedFromFinished = moved && fromName !== null
      ? columns.some(column => column.name === fromName && finished.has(column.id))
      : null
    const unfinishedBefore = wasUnfinished({
      changes,
      completedNow: row.completedAt !== null,
      columnNowFinished: finished.has(row.columnId),
      movedFromFinished: moved ? movedFromFinished : null
    })
    if (unfinishedBefore) await unblockedBy(board, [row], actorId)
  })
}

/** A task was moved to the trash. Trashing a task counts as finishing it (a trashed blocker does not block). */
export async function tellUnblockedOnTrash(board: BoardRef, taskId: string, actorId: string | null): Promise<void> {
  await guarded(async () => {
    const [row] = await db
      .select({ id: projectTasks.id, title: projectTasks.title, visibility: projectTasks.visibility, columnId: projectTasks.columnId, completedAt: projectTasks.completedAt, deletedAt: projectTasks.deletedAt })
      .from(projectTasks)
      .where(eq(projectTasks.id, taskId))
    if (!row || !row.deletedAt) return
    // The column is unchanged by the trash, so it says whether the task was finished before it.
    const { finished } = await finishedColumnsOf(board.id)
    const unfinishedBefore = wasUnfinished({
      changes: [],
      completedNow: row.completedAt !== null,
      columnNowFinished: finished.has(row.columnId),
      movedFromFinished: null
    })
    if (unfinishedBefore) await unblockedBy(board, [row], actorId)
  })
}

// The live dependents the finished blockers just held back, and the ones no longer held back by anything. A dependent
// is told once per call, however many of the blockers it waited for finished in this change.
async function unblockedBy(board: BoardRef, blockers: Blocker[], actorId: string | null): Promise<void> {
  if (!blockers.length) return
  const links = await db
    .select({ blockerId: taskDependencies.blockerTaskId, id: projectTasks.id, title: projectTasks.title, visibility: projectTasks.visibility, assigneeId: projectTasks.assigneeId, createdBy: projectTasks.createdBy })
    .from(taskDependencies)
    .innerJoin(projectTasks, eq(projectTasks.id, taskDependencies.blockedTaskId))
    .where(and(inArray(taskDependencies.blockerTaskId, blockers.map(blocker => blocker.id)), eq(projectTasks.projectId, board.id), isNull(projectTasks.deletedAt)))
  const byId = new Map(blockers.map(blocker => [blocker.id, blocker]))
  const waiting = new Map<string, { task: TaskRef, freedBy: Blocker[] }>()
  for (const link of links) {
    const blocker = byId.get(link.blockerId)
    if (!blocker) continue
    const entry = waiting.get(link.id) ?? { task: { id: link.id, title: link.title, visibility: link.visibility, assigneeId: link.assigneeId, createdBy: link.createdBy }, freedBy: [] }
    entry.freedBy.push(blocker)
    waiting.set(link.id, entry)
  }
  if (!waiting.size) return

  const ids = [...waiting.keys()]
  const freed = unblockedIds(ids, await blockedStatesOn(board.id, ids))
  if (!freed.length) return

  const from = await nameOf(actorId)
  const crew = board.teamId ? await githubDatabaseLookups.crewPeople(board.teamId) : []
  const pm = crew.filter(person => person.key === 'pm').map(person => person.userId)
  for (const id of freed) {
    const { task, freedBy } = waiting.get(id)!
    // The Inbox note names the blocker only when one customer-visible blocker is all the task waited for.
    const named = freedBy.length === 1 && freedBy[0]!.visibility === 'customer'
    const body = named ? `"${freedBy[0]!.title}" is finished.` : 'A task it waited for is finished.'
    if (task.assigneeId) noteCoalescer.offer(`${board.id}|${task.assigneeId}`, { board, task, recipient: task.assigneeId, actorId, body })
    const customerVisible = task.visibility === 'customer'
    for (const recipient of unblockedRecipients(task.assigneeId, actorId, pm)) {
      unblockCoalescer.offer(`${board.id}|${recipient}|${customerVisible ? 'customer' : 'internal'}`, { recipient, board, task, from, customerVisible })
    }
  }
}

/**
 * The unfinished live tasks of a column, read before a bulk change (a column delete) moves or trashes them. A read
 * that fails tells nothing, so it gives no tasks.
 */
export async function unfinishedTasksOn(board: BoardRef, columnId: string): Promise<string[]> {
  try {
    const rows = await db
      .select({ id: projectTasks.id, columnId: projectTasks.columnId, completedAt: projectTasks.completedAt, deletedAt: projectTasks.deletedAt })
      .from(projectTasks)
      .where(and(eq(projectTasks.columnId, columnId), eq(projectTasks.projectId, board.id), isNull(projectTasks.deletedAt)))
    const { finished } = await finishedColumnsOf(board.id)
    return rows.filter(row => !isFinishedTask(row, finished)).map(row => row.id)
  } catch (error) {
    console.error('[unblocked] could not read a column before it was changed', error)
    return []
  }
}

/**
 * A bulk change (a column delete, over MCP or the route) moved or trashed the tasks of a column. `unfinishedBefore` is
 * what unfinishedTasksOn read before it; the tasks the change left finished are told, once each, as for a single change.
 */
export async function tellUnblockedAfterBulk(board: BoardRef, unfinishedBefore: readonly string[], actorId: string | null): Promise<void> {
  if (!unfinishedBefore.length) return
  await guarded(async () => {
    const rows = await db
      .select({ id: projectTasks.id, title: projectTasks.title, visibility: projectTasks.visibility, columnId: projectTasks.columnId, completedAt: projectTasks.completedAt, deletedAt: projectTasks.deletedAt })
      .from(projectTasks)
      .where(inArray(projectTasks.id, [...unfinishedBefore]))
    const { finished } = await finishedColumnsOf(board.id)
    const freed = new Set(freedByBulk(unfinishedBefore, rows, finished))
    await unblockedBy(board, rows.filter(row => freed.has(row.id)), actorId)
  })
}
