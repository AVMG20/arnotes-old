import { eq } from 'drizzle-orm'
import { db } from '../../../../db'
import { projectGithubRepos, projectGithubSettings, VISIBILITIES, type Visibility } from '../../../../db/schema'
import { parseLogins } from '#shared/utils/githubRepoSync'
import { ownerAllowed } from '../../../../utils/githubAllow'
import { isGithubRefError, parseGithubRef } from '../../../../utils/githubRef'
import { genId } from '../../../../utils/projects'
import { routeStaffProject, touchProject } from '../../../../utils/projectResources'

// Links a repository to the project. The first link becomes the default when the
// project has none, so `#123` works at once; `makeDefault` moves the default to it.
// Without a visibility, the project's default visibility for new links applies.
// Issue sync starts off, accepting the repository owner's login.
const MAX_REPOS_PER_PROJECT = 20

export default defineEventHandler(async (event) => {
  const project = await routeStaffProject(event)
  const body = await readBody<{ repo?: unknown, visibility?: unknown, makeDefault?: unknown }>(event)

  // Strict owner/repo, then the shared parser checks the names the same way it
  // checks pasted links. The `#1` is a stand-in issue number for that check.
  const text = typeof body.repo === 'string' ? body.repo.trim() : ''
  if (!/^[^\s/#]+\/[^\s/#]+$/.test(text)) {
    throw createError({ statusCode: 400, message: 'Write the repository as owner/repo' })
  }
  const parsed = parseGithubRef(`${text}#1`)
  if (isGithubRefError(parsed)) throw createError({ statusCode: 400, message: parsed.message })
  const fullName = `${parsed.owner}/${parsed.repo}`

  const allowed = ownerAllowed(parsed.owner)
  if (!allowed.ok) throw createError({ statusCode: 403, message: allowed.message })

  if (body.visibility !== undefined && !VISIBILITIES.includes(body.visibility as Visibility)) {
    throw createError({ statusCode: 400, message: 'Unknown visibility' })
  }
  if (body.makeDefault !== undefined && typeof body.makeDefault !== 'boolean') {
    throw createError({ statusCode: 400, message: 'Say whether this repository is the default' })
  }

  const [settings] = await db
    .select()
    .from(projectGithubSettings)
    .where(eq(projectGithubSettings.projectId, project.id))
  const linked = await db
    .select()
    .from(projectGithubRepos)
    .where(eq(projectGithubRepos.projectId, project.id))

  // GitHub names do not care about case, so `Acme/Web` and `acme/web` are one repo.
  if (linked.some(row => `${row.owner}/${row.repo}`.toLowerCase() === fullName.toLowerCase())) {
    throw createError({ statusCode: 409, message: `${fullName} is already linked to this project` })
  }
  if (linked.length >= MAX_REPOS_PER_PROJECT) {
    throw createError({ statusCode: 400, message: `A project can link at most ${MAX_REPOS_PER_PROJECT} repositories; remove one first` })
  }

  const visibility = (body.visibility as Visibility | undefined) ?? settings?.defaultVisibility ?? 'internal'
  const makeDefault = body.makeDefault === true || !settings?.defaultRepo

  // The owner's login is accepted from the start. An owner name that is not a
  // valid login accepts nobody until the owner adds one.
  const owner = parseLogins(parsed.owner)

  const [created] = await db.insert(projectGithubRepos).values({
    id: genId(),
    projectId: project.id,
    owner: parsed.owner,
    repo: parsed.repo,
    visibility,
    acceptedLogins: owner.ok ? owner.value : [],
    createdAt: Date.now()
  }).returning()

  if (makeDefault) {
    await db.insert(projectGithubSettings)
      .values({ projectId: project.id, defaultRepo: fullName, defaultVisibility: settings?.defaultVisibility ?? 'internal' })
      .onConflictDoUpdate({ target: projectGithubSettings.projectId, set: { defaultRepo: fullName } })
  }

  await touchProject(event, project.id)
  return {
    id: created!.id,
    fullName,
    visibility: created!.visibility,
    isDefault: makeDefault,
    defaultRepo: makeDefault ? fullName : (settings?.defaultRepo ?? null)
  }
})
