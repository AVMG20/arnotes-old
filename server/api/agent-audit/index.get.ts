import { and, count, desc, eq, isNull, sql } from 'drizzle-orm'
import { db } from '../../db'
import { agentAudit, apiKeys, projectTasks } from '../../db/schema'

// What the signed-in person's agents did through their API keys, newest first, and how
// many of it is unread. `hasAgents` tells the Inbox whether to show the Agent audit tab.
export default defineEventHandler(async (event) => {
  const userId = event.context.session.user.id
  const query = getQuery(event)
  const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 200)

  const rows = await db
    .select({
      id: agentAudit.id,
      keyName: agentAudit.keyName,
      tool: agentAudit.tool,
      toolTitle: agentAudit.toolTitle,
      projectId: agentAudit.projectId,
      projectName: agentAudit.projectName,
      // A task in the trash is not a place to send anyone: its title stays, its id goes.
      taskId: sql<string | null>`case when ${projectTasks.deletedAt} is null then ${projectTasks.id} end`,
      taskTitle: agentAudit.taskTitle,
      summary: agentAudit.summary,
      createdAt: agentAudit.createdAt,
      readAt: agentAudit.readAt
    })
    .from(agentAudit)
    .leftJoin(projectTasks, eq(projectTasks.id, agentAudit.taskId))
    .where(eq(agentAudit.userId, userId))
    .orderBy(desc(agentAudit.createdAt))
    .limit(limit)

  const [unread] = await db
    .select({ total: count() })
    .from(agentAudit)
    .where(and(eq(agentAudit.userId, userId), isNull(agentAudit.readAt)))

  // A key still exists, or a row survives from one that was deleted.
  let hasAgents = Number(unread?.total ?? 0) > 0 || rows.length > 0
  if (!hasAgents) {
    const [key] = await db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(eq(apiKeys.userId, userId))
      .limit(1)
    hasAgents = !!key
  }

  return { hasAgents, unread: Number(unread?.total ?? 0), items: rows }
})
