import { revealSecret, routeVault } from '../../../../../utils/projectSecrets'

// Returns one value. This is the only route that does, and each call is recorded in the trail.
export default defineEventHandler(async (event) => {
  const { project, userId, role } = await routeVault(event)
  const name = getRouterParam(event, 'name')!
  setHeader(event, 'Cache-Control', 'no-store')

  return revealSecret(project, role, userId, 'ui', name)
})
