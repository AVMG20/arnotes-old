// Crew accounts (the ones the crew API makes for an agent's team) are created here,
// in-process, by the crew provisioning code. They never pass through the
// user-creation hook in server/lib/auth.ts, which refuses `.invalid` addresses on
// every public route, and nothing in a request can switch that off.
import { domainToASCII } from 'node:url'
import { eq } from 'drizzle-orm'
import { hashPassword } from 'better-auth/crypto'
import { db } from '../db'
import { account, user } from '../db/schema'
import { genId } from './projects'

// RFC 2606 reserved: never deliverable, so a crew account never gets mail.
const CREW_DOMAIN = 'crew.invalid'

// One normaliser for every rule about an address (the hook, the crew check and the
// account row), so the rules cannot disagree. NFKC folds fullwidth dots and letters
// into ASCII; a trailing dot on the domain names the same domain.
export function normalizeAddress(email: string): string {
  const folded = email.normalize('NFKC').trim().toLowerCase()
  const at = folded.lastIndexOf('@')
  if (at < 0) return folded
  return `${folded.slice(0, at)}@${folded.slice(at + 1).replace(/\.+$/, '')}`
}

function domainOf(email: string): string {
  const normal = normalizeAddress(email)
  return normal.slice(normal.lastIndexOf('@') + 1)
}

// The domain as the internet names it: an internationalised name becomes its xn--
// form (UTS 46). Invisible characters are dropped or make the domain empty, so they
// reach the checks below in a form they can refuse.
function asciiDomainOf(email: string): string {
  return domainToASCII(domainOf(email))
}
// The address the row is stored under: the local part as normalised, the domain as
// UTS 46 converts it, so an invisible character in the domain never reaches a row.
export function canonicalAddress(email: string): string {
  const normal = normalizeAddress(email)
  const at = normal.lastIndexOf('@')
  if (at < 0) return normal
  return `${normal.slice(0, at)}@${asciiDomainOf(email)}`
}

/** Whether an address is in the reserved `.invalid` space, which public sign-up refuses. */
export function isInvalidDomain(email: string): boolean {
  const domain = asciiDomainOf(email)
  // An empty domain is not a real one. Anything else but letters, digits, dots and
  // hyphens is refused as well, as a last guard.
  return domain === '' || domain === 'invalid' || domain.endsWith('.invalid') || /[^a-z0-9.-]/.test(domain)
}

/** Whether an address is one a crew account may use: the crew domain itself, nothing like it. */
export function isCrewAddress(email: string): boolean {
  return asciiDomainOf(email) === CREW_DOMAIN
}

/**
 * Makes a crew account, or returns the one already made for this crew. An existing
 * account that is not this crew's (no crew, or another crew) is never touched: the
 * call fails, so a squatter who signed up with the address keeps the account and the
 * crew is provisioned under another name.
 */
export async function createCrewAccount(input: {
  email: string
  name: string
  password: string
  crewId: string
}): Promise<{ id: string, created: boolean }> {
  const email = canonicalAddress(input.email)
  if (!isCrewAddress(email)) {
    throw new Error('A crew account needs a @crew.invalid address')
  }

  const [existing] = await db
    .select({ id: user.id, crewId: user.crewId })
    .from(user)
    .where(eq(user.email, email))
  if (existing) {
    if (existing.crewId !== input.crewId) {
      throw new Error('That address already has an account that does not belong to this crew')
    }
    return { id: existing.id, created: false }
  }

  const id = genId()
  const now = new Date()
  const password = await hashPassword(input.password)
  try {
    await db.transaction(async (tx) => {
      await tx.insert(user).values({
        id,
        name: input.name,
        email,
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
        crewId: input.crewId
      })
      await tx.insert(account).values({
        id: genId(),
        accountId: id,
        providerId: 'credential',
        userId: id,
        password,
        createdAt: now,
        updatedAt: now
      })
    })
  } catch (error) {
    // Two provisioning calls can race past the check above. The unique index on
    // user.email then fails the second insert, which is refused here rather than
    // overwriting the first account.
    const cause = error as { code?: string, cause?: { code?: string } }
    if ((cause.code ?? cause.cause?.code) === '23505') {
      throw new Error('That address already has an account that does not belong to this crew')
    }
    throw error
  }
  return { id, created: true }
}
