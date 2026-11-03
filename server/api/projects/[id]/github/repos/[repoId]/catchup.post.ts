import { and, eq } from 'drizzle-orm'
import { db } from '../../../../../../db'
import { projectGithubRepos } from '../../../../../../db/schema'
import { canManageRepoSync } from '../../../../../../utils/githubRepoSync'
import { catchUpDeliveryId, CatchUpNotQueued, queueCatchUp, QUEUE_UNAVAILABLE, syncSettingsOf } from '../../../../../../utils/githubCatchUp'
import { ownerAllowed } from '../../../../../../utils/githubAllow'
import { routeStaffProject } from '../../../../../../utils/projectResources'

// "Catch up now": queues a catch-up of the open issues of one linked repository. The cards are made by the
// consumer, not on this request, so the answer says only that the job is queued.
export default defineEventHandler(async (event) => {
  const project = await routeStaffProject(event)
  const repoId = getRouterParam(event, 'repoId')!
  const userId = event.context.session.user.id

  if (!(await canManageRepoSync(project, userId))) {
    throw createError({ statusCode: 403, message: 'Only the project owner and the team\'s owners and admins can run a catch-up' })
  }

  const [row] = await db
    .select()
    .from(projectGithubRepos)
    .where(and(eq(projectGithubRepos.id, repoId), eq(projectGithubRepos.projectId, project.id)))
  if (!row) throw createError({ statusCode: 404, message: 'Repository not found' })

  const allowed = ownerAllowed(row.owner)
  if (!allowed.ok) throw createError({ statusCode: 403, message: allowed.message })
  if (!row.syncEnabled) throw createError({ statusCode: 400, message: 'Turn issue sync on first, then catch up' })

  if (!process.env.GITHUB_TOKEN?.trim()) {
    return { queued: false, reason: 'no_token', message: 'No GitHub token on the server, catch-up skipped.' }
  }

  // The settings as they are now: a new catch-up of the same settings in the same millisecond is still one job.
  const deliveryId = catchUpDeliveryId(row.id, Date.now(), syncSettingsOf(row))
  let outcome: 'queued' | 'already'
  try {
    outcome = await queueCatchUp(row, deliveryId)
  } catch (error) {
    if (error instanceof CatchUpNotQueued) throw createError({ statusCode: 503, message: QUEUE_UNAVAILABLE })
    throw error
  }
  if (outcome === 'already') {
    setResponseStatus(event, 202)
    return { queued: false, reason: 'already_queued', message: 'A catch-up of this repository is already queued.' }
  }
  return { queued: true, reason: 'queued', message: 'Catch-up queued. The cards for open issues appear within a minute.' }
})
