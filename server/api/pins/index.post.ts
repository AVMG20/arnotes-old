import { listPins, pinBoard } from '../../utils/boardPins'

// Pins a board for the caller only. Answers with the whole list, so the sidebar shows it in place.
export default defineEventHandler(async (event) => {
  const userId = event.context.session.user.id
  const body = await readBody<{ projectId?: unknown }>(event)
  if (typeof body?.projectId !== 'string' || !body.projectId) throw createError({ statusCode: 400, message: 'Say which board to pin' })
  await pinBoard(userId, body.projectId)
  return listPins(userId)
})
