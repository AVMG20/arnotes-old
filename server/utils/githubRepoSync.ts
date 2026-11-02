// The server side of a linked repository's issue sync settings: who may change
// them, how a row is read back, and the audit line each change leaves. The rules
// for the values themselves are in shared/utils/githubRepoSync.ts.
import { and, desc, eq, isNull } from 'drizzle-orm'
import { db } from '../db'
import { member, projectColumns, projectGithubAudit, user } from '../db/schema'
import type { ProjectGithubRepo } from '../db/schema'
import { managesRepoSync, type RepoSyncSettings } from '#shared/utils/githubRepoSync'
import { genId } from './projects'

// Whether this person may change the settings, read from their team membership now.
export async function canManageRepoSync(project: { userId: string, teamId: string | null }, userId: string): Promise<boolean> {
  let teamRoles: string[] | null = null
  if (project.teamId) {
    const [membership] = await db
      .select({ role: member.role })
      .from(member)
      .where(and(eq(member.organizationId, project.teamId), eq(member.userId, userId)))
    teamRoles = membership ? membership.role.split(',') : null
  }
  return managesRepoSync({
    personal: !project.teamId,
    isProjectOwner: project.userId === userId,
    teamRoles
  })
}

/** The names of the board's live columns, in board order. */
export async function columnNamesOf(projectId: string): Promise<string[]> {
  const rows = await db
    .select({ name: projectColumns.name })
    .from(projectColumns)
    .where(and(eq(projectColumns.projectId, projectId), isNull(projectColumns.deletedAt)))
    .orderBy(projectColumns.position)
  return rows.map(row => row.name)
}

/** A linked repository's sync settings as the form reads them. */
export function repoSyncView(row: ProjectGithubRepo): RepoSyncSettings {
  return {
    enabled: row.syncEnabled,
    column: row.syncColumn,
    visibility: row.syncVisibility,
    acceptedLogins: row.acceptedLogins,
    ignoredCount: row.ignoredCount,
    lastIgnored: row.lastIgnored ?? null,
    stagingBranches: row.stagingBranches,
    productionBranches: row.productionBranches,
    completeOnClose: row.completeOnClose
  }
}

/** Writes one audit line: what changed or was refused, from what, to what. Never a secret. */
export async function recordRepoAudit(
  projectId: string,
  repo: string,
  userId: string,
  detail: Record<string, { from: string, to: string }>
): Promise<void> {
  if (Object.keys(detail).length === 0) return
  await db.insert(projectGithubAudit).values({
    id: genId(),
    projectId,
    repo,
    detail,
    userId,
    createdAt: Date.now()
  })
}

/** The latest audit lines of a project, newest first, with who made each change. */
export async function recentRepoAudit(projectId: string, limit = 10) {
  const rows = await db
    .select({
      id: projectGithubAudit.id,
      repo: projectGithubAudit.repo,
      detail: projectGithubAudit.detail,
      userName: user.name,
      createdAt: projectGithubAudit.createdAt
    })
    .from(projectGithubAudit)
    .leftJoin(user, eq(user.id, projectGithubAudit.userId))
    .where(eq(projectGithubAudit.projectId, projectId))
    .orderBy(desc(projectGithubAudit.createdAt))
    .limit(limit)
  return rows.map(row => ({ ...row, userName: row.userName ?? 'Someone who has left the team' }))
}
