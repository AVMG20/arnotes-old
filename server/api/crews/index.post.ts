import { createError } from 'h3'
import { audited, createOrRotateCrew, parseCrewInput, requireCrewManager } from '../../utils/crewProvisioning'

/**
 * Makes a crew: its team, accounts, customer, board and one key per account. A slug
 * already taken answers 409 (with no secrets) unless `rotate` is true, which gives every
 * account new keys and a new password and answers with them once.
 */
export default defineEventHandler(async (event) => {
  const caller = await requireCrewManager(event)
  const body = await readBody<Record<string, unknown>>(event).catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw createError({ statusCode: 400, message: 'Send a JSON object.' })
  }
  const input = parseCrewInput(body)

  const outcome = await audited(caller, 'create', input.slug, async () => {
    const made = await createOrRotateCrew(input, caller)
    const summary = made.status === 201 ? 'created' : 'rotated keys of'
    return { result: made, summary }
  })
  setResponseStatus(event, outcome.status)
  return outcome.body
})
