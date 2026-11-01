import { audited, crewBySlug, enableCrew } from '../../../../utils/crewProvisioning'
import { requireInstanceAdmin } from '../../../../utils/instanceAdmin'

// Lets a disabled crew sign in again. Its old keys stay revoked; a rotate through the crew
// API gives it new ones. Written to the agent audit.
export default defineEventHandler(async (event) => {
  await requireInstanceAdmin(event)
  const slug = String(getRouterParam(event, 'slug') ?? '')
  const caller = { userId: event.context.session.user.id, keyId: null, keyName: 'Crews page' }
  return audited(caller, 'enable', slug, async () => {
    const crew = await crewBySlug(slug)
    await enableCrew(crew)
    return { result: { ok: true }, summary: 're-enabled' }
  })
})
