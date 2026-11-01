import { audited, crewBySlug, crewView, requireCrewManager } from '../../utils/crewProvisioning'

/** The crew without secrets: its ids, board link, disabled mark and each person's sign-in and key use. */
export default defineEventHandler(async (event) => {
  const caller = await requireCrewManager(event)
  const slug = String(getRouterParam(event, 'slug') ?? '')
  return audited(caller, 'read', slug, async () => {
    const crew = await crewBySlug(slug)
    return { result: await crewView(crew), summary: 'read' }
  })
})
