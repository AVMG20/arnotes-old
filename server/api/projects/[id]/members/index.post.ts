import { addProjectMember, projectPersonRow, routeMembers } from '../../../../utils/projectMembers'

// Adds a team member to the project as a manager or a member. The answer is the
// person's row, as the list shows it now.
export default defineEventHandler(async (event) => {
  const { project, userId } = await routeMembers(event)
  const body = (await readBody<{ userId?: unknown, role?: unknown }>(event)) ?? {}
  if (typeof body.userId !== 'string' || !body.userId) {
    throw createError({ statusCode: 400, message: 'Say which person to add' })
  }

  await addProjectMember(project, userId, 'ui', body.userId, body.role)
  return projectPersonRow(project, body.userId)
})
