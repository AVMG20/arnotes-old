import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '../../db'
import { agentAudit } from '../../db/schema'

// Marks agent audit rows read: the ids given, or every unread one with `all`.
export default defineEventHandler(async (event) => {
  const userId = event.context.session.user.id
  const body = await readBody<{ ids?: unknown, all?: unknown }>(event)

  const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === 'string').slice(0, 500) : []
  if (!body.all && !ids.length) throw createError({ statusCode: 400, message: 'Say which agent actions to mark read, or all' })

  const updated = await db.update(agentAudit)
    .set({ readAt: Date.now() })
    .where(and(
      eq(agentAudit.userId, userId),
      isNull(agentAudit.readAt),
      body.all ? undefined : inArray(agentAudit.id, ids)
    ))
    .returning({ id: agentAudit.id })

  return { marked: updated.length }
})
