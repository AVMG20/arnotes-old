import { exportEnv, routeVault } from '../../../../utils/projectSecrets'

// The .env text of the secrets this person may read, all of them or the `names` asked for.
// Sent as a file download; each download is recorded in the trail.
export default defineEventHandler(async (event) => {
  const { project, userId, role } = await routeVault(event)
  const body = await readBody<{ names?: unknown }>(event)
  const names = body?.names
  if (names !== undefined && (!Array.isArray(names) || names.some(name => typeof name !== 'string'))) {
    throw createError({ statusCode: 400, message: 'Give the names as a list of variable names.' })
  }

  const { env } = await exportEnv(project, role, userId, 'ui', names as string[] | undefined)
  setHeader(event, 'Content-Type', 'text/plain; charset=utf-8')
  setHeader(event, 'Content-Disposition', 'attachment; filename=".env"')
  setHeader(event, 'Cache-Control', 'no-store')
  return env
})
