import { listPins, unpinBoard } from '../../utils/boardPins'

// Unpins a board for the caller. Nothing to find is not an error: the pin is gone either way.
export default defineEventHandler(async (event) => {
  const userId = event.context.session.user.id
  await unpinBoard(userId, getRouterParam(event, 'projectId')!)
  return listPins(userId)
})
