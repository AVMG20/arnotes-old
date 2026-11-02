import type { H3Event } from 'h3'
import { randomInt } from 'crypto'
import { db } from '../db'
import { customerMembers, member, projects, projectTasks, taskComments } from '../db/schema'
import { eq, and, inArray, isNull, or } from 'drizzle-orm'
import { CUSTOMER_COMMENT_VISIBILITY } from './commentVisibility'

export async function getUserActiveTeamId(event: H3Event): Promise<string | null> {
  const session = event.context.session
  if (!session) return null

  const activeOrgId = session.session?.activeOrganizationId || null
  if (!activeOrgId) return null

  // Verify membership
  const userId = session.user.id
  const [membership] = await db
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.organizationId, activeOrgId), eq(member.userId, userId)))

  if (!membership) return null
  return activeOrgId
}

const TEAM_ADMIN_ROLES = ['owner', 'admin']

export async function requireTeamRole(event: H3Event, organizationId: string, allowedRoles: string[] = TEAM_ADMIN_ROLES) {
  const session = event.context.session
  if (!session) throw createError({ statusCode: 401, message: 'Unauthorized' })

  const userId = session.user.id
  const [membership] = await db
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, organizationId), eq(member.userId, userId)))

  if (!membership || !allowedRoles.includes(membership.role)) {
    throw createError({ statusCode: 403, message: 'You do not have permission to do this' })
  }

  return membership
}

export async function isTeamMember(userId: string, organizationId: string): Promise<boolean> {
  const [membership] = await db
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.organizationId, organizationId), eq(member.userId, userId)))

  return Boolean(membership)
}

/**
 * Scopes a project query to one workspace: every board of the given team, or only the
 * user's own team-less boards when there is no team.
 */
export function projectAccessFilter(userId: string, teamId: string | null) {
  return teamId
    ? eq(projects.teamId, teamId)
    : and(eq(projects.userId, userId), isNull(projects.teamId))
}

/** The customers a user logs in for, as a contact. */
export async function customerIdsOf(userId: string): Promise<string[]> {
  const rows = await db
    .select({ customerId: customerMembers.customerId })
    .from(customerMembers)
    .where(eq(customerMembers.userId, userId))
  return rows.map(r => r.customerId)
}

/**
 * Projects a browser session can reach: `projectAccessFilter`, plus — in the
 * personal workspace — the projects of every customer the user is a contact of.
 *
 * API keys use it too (see mcpAccess.ts) and filter what they read by the same
 * audience rule, so an agent sees what its person sees. The in-app assistant
 * keeps using `projectAccessFilter`: its output is not filtered by visibility,
 * so a customer project is not reachable through it.
 */
export function sessionProjectFilter(userId: string, teamId: string | null, customerIds: string[]) {
  const own = projectAccessFilter(userId, teamId)
  if (teamId || !customerIds.length) return own
  return or(own, inArray(projects.customerId, customerIds))
}

/**
 * How the caller relates to a project they can reach. Staff see everything;
 * a customer contact sees only what is marked visible to customers.
 */
export type Audience = 'staff' | 'customer'

export function audienceFor(
  userId: string,
  activeTeamId: string | null,
  project: { userId: string, teamId: string | null }
): Audience {
  if (activeTeamId && project.teamId === activeTeamId) return 'staff'
  if (!project.teamId && project.userId === userId) return 'staff'
  return 'customer'
}

/** Narrows a task query to what the audience may read; staff read everything. */
export function taskVisibilityFilter(audience: Audience) {
  return audience === 'customer' ? eq(projectTasks.visibility, 'customer') : undefined
}

/** The same rule for comments. */
export function commentVisibilityFilter(audience: Audience) {
  return audience === 'customer' ? eq(taskComments.visibility, CUSTOMER_COMMENT_VISIBILITY) : undefined
}

const JOIN_CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // no I/L/O/0/1 — avoids visual ambiguity

// A join code grants access to every board in a team, so it must not be guessable.
export function generateJoinCode(length = 16): string {
  let code = ''
  for (let i = 0; i < length; i++) {
    code += JOIN_CODE_CHARS[randomInt(JOIN_CODE_CHARS.length)]
  }
  return code
}

// Users retype codes with spaces or dashes; normalise before comparing.
export function normalizeJoinCode(raw: string): string {
  return raw.replace(/[\s-]/g, '').toUpperCase()
}
