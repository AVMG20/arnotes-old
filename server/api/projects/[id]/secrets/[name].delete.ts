import { removeSecret, routeVault } from '../../../../utils/projectSecrets'

// Deletes a secret for good. Managers only; the trail keeps the name and who did it.
export default defineEventHandler(async (event) => {
  const { project, userId, role } = await routeVault(event)
  const name = getRouterParam(event, 'name')!
  setHeader(event, 'Cache-Control', 'no-store')

  await removeSecret(project, role, userId, 'ui', name)
  return { removed: true }
})
