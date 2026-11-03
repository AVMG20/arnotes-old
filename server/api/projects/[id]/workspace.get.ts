import { workspaceOf } from '../../../utils/workspaces'

// The workspace a board opens in for the caller, from anywhere in the app: the team
// (teamId), or the personal workspace (null). A board they cannot open is a plain 404.
export default defineEventHandler(async (event) => {
  const where = await workspaceOf(event.context.session.user.id, getRouterParam(event, 'id')!)
  if (!where) throw createError({ statusCode: 404, message: 'Project not found' })
  return where
})
