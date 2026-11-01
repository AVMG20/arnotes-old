import { audited, crewBySlug, purgeCrew } from '../../../../utils/crewProvisioning'
import { requireInstanceAdmin } from '../../../../utils/instanceAdmin'

// Deletes a crew for good: its accounts, team, customer and board. The page asks first and
// names the crew. Written to the agent audit before the delete is gone, so the trace stays.
export default defineEventHandler(async (event) => {
  await requireInstanceAdmin(event)
  const slug = String(getRouterParam(event, 'slug') ?? '')
  const caller = { userId: event.context.session.user.id, keyId: null, keyName: 'Crews page' }
  return audited(caller, 'purge', slug, async () => {
    const crew = await crewBySlug(slug)
    await purgeCrew(crew)
    return { result: { ok: true }, summary: 'purged' }
  })
})
