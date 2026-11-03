// Crew provisioning: what the crew API does to a crew's team, accounts, customer, board
// and keys (BRIEF-crew-feature section 2). Every crew account is made by
// createCrewAccount (crewAccounts.ts), the only way an @crew.invalid user may exist.
// Passwords and keys leave this module once, in the create or rotate result; nothing
// here logs them, and an error message never carries them.
import { randomBytes } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { hashPassword } from 'better-auth/crypto'
import { createError } from 'h3'
import type { H3Event } from 'h3'
import { db } from '../db'
import {
  account, agentAudit, apiKeys, crews, customerMembers, customers, member,
  organization, projectColumns, projects, session, user
} from '../db/schema'
import type { ApiKeyScope, Crew } from '../db/schema'
import { authenticateApiKey, generateApiKey, hasScope } from './api-keys'
import { createCrewAccount, crewAddress, personKeyOf } from './crewAccounts'
import { genId } from './projects'

// The people a crew is made of, in the order the response lists them. `team` is the
// role in the crew's team; a contact is a customer login and joins no team.
export const CREW_PEOPLE = [
  { key: 'boss', name: 'Boss', role: 'owner: reads the reports, owns the bugs column', team: 'admin' },
  { key: 'pm', name: 'Pia Planner', role: 'project manager', team: 'member' },
  { key: 'w1', name: 'Wren Worker', role: 'worker 1', team: 'member' },
  { key: 'w2', name: 'Wick Worker', role: 'worker 2', team: 'member' },
  { key: 'w3', name: 'Wynn Worker', role: 'worker 3', team: 'member' },
  { key: 'w4', name: 'Wade Worker', role: 'worker 4', team: 'member' },
  { key: 'pietje', name: 'Pietje Precies', role: 'usability tester: browses the dev copy, tries every feature', team: 'member' },
  { key: 'nitpicker', name: 'Nina Nitpick', role: 'code quality reviewer: reviews pull requests, times her review', team: 'member' },
  { key: 'customer', name: 'Scrappy Customer', role: 'the customer: asks for things, never sees internal tasks', team: 'contact' },
  { key: 'contact', name: 'Casey Customer', role: 'customer contact: sees only what is shared with the customer', team: 'contact' }
] as const

export const BOARD_COLUMNS = ['Backlog', 'To do', 'In progress', 'Verify', 'Ready for live', 'Done', 'Bugs'] as const

// Every account gets a key with these two scopes. A contact's key has no team: the
// contact is not a team member, and the personal workspace shows it the customer's own
// projects, the same way its key has always worked.
const CREW_SCOPES: ApiKeyScope[] = ['boards:read', 'boards:write']

export interface CrewInput {
  slug: string
  name: string
  product: { name: string, repo?: string, appUrl?: string }
  rotate: boolean
}

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

/**
 * Checks a crew request field by field, so a refusal names the field and nothing else. The
 * shape is the one BRIEF-crew-feature section 2 defines; the crew API and the Crews page share it.
 */
export function parseCrewInput(body: Record<string, unknown>): CrewInput {
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

/** Who made the call: the key's owner, the key, and its name as the owner sees it. */
export interface CrewCaller {
  userId: string
  // Null for a call from the instance admin's Crews page (a session, not a key).
  keyId: string | null
  keyName: string
}

type Minted = Map<string, { password: string, apiKey: string }>

function secret(): string {
  return randomBytes(24).toString('base64url')
}

function baseUrl(): string {
  return (process.env.BETTER_AUTH_URL || 'http://localhost:3000').replace(/\/$/, '')
}

async function mintKey(userId: string, teamId: string | null, name: string): Promise<string> {
  const generated = generateApiKey()
  await db.insert(apiKeys).values({
    id: genId(),
    userId,
    teamId,
    name,
    keyHash: generated.hash,
    keyPrefix: generated.displayPrefix,
    scopes: CREW_SCOPES,
    createdAt: Date.now()
  })
  return generated.token
}

function roleOf(key: string) {
  return CREW_PEOPLE.find(person => person.key === key)
}

async function accountsOf(crewId: string) {
  return db.select({ id: user.id, name: user.name, email: user.email }).from(user).where(eq(user.crewId, crewId))
}

/** The crew without any secret, as the status calls answer it. */
export async function crewView(crew: Crew) {
  const accounts = await accountsOf(crew.id)
  const ids = accounts.map(a => a.id)
  const sessions = ids.length
    ? await db.select({ userId: session.userId, createdAt: session.createdAt }).from(session).where(inArray(session.userId, ids))
    : []
  const keys = ids.length
    ? await db.select({ userId: apiKeys.userId, lastUsedAt: apiKeys.lastUsedAt }).from(apiKeys).where(inArray(apiKeys.userId, ids))
    : []
  const people = accounts.map((a) => {
    const signedIn = sessions.filter(s => s.userId === a.id).map(s => s.createdAt.getTime())
    const used = keys.filter(k => k.userId === a.id && k.lastUsedAt !== null).map(k => k.lastUsedAt as number)
    const key = personKeyOf(crew.slug, a.email)
    return {
      id: a.id,
      key,
      name: a.name,
      role: roleOf(key)?.role ?? '',
      email: a.email,
      lastSignIn: signedIn.length ? Math.max(...signedIn) : null,
      keyLastUsed: used.length ? Math.max(...used) : null
    }
  })
  return {
    id: crew.id,
    slug: crew.slug,
    name: crew.name,
    teamId: crew.teamId,
    boardId: crew.boardId,
    customerId: crew.customerId,
    boardUrl: crew.boardId ? `${baseUrl()}/projects/${crew.boardId}` : null,
    disabledAt: crew.disabledAt,
    people
  }
}

/** The full answer to a create or rotate: the crew, its team and board, and its secrets, once. */
async function secretsResponse(crew: Crew, minted: Minted) {
  const view = await crewView(crew)
  const people: Record<string, unknown> = {}
  for (const person of view.people) {
    const secrets = minted.get(person.key)
    people[person.key] = {
      id: person.id,
      name: person.name,
      role: person.role,
      email: person.email,
      password: secrets?.password,
      apiKey: secrets?.apiKey
    }
  }
  const [team] = await db.select({ id: organization.id, name: organization.name }).from(organization).where(eq(organization.id, crew.teamId))
  const [board] = crew.boardId
    ? await db.select({ id: projects.id, name: projects.name, customerId: projects.customerId }).from(projects).where(eq(projects.id, crew.boardId))
    : []
  return {
    crew: {
      id: crew.id,
      slug: crew.slug,
      teamId: crew.teamId,
      boardId: crew.boardId,
      customerId: crew.customerId,
      boardUrl: view.boardUrl
    },
    base: baseUrl(),
    people,
    team: team ?? null,
    board: board ?? null
  }
}

/** Makes a crew from nothing. A failed attempt leaves nothing of itself behind. */
async function makeCrew(input: CrewInput, caller: CrewCaller) {
  const now = Date.now()
  const teamId = genId()
  const crewId = genId()
  const madeUsers: string[] = []
  try {
    await db.insert(organization).values({ id: teamId, name: input.name, slug: `crew-${input.slug}`, createdAt: new Date() })
    await db.insert(crews).values({
      id: crewId,
      slug: input.slug,
      name: input.name,
      teamId,
      product: input.product,
      createdBy: caller.userId,
      createdAt: now
    })

    const minted: Minted = new Map()
    const accountIds = new Map<string, string>()
    const teamMembers: { id: string, organizationId: string, userId: string, role: string, createdAt: Date }[] = [
      { id: genId(), organizationId: teamId, userId: caller.userId, role: 'owner', createdAt: new Date() }
    ]
    for (const person of CREW_PEOPLE) {
      const password = secret()
      const { id } = await createCrewAccount({
        email: crewAddress(input.slug, person.key),
        name: person.name,
        password,
        crewId
      })
      madeUsers.push(id)
      accountIds.set(person.key, id)
      minted.set(person.key, { password, apiKey: '' })
      if (person.team !== 'contact') {
        teamMembers.push({ id: genId(), organizationId: teamId, userId: id, role: person.team, createdAt: new Date() })
      }
    }
    await db.insert(member).values(teamMembers)

    const customerId = genId()
    await db.insert(customers).values({ id: customerId, organizationId: teamId, name: input.product.name, createdAt: now, updatedAt: now })
    await db.insert(customerMembers).values(
      ['customer', 'contact'].map(key => ({ id: genId(), customerId, userId: accountIds.get(key)!, createdAt: now }))
    )

    const boardId = genId()
    await db.insert(projects).values({
      id: boardId,
      userId: caller.userId,
      teamId,
      customerId,
      name: `${input.product.name} Development Center`,
      createdAt: now,
      updatedAt: now
    })
    await db.insert(projectColumns).values(BOARD_COLUMNS.map((name, i) => ({
      id: genId(),
      projectId: boardId,
      name,
      position: i * 1000,
      createdAt: now
    })))
    await db.update(crews).set({ boardId, customerId }).where(eq(crews.id, crewId))

    for (const person of CREW_PEOPLE) {
      const contact = person.team === 'contact'
      const apiKey = await mintKey(accountIds.get(person.key)!, contact ? null : teamId, `crew ${person.key}`)
      minted.get(person.key)!.apiKey = apiKey
    }

    const [crew] = await db.select().from(crews).where(eq(crews.id, crewId))
    return await secretsResponse(crew!, minted)
  } catch (error) {
    // Nothing of a failed attempt stays: accounts go with their sessions and keys, the
    // team with its crew, customer and board. The cause is not logged, since a database
    // error can carry the password hash it was writing.
    if (madeUsers.length) await db.delete(user).where(inArray(user.id, madeUsers))
    await db.delete(organization).where(eq(organization.id, teamId))
    // Two creates of one slug racing: the loser's unique violation is an ordinary 409.
    const cause = error as { code?: string, cause?: { code?: string } }
    if ((cause.code ?? cause.cause?.code) === '23505') {
      throw createError({ statusCode: 409, message: 'This crew already exists. Send rotate: true for new keys.' })
    }
    throw createError({ statusCode: 500, message: 'The crew could not be made. Nothing was kept; try again.' })
  }
}

/** New passwords, new keys and ended sessions for every account of a crew. Re-enables it. */
async function rotateCrew(crew: Crew) {
  const accounts = await accountsOf(crew.id)
  const ids = accounts.map(a => a.id)
  if (ids.length) {
    await db.delete(apiKeys).where(inArray(apiKeys.userId, ids))
    await db.delete(session).where(inArray(session.userId, ids))
  }
  const minted: Minted = new Map()
  for (const a of accounts) {
    const key = personKeyOf(crew.slug, a.email)
    const password = secret()
    // The credential row, not updateUser: the update hook refuses an .invalid address,
    // and the address does not change here anyway.
    await db.update(account)
      .set({ password: await hashPassword(password), updatedAt: new Date() })
      .where(and(eq(account.userId, a.id), eq(account.providerId, 'credential')))
    const contact = roleOf(key)?.team === 'contact'
    const apiKey = await mintKey(a.id, contact ? null : crew.teamId, `crew ${key}`)
    minted.set(key, { password, apiKey })
  }

  // A crew made before a role existed gets the missing people now: their account, team
  // seat or customer login, and keys. Nobody who exists is changed beyond the rotation.
  const have = new Set(accounts.map(a => personKeyOf(crew.slug, a.email)))
  for (const person of CREW_PEOPLE.filter(p => !have.has(p.key))) {
    const password = secret()
    const { id } = await createCrewAccount({
      email: crewAddress(crew.slug, person.key),
      name: person.name,
      password,
      crewId: crew.id
    }).catch(() => {
      throw createError({ statusCode: 409, message: 'An address this crew needs belongs to another account.' })
    })
    if (person.team === 'contact') {
      if (crew.customerId) {
        await db.insert(customerMembers).values({ id: genId(), customerId: crew.customerId, userId: id, createdAt: Date.now() })
      }
    } else {
      await db.insert(member).values({ id: genId(), organizationId: crew.teamId, userId: id, role: person.team, createdAt: new Date() })
    }
    const apiKey = await mintKey(id, person.team === 'contact' ? null : crew.teamId, `crew ${person.key}`)
    minted.set(person.key, { password, apiKey })
  }

  if (crew.disabledAt) await enableCrew(crew)
  const [fresh] = await db.select().from(crews).where(eq(crews.id, crew.id))
  return await secretsResponse(fresh!, minted)
}

/**
 * Creates the crew, or, when its slug is taken, refuses (409) unless the caller asks
 * to rotate. A rotate answers with the crew's secrets again; a 201 is a first creation.
 */
export async function createOrRotateCrew(input: CrewInput, caller: CrewCaller): Promise<{ status: 200 | 201, body: unknown }> {
  const [existing] = await db.select().from(crews).where(eq(crews.slug, input.slug))
  if (existing) {
    if (!input.rotate) {
      throw createError({
        statusCode: 409,
        message: existing.disabledAt
          ? 'This crew is disabled. Send rotate: true to re-enable it with new keys.'
          : 'This crew already exists. Send rotate: true for new keys.'
      })
    }
    return { status: 200, body: await rotateCrew(existing) }
  }
  const [taken] = await db.select({ id: organization.id }).from(organization).where(eq(organization.slug, `crew-${input.slug}`))
  if (taken) throw createError({ statusCode: 409, message: `A team named crew-${input.slug} already exists.` })
  return { status: 201, body: await makeCrew(input, caller) }
}

/** Looks a crew up by slug; 404 with no hint about other crews. */
export async function crewBySlug(slug: string): Promise<Crew> {
  const [crew] = await db.select().from(crews).where(eq(crews.slug, slug))
  if (!crew) throw createError({ statusCode: 404, message: 'No crew with that slug.' })
  return crew
}

/** Cuts a crew off at once: keys revoked, sessions ended. Sign-in is refused by the auth hook. Idempotent. */
export async function disableCrew(crew: Crew) {
  await db.update(crews).set({ disabledAt: crew.disabledAt ?? Date.now() }).where(eq(crews.id, crew.id))
  const ids = (await accountsOf(crew.id)).map(a => a.id)
  if (ids.length) {
    await db.delete(apiKeys).where(inArray(apiKeys.userId, ids))
    await db.delete(session).where(inArray(session.userId, ids))
  }
}

/** Deletes the crew's accounts, then its team, which takes the customer, board and crew row. */
export async function purgeCrew(crew: Crew) {
  await db.delete(user).where(eq(user.crewId, crew.id))
  await db.delete(organization).where(eq(organization.id, crew.teamId))
}

/**
 * Lets a call through only when its key is a live crews:manage key whose owner is the
 * instance admin. Anything else is refused by name, with no detail about the key.
 */
export async function requireCrewManager(event: H3Event): Promise<CrewCaller> {
  const key = await authenticateApiKey(event)
  if (!hasScope(key, 'crews:manage')) {
    throw createError({ statusCode: 403, message: 'This key cannot manage crews.' })
  }
  const [owner] = await db.select({ isInstanceAdmin: user.isInstanceAdmin }).from(user).where(eq(user.id, key.userId))
  if (!owner?.isInstanceAdmin) {
    throw createError({ statusCode: 403, message: 'Only the instance admin can manage crews.' })
  }
  return { userId: key.userId, keyId: key.keyId, keyName: key.keyName }
}

/** One agent audit row per crew call, read by the key's owner in the Inbox. Never throws. */
async function recordCrewCall(caller: CrewCaller, action: string, slug: string, summary: string) {
  try {
    await db.insert(agentAudit).values({
      id: genId(),
      userId: caller.userId,
      apiKeyId: caller.keyId,
      keyName: caller.keyName,
      tool: `crew_${action}`,
      toolTitle: 'Crew API',
      summary: `${summary} (${slug})`.slice(0, 200),
      createdAt: Date.now()
    })
  } catch (error) {
    console.error('[agent-audit] could not record a crew call', (error as Error).name)
  }
}

/**
 * Runs one crew call and writes it to the agent audit, whether it worked or was refused.
 * The summary never carries a secret.
 */
export async function audited<T>(
  caller: CrewCaller,
  action: string,
  slug: string,
  run: () => Promise<{ result: T, summary: string }>
): Promise<T> {
  try {
    const { result, summary } = await run()
    await recordCrewCall(caller, action, slug, summary)
    return result
  } catch (error) {
    const message = (error as { statusMessage?: string }).statusMessage ?? 'failed'
    await recordCrewCall(caller, action, slug, `refused: ${message}`)
    throw error
  }
}

/**
 * Lets a disabled crew sign in and use its keys again. The keys revoked at disabling are not
 * brought back: rotate the crew (the crew API, rotate: true) to get new ones.
 */
export async function enableCrew(crew: Crew) {
  await db.update(crews).set({ disabledAt: null }).where(eq(crews.id, crew.id))
}
