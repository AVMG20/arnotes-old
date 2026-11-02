import { asc, eq } from 'drizzle-orm'
import { db } from '../../../../db'
import { projectGithubRepos, projectGithubSettings } from '../../../../db/schema'
import { canManageRepoSync, columnNamesOf, recentRepoAudit, repoSyncView } from '../../../../utils/githubRepoSync'
import { routeStaffProject } from '../../../../utils/projectResources'

// The repositories a project links issues and pull requests from, with the one
// `#123` means marked as the default, and each one's issue sync settings. Staff
// only, like the other GitHub settings. `canManage` says whether this person may
// change the sync settings; everyone else sees them read-only.
export default defineEventHandler(async (event) => {
  const project = await routeStaffProject(event)
  const [settings] = await db
    .select()
    .from(projectGithubSettings)
    .where(eq(projectGithubSettings.projectId, project.id))
  const rows = await db
    .select()
    .from(projectGithubRepos)
    .where(eq(projectGithubRepos.projectId, project.id))
    .orderBy(asc(projectGithubRepos.createdAt))

  const defaultRepo = settings?.defaultRepo ?? null
  return {
    defaultRepo,
    defaultVisibility: settings?.defaultVisibility ?? 'internal',
    canManage: await canManageRepoSync(project, event.context.session.user.id),
    columns: await columnNamesOf(project.id),
    audit: await recentRepoAudit(project.id),
    repos: rows.map((row) => {
      const fullName = `${row.owner}/${row.repo}`
      return {
        id: row.id,
        fullName,
        visibility: row.visibility,
        isDefault: defaultRepo !== null && defaultRepo.toLowerCase() === fullName.toLowerCase(),
        createdAt: row.createdAt,
        sync: repoSyncView(row)
      }
    })
  }
})
