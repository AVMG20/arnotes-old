import { db } from '../../../db'
import { taskComments, user, apiKeys, VISIBILITIES } from '../../../db/schema'
import type { Visibility } from '../../../db/schema'
import { and, eq, asc } from 'drizzle-orm'
import { requireTask, genId } from '../../../utils/projects'
import { commentVisibilityFilter } from '../../../utils/auth-helpers'
import { publishFromEvent } from '../../../utils/realtime'
import { notifyComment } from '../../../utils/notifyEvents'
import { fireRules, newRuleChain } from '../../../utils/ruleEngine'
import { attachReplyPreviews, resolveReplyTarget, signedName } from '../../../utils/taskComments'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const { task: _task, project } = await requireTask(event, id)

  if (event.method === 'GET') {
    const rows = await db
      .select({
        id: taskComments.id,
        taskId: taskComments.taskId,
        userId: taskComments.userId,
        body: taskComments.body,
        visibility: taskComments.visibility,
        createdAt: taskComments.createdAt,
        editedAt: taskComments.editedAt,
        createdVia: taskComments.createdVia,
        replyToId: taskComments.replyToId,
        userName: user.name,
        // An agent's update is signed with the key it was posted with, so the
        // log says "Claude Code" where the work was actually an agent's.
        keyName: apiKeys.name
      })
      .from(taskComments)
      .leftJoin(user, eq(user.id, taskComments.userId))
      .leftJoin(apiKeys, eq(apiKeys.id, taskComments.apiKeyId))
      .where(and(eq(taskComments.taskId, id), commentVisibilityFilter(project.audience)))
      .orderBy(asc(taskComments.createdAt))
    // A GitHub copy is signed GitHub here too, not with the owner's account (see signedName).
    return attachReplyPreviews(id, rows.map(row => ({ ...row, userName: signedName(row) })), project.audience)
  }

  if (event.method !== 'POST') {
    throw createError({ statusCode: 405, message: 'Method not allowed' })
  }

  const payload = await readBody<{ body?: string, visibility?: Visibility, replyTo?: string | null }>(event)
  const body = payload.body?.trim()
  if (!body) throw createError({ statusCode: 400, message: 'Comment body is required' })
  if (payload.visibility !== undefined && !VISIBILITIES.includes(payload.visibility)) {
    throw createError({ statusCode: 400, message: 'Unknown visibility' })
  }

  const replyToId = await resolveReplyTarget(id, payload.replyTo, project.audience)

  const [comment] = await db.insert(taskComments).values({
    id: genId(),
    taskId: id,
    userId: event.context.session.user.id,
    body,
    // A contact writes to the team in the open; staff choose, and start internal.
    visibility: project.audience === 'customer' ? 'customer' : (payload.visibility ?? 'internal'),
    createdVia: 'ui',
    replyToId,
    createdAt: Date.now()
  }).returning()

  await notifyComment(project, _task, event.context.session.user.id, body, comment!.visibility === 'internal', replyToId)
  // A comment is an event too: the rules hear about it once it is saved.
  await fireRules({ type: 'comment_added', projectId: project.id, taskId: id, actorId: event.context.session.user.id, actorIsAgent: false, detail: null }, newRuleChain()).catch(() => {})
  await publishFromEvent(event, { type: 'board', projectId: _task.projectId })
  const [withPreview] = await attachReplyPreviews(id, [comment!], project.audience)
  return { ...withPreview!, userName: event.context.session.user.name, keyName: null }
})
