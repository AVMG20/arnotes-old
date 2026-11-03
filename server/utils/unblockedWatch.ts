// The "unblocked" news (GH #36, slice 5): when the last open blocker of a task finishes, the task's
// assignee gets an Inbox note and an agent event, and the crew's pm gets the agent event. Nothing moves
// by itself. Blocked-ness is derived (taskDependencyService), so a dependent is told only when it was
// blocked before this change and is not blocked now: the blocker is the one that just finished.
// Called once per real change: from notifyTaskChange (moves, completion) and from the two trash paths.
// Pure parts first (tested on their own); the database part reads the board and sends.
import { and, desc, eq, isNull } from 'drizzle-orm'
import { db } from '../db'
import { projectColumns, projectTasks, taskActivity, taskDependencies, user } from '../db/schema'
import { terminalColumnIds } from '../../shared/utils/board'
import { notify } from './notifications'
import { createMoveCoalescer } from './moveWatch'
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

/** Who hears of an unblocked task: its assignee and the crew's pm, once each, never the person who made the change. */
export function unblockedRecipients(assigneeId: string | null | undefined, actorId: string | null, pmIds: string[]): string[] {
  const all = [assigneeId, ...pmIds].filter((id): id is string => !!id && id !== actorId)
  return [...new Set(all)]
}

type BoardRef = { id: string, name: string, userId: string, teamId: string | null, customerId: string | null }
type TaskRef = { id: string, title: string, visibility: 'internal' | 'customer', assigneeId?: string | null, createdBy?: string | null }

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
    if (unfinishedBefore) await unblockedBy(board, row, actorId)
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
    if (unfinishedBefore) await unblockedBy(board, row, actorId)
  })
}

// The live dependents of a blocker that just finished, and the ones it no longer holds back.
async function unblockedBy(board: BoardRef, blocker: { id: string, title: string, visibility: 'internal' | 'customer' }, actorId: string | null): Promise<void> {
  const dependents: TaskRef[] = await db
    .select({ id: projectTasks.id, title: projectTasks.title, visibility: projectTasks.visibility, assigneeId: projectTasks.assigneeId, createdBy: projectTasks.createdBy })
    .from(taskDependencies)
    .innerJoin(projectTasks, eq(projectTasks.id, taskDependencies.blockedTaskId))
    .where(and(eq(taskDependencies.blockerTaskId, blocker.id), eq(projectTasks.projectId, board.id), isNull(projectTasks.deletedAt)))
  if (!dependents.length) return

  const states = await blockedStatesOn(board.id, dependents.map(task => task.id))
  const freed = new Set(unblockedIds(dependents.map(task => task.id), states))
  // One dependent once per call, however many of its blockers this call names.
  const tasks = [...new Map(dependents.filter(task => freed.has(task.id)).map(task => [task.id, task])).values()]
  if (!tasks.length) return

  const from = await nameOf(actorId)
  const crew = board.teamId ? await githubDatabaseLookups.crewPeople(board.teamId) : []
  const pm = crew.filter(person => person.key === 'pm').map(person => person.userId)
  // The Inbox note names the blocker only when a customer may read it; otherwise it stays vague.
  const body = blocker.visibility === 'customer' ? `"${blocker.title}" is finished.` : 'A task it waited for is finished.'
  for (const task of tasks) {
    if (task.assigneeId) {
      await notify({ project: board, task, actorId, type: 'update', recipients: [task.assigneeId], title: `"${task.title}" is unblocked`, body })
    }
    const customerVisible = task.visibility === 'customer'
    for (const recipient of unblockedRecipients(task.assigneeId, actorId, pm)) {
      unblockCoalescer.offer(`${board.id}|${recipient}|${customerVisible ? 'customer' : 'internal'}`, { recipient, board, task, from, customerVisible })
    }
  }
}
