import { db } from '../../../db'
import { customerInvitations, customerMembers } from '../../../db/schema'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { auth } from '../../../lib/auth'
import { genId } from '../../../utils/projects'
import { isCrewUser } from '../../../utils/crewAccounts'
import { hashInvitationToken, INVITATION_COOKIE } from '../../../utils/customers'

// Turns the signed-in account into a contact of the invitation's customer. The
// link is spent by the first account that accepts it.
export default defineEventHandler(async (event) => {
  const session = await auth.api.getSession({ headers: event.headers })
  if (!session) throw createError({ statusCode: 401, message: 'Sign in to accept this invitation' })

  // Crew accounts are contacts only where their crew provisioned them; no invitation
  // is ever theirs to spend, so the link stays unspent for someone else.
  if (await isCrewUser(session.user.id)) {
    throw createError({ statusCode: 403, message: 'Crew accounts cannot accept invitations.' })
  }

  const token = getRouterParam(event, 'token') ?? ''
  const now = Date.now()

  // Claimed in one statement, so two people opening the same link at once
  // cannot both get in on it.
  const [claimed] = await db
    .update(customerInvitations)
    .set({ acceptedBy: session.user.id, acceptedAt: now })
    .where(and(
      eq(customerInvitations.tokenHash, hashInvitationToken(token)),
      isNull(customerInvitations.acceptedAt),
      gt(customerInvitations.expiresAt, now)
    ))
    .returning({ customerId: customerInvitations.customerId })

  if (!claimed) throw createError({ statusCode: 410, message: 'This invitation is no longer valid' })

  await db
    .insert(customerMembers)
    .values({ id: genId(), customerId: claimed.customerId, userId: session.user.id, createdAt: now })
    .onConflictDoNothing()

  deleteCookie(event, INVITATION_COOKIE, { path: '/' })
  return { ok: true }
})
