import { createError } from 'h3'
import { audited, createOrRotateCrew, requireCrewManager } from '../../utils/crewProvisioning'
import type { CrewInput } from '../../utils/crewProvisioning'

const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/
const MAX_TEXT = 200

function text(value: unknown, field: string, max: number, required: boolean): string | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) throw createError({ statusCode: 400, message: `${field} is required.` })
    return undefined
  }
  if (typeof value !== 'string' || value.trim().length > max) {
    throw createError({ statusCode: 400, message: `${field} must be text of at most ${max} characters.` })
  }
  return value.trim()
}

// The request is checked here, field by field, so a refusal names the field and
// nothing else. The shape is the one BRIEF-crew-feature section 2 defines.
function parseCrewInput(body: Record<string, unknown>): CrewInput {
  const slug = text(body.slug, 'slug', 63, true)!
  if (!SLUG.test(slug)) {
    throw createError({ statusCode: 400, message: 'slug: 2 to 63 characters, a to z, 0 to 9 and hyphens, not starting with a hyphen.' })
  }
  const name = text(body.name, 'name', 80, true)!
  const product = typeof body.product === 'object' && body.product !== null && !Array.isArray(body.product)
    ? body.product as Record<string, unknown>
    : null
  if (!product) throw createError({ statusCode: 400, message: 'product is required.' })
  const productName = text(product.name, 'product.name', 80, true)!
  const repo = text(product.repo, 'product.repo', MAX_TEXT, false)
  const appUrl = text(product.appUrl, 'product.appUrl', MAX_TEXT, false)
  if (body.rotate !== undefined && typeof body.rotate !== 'boolean') {
    throw createError({ statusCode: 400, message: 'rotate must be true or false.' })
  }
  return {
    slug,
    name,
    product: { name: productName, ...(repo && { repo }), ...(appUrl && { appUrl }) },
    rotate: body.rotate === true
  }
}

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
