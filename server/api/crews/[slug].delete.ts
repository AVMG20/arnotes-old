import { audited, crewBySlug, disableCrew, purgeCrew, requireCrewManager } from '../../utils/crewProvisioning'

/**
 * Disables a crew: its keys are revoked and its sessions ended at once, and its
 * accounts cannot sign in. The team and board stay as history. With ?purge=1 the
 * accounts, team, customer and board are deleted. Disabling twice is harmless.
 */
export default defineEventHandler(async (event) => {
  const caller = await requireCrewManager(event)
  const slug = String(getRouterParam(event, 'slug') ?? '')
  const purge = getQuery(event).purge === '1'
  return audited<{ slug: string, purged?: boolean, disabled?: boolean }>(caller, purge ? 'purge' : 'disable', slug, async () => {
    const crew = await crewBySlug(slug)
    if (purge) {
      await purgeCrew(crew)
      return { result: { slug, purged: true }, summary: 'purged' }
    }
    await disableCrew(crew)
    return { result: { slug, disabled: true }, summary: 'disabled' }
  })
})
