import { and, eq } from 'drizzle-orm'

import { db } from '../../../../../db'
import { projectGithubRepos, VISIBILITIES, type ProjectGithubRepo, type Visibility } from '../../../../../db/schema'
import { parseBranches, parseColumnName, parseLogins, sharedBranch, sharedBranchMessage } from '#shared/utils/githubRepoSync'
import { canManageRepoSync, columnNamesOf, recordRepoAudit, repoSyncView } from '../../../../../utils/githubRepoSync'
import { routeStaffProject, touchProject } from '../../../../../utils/projectResources'
import { catchUpDeliveryId, queueCatchUp, syncSettingsOf } from '../../../../../utils/githubCatchUp'

// Changes one linked repository. `visibility` sets what new links to it get, and
// staff may change it. The issue sync fields (on or off, the column and visibility
// of new cards, accepted logins, branches, complete on close) are for the project
// owner and the team's owners and admins only. The counts the sync keeps (ignored
// issues) are not in this route at all. Each change, and each refused change, is
// written to the audit.
const SYNC_KEYS = [
  'syncEnabled', 'syncColumn', 'syncVisibility', 'acceptedLogins',
  'stagingBranches', 'productionBranches', 'completeOnClose'
] as const

const LABELS = {
  visibility: 'Visibility of new links',
  syncEnabled: 'Issue sync',
  syncColumn: 'Column for new cards',
  syncVisibility: 'Visibility of new cards',
  acceptedLogins: 'Accepted logins',
  stagingBranches: 'Staging branches',
  productionBranches: 'Production branches',
  completeOnClose: 'Complete the card when its issue closes'
} as const

// The branch names of a stored, comma separated value.
function listOf(text: string): string[] {
  return text.split(',').map(part => part.trim()).filter(Boolean)
}

// What changed, in words both sides can read: the field's label and the value before and after.
function changes(before: ProjectGithubRepo, after: ProjectGithubRepo) {
  const shown = (row: ProjectGithubRepo) => ({
    visibility: row.visibility === 'customer' ? 'Shared with customer' : 'Team only',
    syncEnabled: row.syncEnabled ? 'on' : 'off',
    syncColumn: row.syncColumn,
    syncVisibility: row.syncVisibility === 'customer' ? 'Shared with customer' : 'Team only',
    acceptedLogins: row.acceptedLogins.join(', ') || 'none',
    stagingBranches: row.stagingBranches || 'none',
    productionBranches: row.productionBranches || 'the default branch',
    completeOnClose: row.completeOnClose ? 'on' : 'off'
  })
  const from = shown(before)
  const to = shown(after)
  const detail: Record<string, { from: string, to: string }> = {}
  for (const key of Object.keys(LABELS) as (keyof typeof LABELS)[]) {
    if (from[key] !== to[key]) detail[LABELS[key]] = { from: from[key], to: to[key] }
  }
  return detail
}

export default defineEventHandler(async (event) => {
  const project = await routeStaffProject(event)
  const repoId = getRouterParam(event, 'repoId')!
  const userId = event.context.session.user.id
  const body = (await readBody<Record<string, unknown>>(event)) ?? {}

  // Read first, scoped to this project: a repository of another project is not found.
  const [row] = await db
    .select()
    .from(projectGithubRepos)
    .where(and(eq(projectGithubRepos.id, repoId), eq(projectGithubRepos.projectId, project.id)))
  if (!row) throw createError({ statusCode: 404, message: 'Repository not found' })
  const fullName = `${row.owner}/${row.repo}`

  // A refused change is audited with who asked and why it was not done, then answered.
  // The field name travels with the answer so the form can put the words by that field.
  async function refusal(statusCode: 400 | 403, message: string, field: string, labels: string[]): Promise<ReturnType<typeof createError>> {
    await recordRepoAudit(project.id, fullName, userId, Object.fromEntries(
      labels.map(label => [`Refused: ${label}`, { from: '', to: message.slice(0, 120) }])
    ))
    return createError({ statusCode, message, data: { field } })
  }

  const touched = SYNC_KEYS.filter(key => body[key] !== undefined)
  if (touched.length > 0 && !(await canManageRepoSync(project, userId))) {
    throw await refusal(
      403,
      'Only the project owner and the team\'s owners and admins can change issue sync and branch settings',
      touched[0]!,
      touched.map(key => LABELS[key])
    )
  }

  if (body.visibility !== undefined && !VISIBILITIES.includes(body.visibility as Visibility)) {
    throw await refusal(400, 'Unknown visibility', 'visibility', [LABELS.visibility])
  }

  const patch: Partial<typeof projectGithubRepos.$inferInsert> = {}
  if (body.visibility !== undefined) patch.visibility = body.visibility as Visibility

  if (body.syncEnabled !== undefined) {
    if (typeof body.syncEnabled !== 'boolean') {
      throw await refusal(400, 'Say whether issue sync is on or off', 'syncEnabled', [LABELS.syncEnabled])
    }
    patch.syncEnabled = body.syncEnabled
  }
  if (body.syncColumn !== undefined) {
    const column = parseColumnName(body.syncColumn, await columnNamesOf(project.id))
    if (!column.ok) throw await refusal(400, column.message, 'syncColumn', [LABELS.syncColumn])
    patch.syncColumn = column.value
  }
  if (body.syncVisibility !== undefined) {
    if (!VISIBILITIES.includes(body.syncVisibility as Visibility)) {
      throw await refusal(400, 'Unknown visibility for new cards', 'syncVisibility', [LABELS.syncVisibility])
    }
    patch.syncVisibility = body.syncVisibility as Visibility
  }
  if (body.acceptedLogins !== undefined) {
    const logins = parseLogins(body.acceptedLogins)
    if (!logins.ok) throw await refusal(400, logins.message, 'acceptedLogins', [LABELS.acceptedLogins])
    patch.acceptedLogins = logins.value
  }

  let stagingNames = listOf(row.stagingBranches)
  let productionNames = listOf(row.productionBranches)
  if (body.stagingBranches !== undefined) {
    const staging = parseBranches(body.stagingBranches, 'Staging')
    if (!staging.ok) throw await refusal(400, staging.message, 'stagingBranches', [LABELS.stagingBranches])
    stagingNames = staging.value
    patch.stagingBranches = staging.value.join(', ')
  }
  if (body.productionBranches !== undefined) {
    const production = parseBranches(body.productionBranches, 'Production')
    if (!production.ok) throw await refusal(400, production.message, 'productionBranches', [LABELS.productionBranches])
    productionNames = production.value
    patch.productionBranches = production.value.join(', ')
  }
  const both = sharedBranch(stagingNames, productionNames)
  if (both && (body.stagingBranches !== undefined || body.productionBranches !== undefined)) {
    throw await refusal(400, sharedBranchMessage(both), 'productionBranches', [LABELS.productionBranches])
  }

  if (body.completeOnClose !== undefined) {
    if (typeof body.completeOnClose !== 'boolean') {
      throw await refusal(400, 'Say whether closing the issue completes the card', 'completeOnClose', [LABELS.completeOnClose])
    }
    patch.completeOnClose = body.completeOnClose
  }

  // A repository whose logins were never filled in takes its owner's login the
  // first time its sync settings are saved.
  if (touched.length > 0 && row.acceptedLogins.length === 0 && patch.acceptedLogins === undefined) {
    const owner = parseLogins(row.owner)
    if (owner.ok) patch.acceptedLogins = owner.value
  }

  const [updated] = Object.keys(patch).length
    ? await db.update(projectGithubRepos).set(patch).where(eq(projectGithubRepos.id, row.id)).returning()
    : [row]

  // Visibility keeps its old audit line too: it is a setting like the others.
  // Switching issue sync on queues a catch-up of the open issues (GH5). A queue that cannot take it does not undo the
  // switch: the owner can press "Catch up now" again.
  if (patch.syncEnabled === true && !row.syncEnabled) {
    try {
      await queueCatchUp(updated!, catchUpDeliveryId(row.id, Date.now(), syncSettingsOf(updated!)))
    } catch (error) {
      console.error(`GitHub catch-up for ${fullName} could not be queued (${error instanceof Error ? error.name : 'non-Error'})`)
    }
  }

  await recordRepoAudit(project.id, fullName, userId, changes(row, updated!))
  await touchProject(event, project.id)
  return {
    id: updated!.id,
    fullName,
    visibility: updated!.visibility,
    sync: repoSyncView(updated!)
  }
})
