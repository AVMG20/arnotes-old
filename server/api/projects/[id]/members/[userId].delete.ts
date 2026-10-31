import { removeProjectMember, routeMembers } from '../../../../utils/projectMembers'

// Takes a person's project role away. Their team role, if they have one, still stands.
export default defineEventHandler(async (event) => {
  const { project, userId } = await routeMembers(event)
  await removeProjectMember(project, userId, 'ui', getRouterParam(event, 'userId')!)
  return { removed: true }
})
