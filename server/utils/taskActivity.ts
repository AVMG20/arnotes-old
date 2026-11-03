// The log of what happened to a task. Written next to the change itself, by the
// app and by the agent tools alike, so it reads the same whoever did it.
import { asc, eq, inArray } from 'drizzle-orm'
import { db } from '../db'
import { projectColumns, taskActivity, user } from '../db/schema'
import type { ActivitySource, ProjectTask, TaskActivityKind } from '../db/schema'

export interface ActivityEntry {
  kind: TaskActivityKind
  /** Names, not ids: the entry has to keep reading right after a column or person is gone. */
  detail?: Record<string, string | null>
}

function newId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

export async function columnName(columnId: string): Promise<string> {
  const [row] = await db.select({ name: projectColumns.name }).from(projectColumns).where(eq(projectColumns.id, columnId))
  return row?.name ?? 'a column'
}

export async function personName(userId: string): Promise<string> {
  const [row] = await db.select({ name: user.name }).from(user).where(eq(user.id, userId))
  return row?.name ?? 'Someone'
}

/** Records what happened, in order. Nothing to say records nothing. */
export async function logActivity(
  task: Pick<ProjectTask, 'id' | 'projectId'>,
  actorId: string | null,
  entries: ActivityEntry[],
  via: ActivitySource = 'ui',
  // A transaction of the caller's, so a link change and its line commit or roll back together.
  writer: Pick<typeof db, 'insert'> = db
) {
  if (!entries.length) return
  const now = Date.now()
  await writer.insert(taskActivity).values(entries.map((entry, index) => ({
    id: newId(),
    taskId: task.id,
    projectId: task.projectId,
    actorId,
    via,
    kind: entry.kind,
    detail: entry.detail ?? {},
    // One request's entries keep their order even when they share a millisecond.
    createdAt: now + index
  })))
}

/** What a change comes to in a few words, for an Inbox item. */
export function briefOf(entry: ActivityEntry): string {
  const detail = entry.detail ?? {}
  switch (entry.kind) {
    case 'created': return 'Created'
    case 'completed': return 'Marked done'
    case 'reopened': return 'Reopened'
    case 'moved': return `Moved to ${detail.to}`
    case 'assigned': return `Assigned to ${detail.to}`
    case 'unassigned': return 'Unassigned'
    case 'due': return detail.to ? `Due ${detail.to}` : 'Due date cleared'
    case 'start': return detail.to ? `Starts ${detail.to}` : 'Start date cleared'
    case 'renamed': return `Renamed to "${detail.to}"`
    case 'visibility': return `Made ${detail.to}`
    case 'blocker_added': return `Waits for ${detail.to}`
    case 'blocker_removed': return `No longer waits for ${detail.from}`
    case 'label': return detail.to ? `Added label ${detail.to}` : `Removed label ${detail.from}`
  }
}

/**
 * The entries a PUT on a task comes to: what is different between the stored
 * task and what it is about to be. `assignee` is the new person's name, looked
 * up by the caller, because only the caller has just checked them.
 */
export async function changesToTask(
  task: ProjectTask,
  patch: Partial<Pick<ProjectTask, 'title' | 'visibility' | 'assigneeId' | 'dueOn' | 'startOn' | 'completedAt' | 'columnId'>>
): Promise<ActivityEntry[]> {
  const entries: ActivityEntry[] = []
  if (patch.completedAt !== undefined && !!patch.completedAt !== !!task.completedAt) {
    entries.push({ kind: patch.completedAt ? 'completed' : 'reopened' })
  }
  if (patch.columnId !== undefined && patch.columnId !== task.columnId) {
    entries.push({ kind: 'moved', detail: { from: await columnName(task.columnId), to: await columnName(patch.columnId) } })
  }
  if (patch.assigneeId !== undefined && patch.assigneeId !== task.assigneeId) {
    entries.push(patch.assigneeId
      ? { kind: 'assigned', detail: { to: await personName(patch.assigneeId) } }
      : { kind: 'unassigned' })
  }
  if (patch.dueOn !== undefined && patch.dueOn !== task.dueOn) entries.push({ kind: 'due', detail: { to: patch.dueOn } })
  if (patch.startOn !== undefined && patch.startOn !== task.startOn) entries.push({ kind: 'start', detail: { to: patch.startOn } })
  if (patch.title !== undefined && patch.title !== task.title) entries.push({ kind: 'renamed', detail: { to: patch.title } })
  if (patch.visibility !== undefined && patch.visibility !== task.visibility) {
    entries.push({ kind: 'visibility', detail: { to: patch.visibility === 'internal' ? 'internal' : 'visible to the customer' } })
  }
  return entries
}

export interface ActivityRow {
  id: string
  kind: TaskActivityKind
  detail: Record<string, string | null>
  via: ActivitySource
  actorId: string | null
  actorName: string | null
  createdAt: number
}

/**
 * The log of one task, oldest first. A task made before the log existed has no
 * "created" entry of its own, so one is drawn from the task row. A customer's
 * contact is not shown a change of audience.
 */
export async function listActivity(task: ProjectTask, forCustomer: boolean): Promise<ActivityRow[]> {
  const rows = await db.select().from(taskActivity).where(eq(taskActivity.taskId, task.id)).orderBy(asc(taskActivity.createdAt))
  const actorIds = [...new Set([...rows.map(row => row.actorId), task.createdBy].filter((id): id is string => !!id))]
  const names = new Map<string, string>()
  if (actorIds.length) {
    for (const person of await db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, actorIds))) {
      names.set(person.id, person.name)
    }
  }

  const list: ActivityRow[] = rows
    .filter(row => !(forCustomer && row.kind === 'visibility'))
    .map(row => ({
      id: row.id,
      kind: row.kind,
      detail: row.detail,
      via: row.via,
      actorId: row.actorId,
      actorName: row.actorId ? names.get(row.actorId) ?? null : null,
      createdAt: row.createdAt
    }))

  if (!list.some(row => row.kind === 'created')) {
    list.unshift({
      id: `created-${task.id}`,
      kind: 'created',
      detail: {},
      via: 'ui',
      actorId: task.createdBy,
      actorName: task.createdBy ? names.get(task.createdBy) ?? null : null,
      createdAt: task.createdAt
    })
  }
  return list
}

/**
 * The changes the people on a task are told about. Giving it to someone has its
 * own message, and a change of audience is not for the Inbox.
 */
export function inboxBriefs(entries: ActivityEntry[]): string[] {
  const told: TaskActivityKind[] = ['completed', 'reopened', 'moved', 'due']
  return entries.filter(entry => told.includes(entry.kind)).map(briefOf)
}
