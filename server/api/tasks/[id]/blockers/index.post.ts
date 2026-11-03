import { requireTask } from '../../../../utils/projects'
import { addBlocker, blockerIdFrom } from '../../../../utils/taskDependencyService'
import type { BlockerRefusal } from '../../../../utils/taskDependencyService'
import { publishFromEvent } from '../../../../utils/realtime'

const STATUS: Record<BlockerRefusal['reason'], number> = {
  not_staff: 403,
  not_found: 404,
  self: 400,
  duplicate: 409,
  cycle: 409
}

// Makes this task wait for another task on the same board. Staff only.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const { task, project } = await requireTask(event, id)
  const body = await readBody(event).catch(() => undefined)
  const blockerId = blockerIdFrom(body)
  if (!blockerId) {
    throw createError({ statusCode: 400, message: 'Give the id of the task this one waits for as "blockerId"' })
  }

  const result = await addBlocker(project.id, task.id, blockerId, { userId: event.context.session.user.id, audience: project.audience })
  if (!result.ok) throw createError({ statusCode: STATUS[result.reason], message: result.message })

  await publishFromEvent(event, { type: 'board', projectId: project.id })
  setResponseStatus(event, 201)
  return result.link
})
