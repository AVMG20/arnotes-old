import { listSecrets, routeVault } from '../../../../utils/projectSecrets'
import { secretsUnavailableReason } from '../../../../utils/secretCrypto'

// The project's secrets by name, never with their values. Managers see every
// secret; anyone else on the project sees the ones shared with members. Says why
// nothing can be stored when the server has no encryption key.
export default defineEventHandler(async (event) => {
  const { project, role } = await routeVault(event)
  setHeader(event, 'Cache-Control', 'no-store')

  const reason = secretsUnavailableReason()
  return {
    enabled: reason === null,
    reason,
    role,
    archived: !!project.archivedAt,
    secrets: await listSecrets(project, role)
  }
})
