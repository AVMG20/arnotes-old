import { and, count, desc, eq, isNull } from 'drizzle-orm'
import { db } from '../../db'
import { notifications, projectTasks, projects, user } from '../../db/schema'

// The signed-in person's inbox, newest first, and how many of it are unread.
export default defineEventHandler(async (event) => {
  const userId = event.context.session.user.id
  const query = getQuery(event)
  const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 200)

  const rows = await db
    .select({
      id: notifications.id,
      type: notifications.type,
      projectId: notifications.projectId,
      projectName: projects.name,
      taskId: notifications.taskId,
      taskTitle: projectTasks.title,
      messageId: notifications.messageId,
      title: notifications.title,
      body: notifications.body,
      createdAt: notifications.createdAt,
      readAt: notifications.readAt,
      actorName: user.name,
      actorImage: user.image
    })
    .from(notifications)
    .innerJoin(projects, eq(projects.id, notifications.projectId))
    .leftJoin(projectTasks, eq(projectTasks.id, notifications.taskId))
    .leftJoin(user, eq(user.id, notifications.actorId))
    .where(and(eq(notifications.userId, userId), query.unread === '1' ? isNull(notifications.readAt) : undefined))
    .orderBy(desc(notifications.createdAt))
    .limit(limit)

  const [unread] = await db
    .select({ total: count() })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))

  return { unread: Number(unread?.total ?? 0), items: rows }
})
