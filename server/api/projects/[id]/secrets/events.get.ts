import { listVaultEvents, routeVault } from '../../../../utils/projectSecrets'

// The trail of who created, changed, deleted, revealed or downloaded what. Managers only.
export default defineEventHandler(async (event) => {
  const { project, role } = await routeVault(event)
  setHeader(event, 'Cache-Control', 'no-store')

  return { events: await listVaultEvents(project, role) }
})
