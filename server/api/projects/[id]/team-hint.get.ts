import { and, eq } from 'drizzle-orm'
import { db } from '../../../db'
import { member, organization, projects } from '../../../db/schema'

// Where a board that does not open in the current workspace lives. Only a team the
// caller belongs to is named; for anyone else the board stays a plain 404.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const userId = event.context.session.user.id

  const [project] = await db
    .select({ teamId: projects.teamId })
    .from(projects)
    .where(eq(projects.id, id))

  if (!project?.teamId) throw createError({ statusCode: 404, message: 'Project not found' })

  const [membership] = await db
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.organizationId, project.teamId), eq(member.userId, userId)))

  if (!membership) throw createError({ statusCode: 404, message: 'Project not found' })

  const [team] = await db
    .select({ id: organization.id, name: organization.name })
    .from(organization)
    .where(eq(organization.id, project.teamId))

  if (!team) throw createError({ statusCode: 404, message: 'Project not found' })
  return { teamId: team.id, teamName: team.name }
})
