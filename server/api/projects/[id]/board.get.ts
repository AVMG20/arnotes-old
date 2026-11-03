import { db } from '../../../db'
import { projectColumns, projectTasks, taskComments } from '../../../db/schema'
import { and, eq, asc, inArray, count, isNull, isNotNull } from 'drizzle-orm'
import { requireProject } from '../../../utils/projects'
import { commentVisibilityFilter, taskVisibilityFilter } from '../../../utils/auth-helpers'
import { listFields, loadFieldValues } from '../../../utils/customFields'
import { githubBadgesForBoard } from '../../../utils/githubBadges'
import { blockedStatesOn } from '../../../utils/taskDependencyService'
import { blockedMark } from '../../../utils/mcpBlockerLinks'

// Full board in one payload: columns ordered, tasks grouped by column, and the
// per-task update count the cards render as a badge.
//
// `?trashed=1` additionally returns the board's soft-deleted columns and tasks,
// which is what the board's "Show trashed" mode draws. The count of them comes
// back either way — the header needs to know there is something in the trash
// before the user has asked to see it, which is the whole point when the delete
// happened overnight through an agent.
//
// A customer contact gets the same shape with everything internal left out:
// internal tasks, internal comments in the counts, and the trash, which is the
// team's own housekeeping.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const project = await requireProject(event, id)
  const isCustomer = project.audience === 'customer'

  const includeTrashed = !isCustomer && getQuery(event).trashed === '1'
  const liveColumns = isNull(projectColumns.deletedAt)
  const liveTasks = isNull(projectTasks.deletedAt)

  const columns = await db
    .select()
    .from(projectColumns)
    .where(and(
      eq(projectColumns.projectId, id),
      includeTrashed ? undefined : liveColumns
    ))
    .orderBy(asc(projectColumns.position))

  // A task trashed on its own sits in a column that is still there; a task
  // trashed along with its column sits in one that is not. Selecting by column
  // covers both, because the column list above already widened with the flag.
  const rows = columns.length
    ? await db
        .select()
        .from(projectTasks)
        .where(and(
          inArray(projectTasks.columnId, columns.map(c => c.id)),
          includeTrashed ? undefined : liveTasks,
          taskVisibilityFilter(project.audience)
        ))
        .orderBy(asc(projectTasks.position))
    : []

  // Subtasks share their parent's column but are not cards. They come in a list
  // of their own, which the cards count from and the task panel lists, and they
  // can nest to any depth (a subtask of a subtask, and so on). A subtask is only
  // kept while walking up its chain of parents actually reaches a live top-level
  // task — a trashed top-level task (or a broken link partway up, which means an
  // ancestor was filtered out of `rows`) hides everything under it, at every
  // depth, until that ancestor goes back or goes for good.
  const rowsById = new Map(rows.map(t => [t.id, t]))
  const tasks = rows.filter(t => !t.parentTaskId)
  function hasLiveTopLevelAncestor(row: typeof rows[number]): boolean {
    let current = row
    while (current.parentTaskId) {
      const parent = rowsById.get(current.parentTaskId)
      if (!parent) return false
      current = parent
    }
    return !current.deletedAt
  }
  const subtasks = rows.filter(t => t.parentTaskId && hasLiveTopLevelAncestor(t))

  const counts = tasks.length
    ? await db
        .select({ taskId: taskComments.taskId, total: count() })
        .from(taskComments)
        .where(and(
          inArray(taskComments.taskId, tasks.map(t => t.id)),
          commentVisibilityFilter(project.audience)
        ))
        .groupBy(taskComments.taskId)
    : []

  // Counted rather than derived from the rows above, so the number is right
  // even when the trashed rows were not asked for. A live task never sits in a
  // trashed column — deleting one hands its tasks to a neighbour — so the two
  // counts do not overlap.
  let trashedCount = 0
  if (!isCustomer) {
    const [trashedTasks] = await db
      .select({ total: count() })
      .from(projectTasks)
      .where(and(eq(projectTasks.projectId, id), isNotNull(projectTasks.deletedAt), isNull(projectTasks.parentTaskId)))

    const [trashedColumns] = await db
      .select({ total: count() })
      .from(projectColumns)
      .where(and(eq(projectColumns.projectId, id), isNotNull(projectColumns.deletedAt)))

    trashedCount = Number(trashedTasks?.total ?? 0) + Number(trashedColumns?.total ?? 0)
  }

  // Custom fields are the team's own: a contact's board carries neither the
  // definitions nor anyone's values.
  const fields = isCustomer ? [] : await listFields(id)
  const fieldValues = fields.length ? await loadFieldValues([...tasks, ...subtasks].map(t => t.id)) : {}

  // Cards' GitHub badges, from the cache only (see githubBadges.ts); the board never calls GitHub.
  const githubBadges = await githubBadgesForBoard(id, [...tasks, ...subtasks].map(t => t.id), project.audience)

  // Blocked-by marks for the cards: one batch for the whole board, not a query per task.
  // A customer gets blocked only; the open blockers' ids are staff-only (see blockedMark).
  const blockedStates = await blockedStatesOn(id, tasks.map(t => t.id))
  const marks = new Map(tasks.map(t => [t.id, blockedMark(blockedStates.get(t.id) ?? { blocked: false, openBlockerIds: [] }, project.audience)]))

  return {
    audience: project.audience,
    columns,
    tasks: tasks.map(task => ({ ...task, ...marks.get(task.id) })),
    subtasks,
    fields,
    fieldValues,
    githubBadges,
    commentCounts: Object.fromEntries(counts.map(c => [c.taskId, Number(c.total)])),
    trashedCount
  }
})
