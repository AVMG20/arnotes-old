import { routeVault, saveSecret, secretInputOf } from '../../../../utils/projectSecrets'

// Adds a secret. The name must be new; managers only.
export default defineEventHandler(async (event) => {
  const { project, userId, role } = await routeVault(event)
  const body = await readBody(event)
  setHeader(event, 'Cache-Control', 'no-store')

  const { secret } = await saveSecret(project, role, userId, 'ui', secretInputOf(body), 'create')
  return secret
})
