import { routeVault, saveSecret, secretInputOf } from '../../../../utils/projectSecrets'

// Changes a secret. Without `value` the stored value is kept, so an edit never
// needs the value retyped. Managers only.
export default defineEventHandler(async (event) => {
  const { project, userId, role } = await routeVault(event)
  const name = getRouterParam(event, 'name')!
  const body = await readBody(event)
  setHeader(event, 'Cache-Control', 'no-store')

  const { secret } = await saveSecret(project, role, userId, 'ui', secretInputOf({ ...body, name }), 'update')
  return secret
})
