import { and, eq, inArray, isNull, or } from 'drizzle-orm'
import { db } from '../db'
import { member, organization, projects } from '../db/schema'
import { customerIdsOf } from './auth-helpers'

/**
 * Boards a person can open in one of their workspaces: every board of a team they are in,
 * their own personal boards, and the boards of a customer they log in for, which open in the
 * personal workspace (as sessionProjectFilter has it).
 */
export async function reachOf(userId: string) {
  const teamIds = (await db.select({ id: member.organizationId }).from(member).where(eq(member.userId, userId))).map(r => r.id)
  const customerIds = await customerIdsOf(userId)
  const filter = or(
    and(eq(projects.userId, userId), isNull(projects.teamId)),
    teamIds.length ? inArray(projects.teamId, teamIds) : undefined,
    customerIds.length ? inArray(projects.customerId, customerIds) : undefined
  )
  return { teamIds: new Set(teamIds), filter }
}

/** The workspace a board opens in: the team when the person is in it, else the personal one (null). */
export function workspaceTeam(teamIds: Set<string>, projectTeamId: string | null): string | null {
  return projectTeamId && teamIds.has(projectTeamId) ? projectTeamId : null
}

/** Where a board opens for this person, or null when they cannot open it at all. */
export async function workspaceOf(userId: string, projectId: string): Promise<{ teamId: string | null, teamName: string | null } | null> {
  const { teamIds, filter } = await reachOf(userId)
  const [row] = await db
    .select({ teamId: projects.teamId, teamName: organization.name })
    .from(projects)
    .leftJoin(organization, eq(organization.id, projects.teamId))
    .where(and(eq(projects.id, projectId), filter))
  if (!row) return null
  const teamId = workspaceTeam(teamIds, row.teamId)
  return { teamId, teamName: teamId ? row.teamName : null }
}
