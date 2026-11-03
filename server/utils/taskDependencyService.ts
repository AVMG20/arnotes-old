// The blocked-by links of one board (GH #36, slice 2): the database side that the routes
// call, and that slices 3 to 5 call too. The rules (cycles, open blockers) live in
// taskDependencies.ts; this file reads and writes the rows and says who may do it.
//
// Names and signatures, fixed for the later slices:
//   addBlocker(boardId, blockedId, blockerId, actor)     -> { ok: true, link } | BlockerRefusal
//   removeBlocker(boardId, blockedId, blockerId, actor)  -> { ok: true, blockerId } | BlockerRefusal
//   listBlockers(taskId, viewer)                         -> Blocker[]
//   blockedState(taskId)                                 -> { blocked, openBlockerIds }
// `actor` and `viewer` are { userId, audience }. Staff only may add or remove a link. A
// customer reads the blocked state; for a blocker that is not customer-visible the title reads
// "a hidden task", and its id, column and finished flag are withheld (null).
//
// "Finished" for a blocker is the same test the board's progress count uses: its column is in the
// board's ending column(s) (terminalColumnIds in shared/utils/board.ts), or it is completed. A
// per-column "finished" marker would be a separate change that moves every count at once, so
// blocked-ness and the counts always agree until then. A trashed blocker counts as finished too,
// and does not block; restoring it blocks again, because nothing stored says "blocked".
//
// addBlocker reads and writes inside one transaction under a per-board advisory lock, so two
// opposite adds on the same board cannot both pass the cycle check.
// Lock order: the board's advisory lock is taken first, then the task row writes (a caller's own save runs
// after its links in the same transaction), so no two writers wait on each other in opposite order.
import { randomUUID } from 'node:crypto'
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '../db'
import { projectColumns, projectTasks, taskDependencies } from '../db/schema'
import type { ActivitySource, ProjectTask } from '../db/schema'
import { logActivity } from './taskActivity'
import type { Audience } from './auth-helpers'
import { checkNewLink, describeCycle, openBlockers } from './taskDependencies'
import type { TaskLink } from './taskDependencies'
import { terminalColumnIds } from '../../shared/utils/board'

export interface Actor {
  userId: string
  audience: Audience
  /** How the change was made, for the activity line. The app is the default. */
  via?: ActivitySource
}

/** Why a write was refused. `message` is plain words, safe to show the person. */
export interface BlockerRefusal {
  ok: false
  reason: 'not_staff' | 'not_found' | 'self' | 'duplicate' | 'cycle'
  message: string
}

export interface BlockerLink {
  id: string
  blockedTaskId: string
  blockerTaskId: string
  createdAt: number
}

/** One blocker as a viewer may read it. `id`, `title`, `column` and `finished` are withheld (null) when hidden. */
export interface Blocker {
  id: string | null
  title: string
  visible: boolean
  column: string | null
  finished: boolean | null
}

export const HIDDEN_TASK_TITLE = 'a hidden task'
export const NOT_ON_BOARD = 'That blocking task is not on this board.'
const NOT_STAFF = 'Adding and removing blocked-by links is for the team'
const DUPLICATE = 'This task already waits for that one.'

type TaskRow = Pick<ProjectTask, 'id' | 'projectId' | 'columnId' | 'title' | 'visibility' | 'completedAt' | 'deletedAt'>
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Db = typeof db | Tx

/** Runs work in the caller's transaction when it has one, or in a transaction of its own. */
export function inTransaction<T>(outer: Tx | undefined, work: (tx: Tx) => Promise<T>): Promise<T> {
  return outer ? work(outer) : db.transaction(work)
}

function refuse(reason: BlockerRefusal['reason'], message: string): BlockerRefusal {
  return { ok: false, reason, message }
}

/** A blocker is finished when it is in the trash, completed, or in the board's finished column. */
export function isFinishedTask(task: Pick<TaskRow, 'columnId' | 'completedAt' | 'deletedAt'>, finishedColumns: ReadonlySet<string>): boolean {
  return task.deletedAt !== null || task.completedAt !== null || finishedColumns.has(task.columnId)
}

/** The sentence a person reads when a link would close a loop, built from the cycle's steps. */
export function loopMessage(cycle: readonly string[], titleOf: (taskId: string) => string): string {
  const steps: string[] = []
  for (let i = 0; i + 1 < cycle.length; i++) {
    steps.push(`${titleOf(cycle[i]!)} waits for ${titleOf(cycle[i + 1]!)}`)
  }
  const sentence = steps.length > 1 ? `${steps.slice(0, -1).join(', ')}, and ${steps.at(-1)}` : steps.join('')
  return `That link would close a loop: ${sentence} (${describeCycle(cycle, titleOf)}).`
}

/** A blocker that is missing, in the trash, or on another board, refused with the same answer. */
export function blockerOffBoard(boardId: string, blocker: { projectId: string } | null): BlockerRefusal | null {
  return blocker && blocker.projectId === boardId ? null : refuse('not_found', NOT_ON_BOARD)
}

/** The unique-pair violation (code 23505) from a racing insert, as the duplicate refusal; null for any other error. */
export function duplicateRefusal(error: unknown): BlockerRefusal | null {
  let current: unknown = error
  // The driver may wrap the database error once or twice; look down the cause chain.
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    if ((current as { code?: unknown }).code === '23505') return refuse('duplicate', DUPLICATE)
    current = (current as { cause?: unknown }).cause
  }
  return null
}

/** What a viewer may read of one blocker. A customer gets nothing identifying when it is not customer-visible. */
export function viewBlocker(task: Pick<TaskRow, 'id' | 'title' | 'visibility'>, viewer: Actor, column: string | null, finished: boolean): Blocker {
  const visible = viewer.audience === 'staff' || task.visibility === 'customer'
  if (!visible) return { id: null, title: HIDDEN_TASK_TITLE, visible: false, column: null, finished: null }
  return { id: task.id, title: task.title, visible: true, column, finished }
}

/** The blocker id from a request body, or null when the body is empty or the id is not a non-empty string. */
export function blockerIdFrom(body: unknown): string | null {
  const id = (body as { blockerId?: unknown } | null | undefined)?.blockerId
  return typeof id === 'string' && id.trim() ? id.trim() : null
}

async function taskById(dbx: Db, taskId: string, includeDeleted = false): Promise<TaskRow | null> {
  const [row] = await dbx
    .select({
      id: projectTasks.id,
      projectId: projectTasks.projectId,
      columnId: projectTasks.columnId,
      title: projectTasks.title,
      visibility: projectTasks.visibility,
      completedAt: projectTasks.completedAt,
      deletedAt: projectTasks.deletedAt
    })
    .from(projectTasks)
    .where(and(eq(projectTasks.id, taskId), includeDeleted ? undefined : isNull(projectTasks.deletedAt)))
  return row ?? null
}

async function tasksById(dbx: Db, taskIds: string[]): Promise<Map<string, TaskRow>> {
  const map = new Map<string, TaskRow>()
  if (!taskIds.length) return map
  const rows = await dbx
    .select({
      id: projectTasks.id,
      projectId: projectTasks.projectId,
      columnId: projectTasks.columnId,
      title: projectTasks.title,
      visibility: projectTasks.visibility,
      completedAt: projectTasks.completedAt,
      deletedAt: projectTasks.deletedAt
    })
    .from(projectTasks)
    .where(inArray(projectTasks.id, taskIds))
  for (const row of rows) map.set(row.id, row)
  return map
}

/** The ids of the live columns that count as finished, per board. */
async function finishedColumnsOf(dbx: Db, projectIds: string[]): Promise<Set<string>> {
  const finished = new Set<string>()
  if (!projectIds.length) return finished
  const columns = await dbx
    .select({ id: projectColumns.id, projectId: projectColumns.projectId, name: projectColumns.name })
    .from(projectColumns)
    .where(and(inArray(projectColumns.projectId, projectIds), isNull(projectColumns.deletedAt)))
    .orderBy(asc(projectColumns.position))
  for (const projectId of projectIds) {
    for (const id of terminalColumnIds(columns.filter(column => column.projectId === projectId))) finished.add(id)
  }
  return finished
}

/** Every link on a board, so a cycle is found whichever tasks it runs through. */
async function linksOnBoard(dbx: Db, boardId: string): Promise<TaskLink[]> {
  return dbx
    .select({ blockedId: taskDependencies.blockedTaskId, blockerId: taskDependencies.blockerTaskId })
    .from(taskDependencies)
    .innerJoin(projectTasks, eq(projectTasks.id, taskDependencies.blockedTaskId))
    .where(eq(projectTasks.projectId, boardId))
}

/** A link title on the activity line, cut so one long title cannot fill it. */
export function cutTitle(title: string): string {
  return title.length > 80 ? `${title.slice(0, 79).trimEnd()}…` : title
}

/**
 * The line a link change writes on the blocked task, in the same transaction as the link. The log is
 * read by customers too, so a blocker that is not customer-visible is named as a hidden task.
 */
async function logLink(tx: Tx, task: Pick<TaskRow, 'id' | 'projectId'>, actor: Actor, kind: 'blocker_added' | 'blocker_removed', blocker: Pick<TaskRow, 'title' | 'visibility'> | null): Promise<void> {
  const name = blocker && blocker.visibility === 'customer' ? cutTitle(blocker.title) : HIDDEN_TASK_TITLE
  await logActivity(task, actor.userId, [{ kind, detail: kind === 'blocker_added' ? { to: name } : { from: name } }], actor.via ?? 'ui', tx)
}

export async function addBlocker(boardId: string, blockedId: string, blockerId: string, actor: Actor, outer?: Tx): Promise<{ ok: true, link: BlockerLink } | BlockerRefusal> {
  // Checked first, before any read that could lead to a write.
  if (actor.audience !== 'staff') return refuse('not_staff', NOT_STAFF)
  if (blockedId === blockerId) return refuse('self', 'A task cannot wait for itself.')

  try {
    return await inTransaction(outer, async (tx): Promise<{ ok: true, link: BlockerLink } | BlockerRefusal> => {
      // One writer per board at a time: the reads below and the insert see each other's links.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${boardId}))`)

      const blocked = await taskById(tx, blockedId)
      if (!blocked || blocked.projectId !== boardId) return refuse('not_found', 'That task is not on this board.')

      const blocker = await taskById(tx, blockerId)
      const blockerOff = blockerOffBoard(boardId, blocker)
      if (blockerOff) return blockerOff

      const refusal = checkNewLink(await linksOnBoard(tx, boardId), blockedId, blockerId)
      if (refusal?.reason === 'duplicate') return refuse('duplicate', DUPLICATE)
      if (refusal?.reason === 'cycle') {
        const titles = await tasksById(tx, refusal.cycle)
        const titleOf = (taskId: string) => titles.get(taskId)?.title ?? 'a task'
        return refuse('cycle', loopMessage(refusal.cycle, titleOf))
      }

      // The insert gets its own savepoint: a duplicate that gets past the lock is refused by the catch
      // below, and an outer caller's transaction stays usable after it (without this it fails with 25P02).
      const row = await tx.transaction(async (savepoint) => {
        const [inserted] = await savepoint.insert(taskDependencies).values({
          id: randomUUID(),
          blockedTaskId: blockedId,
          blockerTaskId: blockerId,
          createdBy: actor.userId,
          createdAt: Date.now()
        }).returning()
        return inserted!
      })
      await logLink(tx, blocked, actor, 'blocker_added', blocker)
      return {
        ok: true,
        link: { id: row.id, blockedTaskId: row.blockedTaskId, blockerTaskId: row.blockerTaskId, createdAt: row.createdAt }
      }
    })
  } catch (error) {
    // A racing insert past the lock (or a second process) hits the unique pair: the same answer as a duplicate.
    const duplicate = duplicateRefusal(error)
    if (duplicate) return duplicate
    throw error
  }
}

export async function removeBlocker(boardId: string, blockedId: string, blockerId: string, actor: Actor, outer?: Tx): Promise<{ ok: true, blockerId: string } | BlockerRefusal> {
  if (actor.audience !== 'staff') return refuse('not_staff', NOT_STAFF)
  return inTransaction(outer, async (tx): Promise<{ ok: true, blockerId: string } | BlockerRefusal> => {
    const blocked = await taskById(tx, blockedId, true)
    if (!blocked || blocked.projectId !== boardId) return refuse('not_found', 'That task is not on this board.')

    const removed = await tx
      .delete(taskDependencies)
      .where(and(eq(taskDependencies.blockedTaskId, blockedId), eq(taskDependencies.blockerTaskId, blockerId)))
      .returning({ id: taskDependencies.id })
    if (!removed.length) return refuse('not_found', 'That task is not blocked by this one.')

    // The line names the blocker as it is now; a trashed one is still on the board, so it is still found.
    const blocker = (await tasksById(tx, [blockerId])).get(blockerId) ?? null
    await logLink(tx, blocked, actor, 'blocker_removed', blocker)
    return { ok: true, blockerId }
  })
}

/** The blockers of a task as the viewer may read them, oldest link first. */
export async function listBlockers(taskId: string, viewer: Actor): Promise<Blocker[]> {
  const rows = await db
    .select({ blockerId: taskDependencies.blockerTaskId })
    .from(taskDependencies)
    .where(eq(taskDependencies.blockedTaskId, taskId))
    .orderBy(asc(taskDependencies.createdAt))
  const blockers = await tasksById(db, rows.map(row => row.blockerId))
  const finishedColumns = await finishedColumnsOf(db, [...new Set([...blockers.values()].map(task => task.projectId))])
  const columnIds = [...new Set([...blockers.values()].map(task => task.columnId))]
  const columns = columnIds.length
    ? await db.select({ id: projectColumns.id, name: projectColumns.name }).from(projectColumns).where(inArray(projectColumns.id, columnIds))
    : []
  const columnName = new Map(columns.map(column => [column.id, column.name]))

  const out: Blocker[] = []
  for (const row of rows) {
    const task = blockers.get(row.blockerId)
    if (!task) continue
    out.push(viewBlocker(task, viewer, columnName.get(task.columnId) ?? null, isFinishedTask(task, finishedColumns)))
  }
  return out
}

/** Whether a task is blocked right now, and which blockers are still open. Derived each time, never stored. */
export async function blockedState(taskId: string): Promise<{ blocked: boolean, openBlockerIds: string[] }> {
  const rows = await db
    .select({ blockedId: taskDependencies.blockedTaskId, blockerId: taskDependencies.blockerTaskId })
    .from(taskDependencies)
    .where(eq(taskDependencies.blockedTaskId, taskId))
  if (!rows.length) return { blocked: false, openBlockerIds: [] }

  const blockers = await tasksById(db, rows.map(row => row.blockerId))
  const finishedColumns = await finishedColumnsOf(db, [...new Set([...blockers.values()].map(task => task.projectId))])
  const isFinished = (id: string) => {
    const task = blockers.get(id)
    return task ? isFinishedTask(task, finishedColumns) : true
  }
  const openBlockerIds = openBlockers(taskId, rows, isFinished)
  return { blocked: openBlockerIds.length > 0, openBlockerIds }
}

/** The derived states of many tasks on one board: the board's links, their blocker rows and its finished columns, each read once. */
export async function blockedStatesOn(boardId: string, taskIds: string[]): Promise<Map<string, BlockedState>> {
  const links = await linksOnBoard(db, boardId)
  const blockers = await tasksById(db, [...new Set(links.map(link => link.blockerId))])
  const finishedColumns = await finishedColumnsOf(db, [boardId])
  return blockedStatesFrom(links, blockers, finishedColumns, taskIds)
}

/** The states of the given tasks from rows already read. A blocker missing from the rows counts as finished, as in blockedState. */
export function blockedStatesFrom(links: readonly TaskLink[], blockers: ReadonlyMap<string, TaskRow>, finishedColumns: ReadonlySet<string>, taskIds: readonly string[]): Map<string, BlockedState> {
  const isFinished = (id: string) => {
    const task = blockers.get(id)
    return task ? isFinishedTask(task, finishedColumns) : true
  }
  const states = new Map<string, BlockedState>()
  for (const taskId of taskIds) {
    const openBlockerIds = openBlockers(taskId, links, isFinished)
    states.set(taskId, { blocked: openBlockerIds.length > 0, openBlockerIds })
  }
  return states
}

export interface BlockedState {
  blocked: boolean
  openBlockerIds: string[]
}
