import { and, asc, eq, isNull } from 'drizzle-orm'
import { db } from '../db'
import { boardPins, customers, organization, projects } from '../db/schema'
import { reachOf, workspaceTeam } from './workspaces'

/** A pinned board, with the workspace it opens in: a team, or the personal workspace (null). */
export interface PinnedBoard {
  projectId: string
  name: string
  customerName: string | null
  teamId: string | null
  teamName: string | null
}

/** The person's pins, oldest first; archived boards and boards they can no longer open are left out. */
export async function listPins(userId: string): Promise<PinnedBoard[]> {
  const { teamIds, filter } = await reachOf(userId)
  const rows = await db
    .select({
      projectId: projects.id,
      name: projects.name,
      teamId: projects.teamId,
      teamName: organization.name,
      customerName: customers.name
    })
    .from(boardPins)
    .innerJoin(projects, eq(projects.id, boardPins.projectId))
    .leftJoin(organization, eq(organization.id, projects.teamId))
    .leftJoin(customers, eq(customers.id, projects.customerId))
    .where(and(eq(boardPins.userId, userId), isNull(projects.archivedAt), filter))
    .orderBy(asc(boardPins.createdAt))

  return rows.map((row) => {
    const teamId = workspaceTeam(teamIds, row.teamId)
    return { ...row, teamId, teamName: teamId ? row.teamName : null }
  })
}

/** Pins a board the person can open; 404 for any other, so a foreign id says nothing. */
export async function pinBoard(userId: string, projectId: string) {
  const { filter } = await reachOf(userId)
  const [project] = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, projectId), filter))
  if (!project) throw createError({ statusCode: 404, message: 'Project not found' })
  await db.insert(boardPins).values({ userId, projectId, createdAt: Date.now() }).onConflictDoNothing()
}

export async function unpinBoard(userId: string, projectId: string) {
  await db.delete(boardPins).where(and(eq(boardPins.userId, userId), eq(boardPins.projectId, projectId)))
}
