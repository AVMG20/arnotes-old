// What the key's person sees on their own pages: My tasks and the Inbox. An agent
// acting for someone reads what is theirs the way they would, and the same
// audience rule applies: a contact's agent is not shown tasks the contact cannot
// see.
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '../db'
import { notifications, projectTasks, projects, user } from '../db/schema'
import { accessibleBoards } from './mcpBoardTools'
import { blockedStatesOn } from './taskDependencyService'
import { blockedMark } from './mcpBlockerLinks'
import type { BlockedMark } from './mcpBlockerLinks'
import { audienceOf, readableTasksIn } from './mcpAccess'
import { McpToolError, optionalBoolean, optionalLimit, optionalStringArray } from './mcpToolKit'
import type { McpToolDefinition } from './mcpToolKit'

export const MCP_ME_TOOLS: McpToolDefinition[] = [
  {
    name: 'my_tasks',
    title: 'Read my tasks',
    description: 'The tasks assigned to the key\'s owner across every board they can open, soonest due date first: the same list as "My tasks" in the app, plus the subtasks assigned to them, each with its parent (parent: id and title) so it can be worked by its own id. Finished tasks are left out unless asked for. A task that waits for an open blocker reads blocked: true with blockedBy (team only).',
    scope: 'boards:read',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        includeCompleted: { type: 'boolean', description: 'Also return tasks that are done (default false).' },
        limit: { type: 'number', description: 'Maximum tasks to return (default 50, max 200).' }
      }
    },
    async handler(args, context) {
      const includeCompleted = optionalBoolean(args, 'includeCompleted') ?? false
      const limit = optionalLimit(args, 'limit', 50, 200)
      const boards = await accessibleBoards(context)
      if (!boards.length) return { total: 0, tasks: [] }

      const rows = await db
        .select({
          id: projectTasks.id,
          title: projectTasks.title,
          board: projects.name,
          boardId: projects.id,
          dueOn: projectTasks.dueOn,
          startOn: projectTasks.startOn,
          completedAt: projectTasks.completedAt,
          labels: projectTasks.tags,
          parentTaskId: projectTasks.parentTaskId
        })
        .from(projectTasks)
        .innerJoin(projects, eq(projects.id, projectTasks.projectId))
        .where(and(
          eq(projectTasks.assigneeId, context.userId),
          isNull(projectTasks.deletedAt),
          readableTasksIn(context, boards),
          includeCompleted ? undefined : isNull(projectTasks.completedAt)
        ))
        .orderBy(asc(projectTasks.dueOn), asc(projectTasks.title))

      // A subtask names its parent, so it can be found and worked by its own id.
      const parentIds = [...new Set(rows.flatMap(row => (row.parentTaskId ? [row.parentTaskId] : [])))]
      const parents = parentIds.length
        ? await db
            .select({ id: projectTasks.id, title: projectTasks.title })
            .from(projectTasks)
            .where(and(inArray(projectTasks.id, parentIds), isNull(projectTasks.deletedAt), readableTasksIn(context, boards)))
        : []
      const parentTitles = new Map(parents.map(parent => [parent.id, parent.title]))

      // Tasks with no date sort last, as in the app.
      const sorted = [...rows].sort((a, b) => (a.dueOn ?? '9999').localeCompare(b.dueOn ?? '9999'))
      const shown = sorted.slice(0, limit)
      // One read per board, each mark read as that board lets the key read it (a customer's contact gets no blocker ids).
      const marks = new Map<string, BlockedMark>()
      for (const boardId of new Set(shown.map(row => row.boardId))) {
        const states = await blockedStatesOn(boardId, shown.filter(row => row.boardId === boardId).map(row => row.id))
        const audience = audienceOf(context, boards.find(board => board.id === boardId)!)
        for (const [id, state] of states) marks.set(id, blockedMark(state, audience))
      }
      return {
        total: sorted.length,
        tasks: shown.map(row => ({
          id: row.id,
          title: row.title,
          board: { id: row.boardId, name: row.board },
          ...(row.dueOn ? { dueOn: row.dueOn } : {}),
          ...(row.startOn ? { startOn: row.startOn } : {}),
          ...(row.completedAt ? { completed: true } : {}),
          ...(row.labels.length ? { labels: row.labels } : {}),
          ...marks.get(row.id),
          ...(row.parentTaskId ? { parent: { id: row.parentTaskId, title: parentTitles.get(row.parentTaskId) ?? null } } : {})
        }))
      }
    }
  },
  {
    name: 'list_notifications',
    title: 'Read my inbox',
    description: 'The key\'s owner\'s inbox, newest first: who assigned them what, comments and messages for them. The same list as the Inbox in the app.',
    scope: 'boards:read',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        unreadOnly: { type: 'boolean', description: 'Only notifications not yet read (default false).' },
        limit: { type: 'number', description: 'Maximum notifications to return (default 20, max 100).' }
      }
    },
    async handler(args, context) {
      const unreadOnly = optionalBoolean(args, 'unreadOnly') ?? false
      const limit = optionalLimit(args, 'limit', 20, 100)

      const rows = await db
        .select({
          id: notifications.id,
          type: notifications.type,
          title: notifications.title,
          body: notifications.body,
          board: projects.name,
          taskId: notifications.taskId,
          createdAt: notifications.createdAt,
          readAt: notifications.readAt,
          actor: user.name
        })
        .from(notifications)
        .innerJoin(projects, eq(projects.id, notifications.projectId))
        .leftJoin(user, eq(user.id, notifications.actorId))
        .where(and(eq(notifications.userId, context.userId), unreadOnly ? isNull(notifications.readAt) : undefined))
        .orderBy(desc(notifications.createdAt))
        .limit(limit)

      const unread = (await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(and(eq(notifications.userId, context.userId), isNull(notifications.readAt)))).length

      return {
        unread,
        notifications: rows.map(row => ({
          id: row.id,
          type: row.type,
          title: row.title,
          ...(row.body ? { body: row.body } : {}),
          board: row.board,
          ...(row.taskId ? { taskId: row.taskId } : {}),
          ...(row.actor ? { from: row.actor } : {}),
          at: new Date(row.createdAt).toISOString(),
          read: row.readAt !== null
        }))
      }
    }
  },
  {
    name: 'mark_notifications_read',
    title: 'Mark inbox notifications read',
    description: 'Mark some of the key\'s owner\'s notifications read, by id, or all of them with "all": true.',
    scope: 'boards:write',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'Notification ids from list_notifications.' },
        all: { type: 'boolean', description: 'Mark every unread notification read.' }
      }
    },
    async handler(args, context) {
      const ids = optionalStringArray(args, 'ids') ?? []
      const all = optionalBoolean(args, 'all') ?? false
      if (!all && !ids.length) throw new McpToolError('Pass "ids", or "all": true.')

      const marked = await db.update(notifications)
        .set({ readAt: Date.now() })
        .where(and(
          eq(notifications.userId, context.userId),
          isNull(notifications.readAt),
          all ? undefined : inArray(notifications.id, ids.slice(0, 500))
        ))
        .returning({ id: notifications.id })
      return { marked: marked.length }
    }
  }
]
