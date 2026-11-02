// What a rule's actions do to a task. Each one writes the way the task routes do
// (positions, completed_at, the activity log, notifications), so a rule's move
// reads like a move. Nothing here fires a rule: a change hands its event to the
// follow-up the engine passed in, one step deeper in the chain.
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../db'
import { projectColumns, projectTasks, projects, taskComments, type ProjectTask, type Visibility } from '../db/schema'
import type { Action, TaskSnapshot, TriggerKind } from './ruleSpec'
import { columnTasksOrdered, genId, positionBetween, subtasksOrdered } from './projects'
import { changesToTask, logActivity, inboxBriefs } from './taskActivity'
import { notifyAssigned, notifyComment, notifyTaskChange } from './notifyEvents'
import { announceTaskCreated } from './agentEvents'
import { requireAssignable } from './people'
import { publish, workspaceTopic } from './realtime'

export interface RuleEvent {
  type: TriggerKind
  projectId: string
  taskId: string
  actorId: string | null
  actorIsAgent: boolean
  /** The column id, the person id or the pull request number, depending on the type. */
  detail?: string | null
}

export interface RuleChain {
  id: string
  depth: number
  /** Rule and task pairs already run in this chain, as `ruleId:taskId`. Shared by every step. */
  fired: Set<string>
}

export interface RuleProject {
  id: string
  name: string
  userId: string
  teamId: string | null
  customerId: string | null
}

export interface RuleSource {
  id: string
  name: string
  createdBy: string | null
}

export type FollowUp = (event: RuleEvent) => Promise<void>

// Who a rule's change is booked to. The customer decided the history names the
// rule ("Rule: <name>") rather than a person, so there is no actor. Change this one
// line if that decision changes.
export function ruleActorId(): string | null {
  return null
}

// Tags on a task are capped and stored lowercase, as the task route does.
const MAX_TAGS = 10

async function loadTask(taskId: string): Promise<ProjectTask> {
  const [task] = await db.select().from(projectTasks)
    .where(and(eq(projectTasks.id, taskId), isNull(projectTasks.deletedAt)))
  if (!task) throw createError({ statusCode: 404, message: 'The task is no longer on the board' })
  return task
}

async function renumber(ids: string[]) {
  for (const [idx, tid] of ids.entries()) {
    await db.update(projectTasks).set({ position: idx * 1000 }).where(eq(projectTasks.id, tid))
  }
}

// Writes a change the way the task route does, then tells the people on the task.
// Each activity line names the rule that made it.
async function recordChange(project: RuleProject, task: ProjectTask, patch: Parameters<typeof changesToTask>[1], rule: RuleSource) {
  const entries = (await changesToTask(task, patch)).map(entry => ({
    ...entry,
    detail: { ...entry.detail, rule: rule.name }
  }))
  await logActivity(task, ruleActorId(), entries)
  await notifyTaskChange(project, task, ruleActorId(), inboxBriefs(entries))
}

// The board changed: bump the project and tell the open views, as the routes do.
async function touchBoard(project: RuleProject) {
  const now = Date.now()
  await db.update(projects).set({ updatedAt: now }).where(eq(projects.id, project.id))
  await publish(workspaceTopic(project.userId, project.teamId), { type: 'board', projectId: project.id })
}

// Takes a task's snapshot for the condition check. Used by the engine.
export async function snapshotTask(taskId: string): Promise<(TaskSnapshot & { deleted: boolean }) | null> {
  const [task] = await db.select().from(projectTasks).where(eq(projectTasks.id, taskId))
  if (!task) return null
  return {
    columnId: task.columnId,
    assigneeId: task.assigneeId,
    tags: task.tags,
    dueOn: task.dueOn,
    visibility: task.visibility,
    deleted: task.deletedAt !== null
  }
}

function dueInDays(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

/**
 * Runs one action on the event's task. Throws with a readable message when it
 * cannot, and the engine turns that into a `failed` line in the run log.
 */
export async function runAction(
  action: Action,
  project: RuleProject,
  rule: RuleSource,
  taskId: string,
  followUp: FollowUp
): Promise<void> {
  const task = await loadTask(taskId)
  const base = { projectId: project.id, taskId, actorId: ruleActorId(), actorIsAgent: false }

  switch (action.kind) {
    case 'move_to_column': {
      if (task.columnId === action.columnId) return
      const [column] = await db.select().from(projectColumns).where(and(
        eq(projectColumns.id, action.columnId),
        eq(projectColumns.projectId, project.id),
        isNull(projectColumns.deletedAt)
      ))
      if (!column) throw createError({ statusCode: 400, message: 'That column is no longer on this board' })
      const siblings = (await columnTasksOrdered(column.id))
        .filter(t => t.id !== task.id)
        .map(t => ({ id: t.id, position: t.position }))
      const position = await positionBetween(siblings, null, null, renumber)
      const patch = { columnId: column.id, previousColumnId: null, position, updatedAt: Date.now() }
      await db.update(projectTasks).set(patch).where(eq(projectTasks.id, task.id))
      // Subtasks follow their parent's column.
      await db.update(projectTasks).set({ columnId: column.id }).where(eq(projectTasks.parentTaskId, task.id))
      await recordChange(project, task, { columnId: column.id }, rule)
      await touchBoard(project)
      await followUp({ ...base, type: 'task_moved', detail: column.id })
      return
    }

    case 'assign': {
      if (task.assigneeId === action.assigneeId) return
      await requireAssignable(project, action.assigneeId)
      await db.update(projectTasks).set({ assigneeId: action.assigneeId, updatedAt: Date.now() }).where(eq(projectTasks.id, task.id))
      await recordChange(project, task, { assigneeId: action.assigneeId }, rule)
      await notifyAssigned(project, task, ruleActorId(), action.assigneeId)
      await touchBoard(project)
      await followUp({ ...base, type: 'task_assigned', detail: action.assigneeId })
      return
    }

    case 'unassign': {
      if (task.assigneeId === null) return
      await db.update(projectTasks).set({ assigneeId: null, updatedAt: Date.now() }).where(eq(projectTasks.id, task.id))
      await recordChange(project, task, { assigneeId: null }, rule)
      await touchBoard(project)
      return
    }

    case 'set_due_in_days': {
      const dueOn = dueInDays(action.days)
      if (task.dueOn === dueOn) return
      await db.update(projectTasks).set({ dueOn, updatedAt: Date.now() }).where(eq(projectTasks.id, task.id))
      await recordChange(project, task, { dueOn }, rule)
      await touchBoard(project)
      await followUp({ ...base, type: 'due_set' })
      return
    }

    case 'complete': {
      if (task.completedAt) return
      const completedAt = Date.now()
      await db.update(projectTasks).set({ completedAt, updatedAt: completedAt }).where(eq(projectTasks.id, task.id))
      await recordChange(project, task, { completedAt }, rule)
      await touchBoard(project)
      await followUp({ ...base, type: 'task_completed' })
      return
    }

    case 'reopen': {
      if (!task.completedAt) return
      await db.update(projectTasks).set({ completedAt: null, updatedAt: Date.now() }).where(eq(projectTasks.id, task.id))
      await recordChange(project, task, { completedAt: null }, rule)
      await touchBoard(project)
      await followUp({ ...base, type: 'task_reopened' })
      return
    }

    case 'add_label': {
      const label = action.label.trim().toLowerCase()
      if (task.tags.includes(label)) return
      const tags = [...new Set([...task.tags, label])].slice(0, MAX_TAGS)
      // The task route keeps no log line for a tag, so none is written here.
      await db.update(projectTasks).set({ tags, updatedAt: Date.now() }).where(eq(projectTasks.id, task.id))
      await touchBoard(project)
      return
    }

    case 'add_comment': {
      // The comment needs an author account. A rule posts under the account that
      // made it, and always as internal: a rule must not put words in front of a customer.
      if (!rule.createdBy) throw createError({ statusCode: 400, message: 'The rule has no author left to post the comment' })
      const now = Date.now()
      await db.insert(taskComments).values({
        id: genId(),
        taskId: task.id,
        userId: rule.createdBy,
        body: `Rule "${rule.name}": ${action.text}`,
        visibility: 'internal',
        createdVia: 'ui',
        createdAt: now
      })
      await notifyComment(project, task, rule.createdBy, action.text, true)
      await touchBoard(project)
      await followUp({ ...base, type: 'comment_added' })
      return
    }

    case 'create_subtask': {
      const siblings = await subtasksOrdered(task.id)
      const now = Date.now()
      const [subtask] = await db.insert(projectTasks).values({
        id: genId(),
        projectId: project.id,
        columnId: task.columnId,
        parentTaskId: task.id,
        title: action.title,
        description: '',
        tags: [],
        // A subtask of an internal task stays internal, as the task route does.
        visibility: task.visibility,
        createdBy: rule.createdBy,
        assigneeId: null,
        dueOn: null,
        position: (siblings.at(-1)?.position ?? -1000) + 1000,
        createdAt: now,
        updatedAt: now
      }).returning()
      await logActivity(subtask!, ruleActorId(), [{ kind: 'created', detail: { rule: rule.name } }])
      announceTaskCreated(project, subtask!, ruleActorId(), 'rule')
      await touchBoard(project)
      await followUp({ ...base, taskId: subtask!.id, type: 'task_added' })
      return
    }

    case 'set_visibility': {
      // Visibility decides what the customer sees, so only the project owner's rules may set it.
      if (rule.createdBy !== project.userId) {
        throw createError({ statusCode: 400, message: 'Only the project owner can make a rule change task visibility' })
      }
      const value: Visibility = action.value
      if (task.visibility === value) return
      await db.update(projectTasks).set({ visibility: value, updatedAt: Date.now() }).where(eq(projectTasks.id, task.id))
      await recordChange(project, task, { visibility: value }, rule)
      await touchBoard(project)
      return
    }
  }
}
