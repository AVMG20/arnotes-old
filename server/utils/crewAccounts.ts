// Crew accounts (the ones the crew API makes for an agent's team) are created here,
// in-process, by the crew provisioning code. They never pass through the
// user-creation hook in server/lib/auth.ts, which refuses `.invalid` addresses on
// every public route, and nothing in a request can switch that off.
import { domainToASCII } from 'node:url'
import { eq } from 'drizzle-orm'
import { hashPassword } from 'better-auth/crypto'
import { db } from '../db'
import { account, crews, user } from '../db/schema'
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

/** The address of a crew's account for one person: <slug>-<key>@crew.invalid. */
export function crewAddress(slug: string, key: string): string {
  return `${slug}-${key}@${CREW_DOMAIN}`
}

/** The person key an account answers to, read back from its address. */
export function personKeyOf(slug: string, email: string): string {
  const normal = normalizeAddress(email)
  return normal.slice(0, normal.lastIndexOf('@')).slice(slug.length + 1)
}

/**
 * Whether a crew account may sign in or use the API: live while its crew exists and is
 * not disabled. Deleting a team takes the crew row with it, so an orphaned crew account
 * (no crew) is refused too. Non-crew accounts are always live.
 */
export async function crewAccountLive(userId: string): Promise<boolean> {
  const [row] = await db.select({ email: user.email, crewId: user.crewId }).from(user).where(eq(user.id, userId))
  if (!row || !isCrewAddress(row.email)) return true
  if (!row.crewId) return false
  const [crew] = await db.select({ disabledAt: crews.disabledAt }).from(crews).where(eq(crews.id, row.crewId))
  return Boolean(crew) && !crew!.disabledAt
}

/** Whether an account is a crew's. Crew accounts may not join or start teams or accept invitations. */
export async function isCrewUser(userId: string): Promise<boolean> {
  const [row] = await db.select({ email: user.email, crewId: user.crewId }).from(user).where(eq(user.id, userId))
  // An account whose crew is gone has no crewId but keeps its crew address: still a crew's.
  return Boolean(row?.crewId) || (row !== undefined && isCrewAddress(row.email))
}

/** The team a crew account belongs to, or null for an account that is not a crew's. */
export async function crewTeamOf(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ teamId: crews.teamId })
    .from(user)
    .innerJoin(crews, eq(crews.id, user.crewId))
    .where(eq(user.id, userId))
  return row?.teamId ?? null
}

/** The bare address of a recipient: the text inside <...> when there is one, else the text itself. */
export function bareAddress(recipient: string): string {
  const angled = /<([^<>]+)>/.exec(recipient)
  return (angled ? angled[1]! : recipient).trim()
}

// Only these characters may stand in the local part of an address that is sent. Quotes,
// brackets, spaces, backslashes and the @ are refused, whatever a parser made of them.
const LOCAL_PART = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/
// One hostname label: letters, digits and inner hyphens, 1 to 63 characters.
const HOST_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * The address as it is sent, or null when it is not a plain address that converts to a real
 * hostname. Fail closed: anything not on the whitelist is null. The domain is folded (NFKC,
 * the ideographic and fullwidth full stops as dots, lower case, all trailing dots gone) and
 * converted to ASCII; every label must then be a hostname label, at most 253 characters in all.
 */
export function asciiAddress(address: string): string | null {
  const folded = address.normalize('NFKC').trim()
  const at = folded.lastIndexOf('@')
  if (at <= 0) return null
  const local = folded.slice(0, at)
  // RFC 5321: the local part is at most 64 octets (it is ASCII once it passes LOCAL_PART).
  if (!LOCAL_PART.test(local) || local.length > 64) return null
  const domain = folded.slice(at + 1)
    .replace(/[\u3002\uFF0E\uFF61]/g, '.')
    .toLowerCase()
    .replace(/\.+$/, '')
  const ascii = domainToASCII(domain)
  if (!ascii || ascii.length > 253) return null
  if (ascii.split('.').some(label => !HOST_LABEL.test(label))) return null
  return `${local}@${ascii}`
}

/**
 * Whether a recipient is in the reserved .invalid space, or is not a plain address at all
 * (which is refused too: fail closed). Its last label is `invalid`.
 */
export function isReservedInvalidAddress(recipient: string): boolean {
  const ascii = asciiAddress(bareAddress(recipient))
  if (ascii === null) return true
  return ascii.endsWith('.invalid') || ascii.endsWith('@invalid')
}
