import { requireTask } from '../../../../utils/projects'
import { removeBlocker } from '../../../../utils/taskDependencyService'
import type { BlockerRefusal } from '../../../../utils/taskDependencyService'
import { publishFromEvent } from '../../../../utils/realtime'

const STATUS: Record<BlockerRefusal['reason'], number> = {
  not_staff: 403,
  not_found: 404,
  self: 400,
  duplicate: 409,
  cycle: 409
}

// Takes one blocker off this task. Staff only; a customer gets 403 and nothing is removed.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const blockerId = getRouterParam(event, 'blockerId')!
  const { task, project } = await requireTask(event, id)

  const result = await removeBlocker(project.id, task.id, blockerId, { userId: event.context.session.user.id, audience: project.audience })
  if (!result.ok) throw createError({ statusCode: STATUS[result.reason], message: result.message })

  await publishFromEvent(event, { type: 'board', projectId: project.id })
  return { ok: true, blockerId: result.blockerId }
})
