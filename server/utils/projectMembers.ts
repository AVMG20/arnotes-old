// Who may manage and read a project's secrets. A project's members are the people
// the team already shares with, plus the explicit project_members rows that give a
// team member a vault role. The project owner and the team's owners and admins are
// managers without a row; anyone else on the team needs a row, and anyone else
// gets nothing.
import type { H3Event } from 'h3'
import { and, asc, eq, sql } from 'drizzle-orm'
import { db } from '../db'
import { member, PROJECT_ROLES, projectMembers, user } from '../db/schema'
import type { ProjectRole } from '../db/schema'
import { genId } from './projects'
import { routeProject } from './projectResources'
import { recordVaultEvent } from './projectSecrets'

export type VaultRole = 'manager' | 'member'

/** The vault role a person has on a project, or null when they have none. */
export async function vaultRoleOf(
  project: { id: string, userId: string, teamId: string | null },
  userId: string
): Promise<VaultRole | null> {
  // A personal project has only its owner, and they manage it.
  if (!project.teamId) return project.userId === userId ? 'manager' : null

  // Everyone above needs to be on the team: leaving the team ends any vault role.
  const [membership] = await db
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, project.teamId), eq(member.userId, userId)))
  if (!membership) return null

  if (membership.role === 'owner' || membership.role === 'admin') return 'manager'
  if (project.userId === userId) return 'manager'

  const [row] = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, userId)))
  return row ? (row.role === 'manager' ? 'manager' : 'member') : null
}

export interface ProjectPersonRow {
  id: string
  name: string
  email: string
  image: string | null
  // The team role: a personal project's owner is listed as 'owner'.
  teamRole: 'owner' | 'admin' | 'member'
  isProjectOwner: boolean
  // The effective vault role, or null for nobody.
  role: VaultRole | null
  // Whether the role comes from a project_members row, so it can be changed or removed.
  explicit: boolean
}

type MemberProject = { id: string, userId: string, teamId: string | null, archivedAt?: number | null }

const NOT_MANAGER = 'Only a project manager can change who is on the project'

function effectiveRole(manager: boolean, row: ProjectRole | null): VaultRole | null {
  if (manager) return 'manager'
  return row ? 'member' : null
}

/** Every team member, the project owner first. A personal project lists only its owner. */
export async function listProjectPeople(project: MemberProject): Promise<ProjectPersonRow[]> {
  const columns = { id: user.id, name: user.name, email: user.email, image: user.image }
  const people = project.teamId
    ? await db.select({ ...columns, teamRole: member.role }).from(member)
        .innerJoin(user, eq(user.id, member.userId))
        .where(eq(member.organizationId, project.teamId))
        .orderBy(asc(user.name))
    : await db.select({ ...columns, teamRole: sql<string>`'owner'` }).from(user)
        .where(eq(user.id, project.userId))

  const rows = await db.select().from(projectMembers).where(eq(projectMembers.projectId, project.id))
  const rowRoles = new Map(rows.map(row => [row.userId, row.role]))

  return people
    .map((person) => {
      const isProjectOwner = person.id === project.userId
      const teamRole = person.teamRole === 'owner' || person.teamRole === 'admin' ? (person.teamRole as 'owner' | 'admin') : ('member' as const)
      const row = rowRoles.get(person.id) ?? null
      return {
        id: person.id,
        name: person.name,
        email: person.email,
        image: person.image,
        teamRole,
        isProjectOwner,
        role: effectiveRole(isProjectOwner || teamRole !== 'member' || row === 'manager', row),
        explicit: row !== null
      }
    })
    .sort((a, b) => Number(b.isProjectOwner) - Number(a.isProjectOwner))
}

/** One person's row, as the members API returns it after a change. */
export async function projectPersonRow(project: MemberProject, userId: string): Promise<ProjectPersonRow | null> {
  return (await listProjectPeople(project)).find(person => person.id === userId) ?? null
}

/** The project a members route works on, with the caller's vault role. Customers' contacts get a 404. */
export async function routeMembers(event: H3Event) {
  const project = await routeProject(event)
  if (project.audience !== 'staff') throw createError({ statusCode: 404, message: 'Project not found' })
  const userId = event.context.session.user.id
  return { project, userId, role: await vaultRoleOf(project, userId) }
}

async function requireManager(project: MemberProject, actorId: string) {
  if (await vaultRoleOf(project, actorId) !== 'manager') throw createError({ statusCode: 403, message: NOT_MANAGER })
}

function requireWritable(project: MemberProject) {
  if (project.archivedAt) throw createError({ statusCode: 409, message: 'This project is archived. Unarchive it to change who is on it.' })
}

function parseRole(role: unknown): ProjectRole {
  if (typeof role !== 'string' || !(PROJECT_ROLES as readonly string[]).includes(role)) {
    throw createError({ statusCode: 400, message: 'Role must be manager or member' })
  }
  return role as ProjectRole
}

async function explicitRow(projectId: string, userId: string) {
  const [row] = await db.select().from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
  return row
}

async function nameOf(userId: string): Promise<string> {
  const [row] = await db.select({ name: user.name, email: user.email }).from(user).where(eq(user.id, userId))
  return row?.name || row?.email || userId
}

/** Adds a team member to the project in a role. Team owners and admins, and the project owner, already manage it. */
export async function addProjectMember(
  project: MemberProject,
  actorId: string,
  via: 'ui' | 'mcp',
  targetUserId: string,
  role: unknown
): Promise<void> {
  await requireManager(project, actorId)
  requireWritable(project)
  const roleValue = parseRole(role)
  if (!project.teamId) throw createError({ statusCode: 400, message: 'Members need a team project' })

  const [membership] = await db.select({ role: member.role }).from(member)
    .where(and(eq(member.organizationId, project.teamId), eq(member.userId, targetUserId)))
  if (!membership) throw createError({ statusCode: 400, message: 'That person is not on the team' })
  if (membership.role === 'owner' || membership.role === 'admin' || targetUserId === project.userId) {
    throw createError({ statusCode: 400, message: 'That person already manages the project through the team or its ownership' })
  }
  if (await explicitRow(project.id, targetUserId)) {
    throw createError({ statusCode: 409, message: 'That person is already a project member' })
  }

  await db.insert(projectMembers).values({
    id: genId(),
    projectId: project.id,
    userId: targetUserId,
    role: roleValue,
    addedBy: actorId,
    createdAt: Date.now()
  })
  await recordVaultEvent(project.id, actorId, via, 'member_add', await nameOf(targetUserId))
}

/** Changes the role of someone who has a project_members row. */
export async function changeProjectMember(
  project: MemberProject,
  actorId: string,
  via: 'ui' | 'mcp',
  targetUserId: string,
  role: unknown
): Promise<void> {
  await requireManager(project, actorId)
  requireWritable(project)
  const roleValue = parseRole(role)

  const row = await explicitRow(project.id, targetUserId)
  if (!row) throw createError({ statusCode: 404, message: 'That person is not an explicit project member' })

  await db.update(projectMembers).set({ role: roleValue }).where(eq(projectMembers.id, row.id))
  await recordVaultEvent(project.id, actorId, via, 'member_change', await nameOf(targetUserId))
}

/** Takes someone's project_members row away. Their team role, if any, still stands. */
export async function removeProjectMember(
  project: MemberProject,
  actorId: string,
  via: 'ui' | 'mcp',
  targetUserId: string
): Promise<void> {
  await requireManager(project, actorId)
  requireWritable(project)

  const row = await explicitRow(project.id, targetUserId)
  if (!row) throw createError({ statusCode: 404, message: 'That person is not an explicit project member' })

  await db.delete(projectMembers).where(eq(projectMembers.id, row.id))
  await recordVaultEvent(project.id, actorId, via, 'member_remove', await nameOf(targetUserId))
}
