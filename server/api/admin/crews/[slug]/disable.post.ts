import { audited, crewBySlug, disableCrew } from '../../../../utils/crewProvisioning'
import { requireInstanceAdmin } from '../../../../utils/instanceAdmin'

// Cuts a crew off at once from the instance admin's Crews page: its keys are revoked, its
// sessions ended, and its accounts cannot sign in. Written to the agent audit like the key
// route, with the Crews page as the caller and no key.
export default defineEventHandler(async (event) => {
  await requireInstanceAdmin(event)
  const slug = String(getRouterParam(event, 'slug') ?? '')
  const caller = { userId: event.context.session.user.id, keyId: null, keyName: 'Crews page' }
  return audited(caller, 'disable', slug, async () => {
    const crew = await crewBySlug(slug)
    await disableCrew(crew)
    return { result: { ok: true }, summary: 'disabled' }
  })
})
