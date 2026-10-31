import { changeProjectMember, projectPersonRow, routeMembers } from '../../../../utils/projectMembers'

// Changes the role of a person who has a project role row. Answers the person's row.
export default defineEventHandler(async (event) => {
  const { project, userId } = await routeMembers(event)
  const targetUserId = getRouterParam(event, 'userId')!
  const body = (await readBody<{ role?: unknown }>(event)) ?? {}

  await changeProjectMember(project, userId, 'ui', targetUserId, body.role)
  return projectPersonRow(project, targetUserId)
})
