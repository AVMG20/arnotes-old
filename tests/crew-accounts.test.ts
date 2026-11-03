// Crew accounts: the reserved .invalid space is refused on every public route, the
// crew provisioning helper makes @crew.invalid accounts in-process, and it never adopts
// an account it did not make. Run against a dev server (CREW_TEST_BASE, default
// http://localhost:3000):
//   node --env-file-if-exists=.env --import tsx --test tests/crew-accounts.test.ts
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { eq, inArray, like } from 'drizzle-orm'
import { db } from '../server/db'
import { crews, organization, user } from '../server/db/schema'
import { createCrewAccount, isCrewAddress, isInvalidDomain } from '../server/utils/crewAccounts'
import { genId } from '../server/utils/projects'

const BASE = process.env.CREW_TEST_BASE ?? 'http://localhost:3000'
const tag = Date.now().toString(36)
const PASSWORD = `probe-${randomBytes(18).toString('base64url')}`
const userEmails: string[] = []
const crewIds: string[] = []

async function signUp(email: string) {
  const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'origin': BASE },
    body: JSON.stringify({ email, password: PASSWORD, name: 'Crew test' })
  })
  return { status: res.status, body: await res.json().catch(() => ({})) as { message?: string } }
}

async function signIn(email: string, password: string) {
  const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'origin': BASE },
    body: JSON.stringify({ email, password })
  })
  return res.status
}

after(async () => {
  // Accounts and crews this file made; the account rows go with their users.
  if (userEmails.length) await db.delete(user).where(inArray(user.email, userEmails))
  // Sign-up rows by their spelling, so a row that was not refused is still removed.
  await db.delete(user).where(like(user.email, `c%-${tag}@%`))
  if (crewIds.length) await db.delete(crews).where(inArray(crews.id, crewIds))
  // The postgres pool keeps the process alive; close it or the test file never ends.
  await db.$client.end({ timeout: 1 })
})

// Forms a provider or a typist might send for the reserved space: case, a fullwidth
// dot, a trailing dot, a trailing space, a subdomain.
const RESERVED_FORMS = [
  'x@CREW.INVALID',
  'x@crew.invalid.',
  'x@crew\uFF0Einvalid',
  'x@a.crew.invalid',
  'x@crew.invalid ',
  'x@crew.invalid\u200B',
  'x@crew.in\u00ADvalid',
  'x@crew.invalid\u200F'
]

test('the address rules', () => {
  assert.equal(isInvalidDomain('foo@example.invalid'), true)
  assert.equal(isInvalidDomain('x@notcrew.invalid'), true)
  assert.equal(isInvalidDomain('a@example.com'), false)
  assert.equal(isInvalidDomain('x@bücher.de'), false)
  assert.equal(isInvalidDomain('x@例え.jp'), false)
  for (const form of RESERVED_FORMS) {
    assert.equal(isInvalidDomain(form), true, form)
  }
  assert.equal(isCrewAddress('slug-boss@crew.invalid'), true)
  for (const form of ['x@CREW.INVALID', 'x@crew.invalid.', 'x@crew．invalid', 'x@crew.invalid ']) {
    assert.equal(isCrewAddress(form), true, form)
  }
  assert.equal(isCrewAddress('foo@example.invalid'), false)
  assert.equal(isCrewAddress('x@notcrew.invalid'), false)
  assert.equal(isCrewAddress('x@a.crew.invalid'), false)
  assert.equal(isCrewAddress('a@crew.invalid.example.com'), false)
})

test('public sign-up refuses the .invalid space in every form', async () => {
  const cases = [...RESERVED_FORMS, 'foo@example.invalid', 'x@notcrew.invalid']
  for (const [index, form] of cases.entries()) {
    const local = `c${index}-${tag}`
    const address = form.replace(/^x@/, `${local}@`)
    const cleanupAddress = `${local}@crew.invalid`
    userEmails.push(cleanupAddress)
    const res = await signUp(address)
    assert.notEqual(res.status, 200, `${address} must be refused`)
    const rows = await db.select({ email: user.email }).from(user).where(like(user.email, `${local}@%`))
    assert.equal(rows.length, 0, `${address} left an account behind`)
  }
})

test('legitimate internationalised domains still sign up', async () => {
  for (const domain of ['xn--bcher-kva.de', 'xn--r8jz45g.jp']) {
    const email = `idn-${tag}@${domain}`
    try {
      const res = await signUp(email)
      assert.equal(res.status, 200, `${email} must be allowed`)
    } finally {
      await db.delete(user).where(like(user.email, `idn-${tag}@%`))
    }
  }
})

test('normal public sign-up is unchanged', async () => {
  const email = `probe-${tag}@example.com`
  userEmails.push(email)
  const res = await signUp(email)
  assert.equal(res.status, 200)
})

test('the user update hook refuses an .invalid address too', async () => {
  const { auth } = await import('../server/lib/auth')
  const ctx = await auth.$context
  const email = `c-upd-${tag}@example.com`
  userEmails.push(email)
  const id = genId()
  await db.insert(user).values({ id, name: 'Update test', email, emailVerified: false, createdAt: new Date(), updatedAt: new Date() })
  for (const form of ['x@crew.invalid', 'x@crew.invalid\u200B']) {
    await assert.rejects(
      ctx.internalAdapter.updateUser(id, { email: form.replace(/^x@/, `c-upd-${tag}@`) }),
      /That address cannot be used/
    )
  }
  const [still] = await db.select({ email: user.email }).from(user).where(eq(user.id, id))
  assert.equal(still?.email, email, 'the refused change left the address alone')
})

test('the helper makes a crew account that signs in, and refuses what it must', async () => {
  const [org] = await db.select({ id: organization.id }).from(organization).limit(1)
  assert.ok(org, 'the dev database needs one organization for the crew row')
  const crewId = genId()
  crewIds.push(crewId)
  await db.insert(crews).values({
    id: crewId,
    slug: `scratch-w2-${tag}`,
    name: `scratch:w2 ${tag}`,
    teamId: org.id,
    createdAt: Date.now()
  })

  // A made account, in-process: not refused by the .invalid rule, and it signs in.
  const boss = `slug-boss-${tag}@crew.invalid`
  userEmails.push(boss)
  const made = await createCrewAccount({ email: boss, name: 'Boss', password: PASSWORD, crewId })
  assert.equal(made.created, true)
  assert.equal(await signIn(boss, PASSWORD), 200)
  assert.equal(await signIn(boss, `${PASSWORD}-wrong`), 401)

  // Asking again for the same crew returns the same account and changes nothing.
  const again = await createCrewAccount({ email: boss, name: 'Boss', password: PASSWORD, crewId })
  assert.equal(again.id, made.id)
  assert.equal(again.created, false)

  // A zero-width character in the domain is dropped: the row is stored under the clean address.
  const zwClean = 'zw-' + tag + '@crew.invalid'
  userEmails.push(zwClean)
  const zw = await createCrewAccount({ email: zwClean + '\u200B', name: 'ZW', password: PASSWORD, crewId })
  const [zwRow] = await db.select({ email: user.email }).from(user).where(eq(user.id, zw.id))
  assert.equal(zwRow?.email, zwClean)

  // Only the crew domain itself: look-alikes are refused, not adopted.
  await assert.rejects(createCrewAccount({ email: 'x@notcrew.invalid', name: 'x', password: PASSWORD, crewId }))
  await assert.rejects(createCrewAccount({ email: 'x@crew.invalid.example.com', name: 'x', password: PASSWORD, crewId }))
  await assert.rejects(createCrewAccount({ email: 'x@a.crew.invalid', name: 'x', password: PASSWORD, crewId }))

  // An account that is not a crew account is never adopted.
  const squat = `squat-${tag}@crew.invalid`
  userEmails.push(squat)
  const squatId = genId()
  await db.insert(user).values({ id: squatId, name: 'Squatter', email: squat, emailVerified: false, createdAt: new Date(), updatedAt: new Date() })
  await assert.rejects(createCrewAccount({ email: squat, name: 'Boss', password: PASSWORD, crewId }))
  const [still] = await db.select({ crewId: user.crewId }).from(user).where(eq(user.id, squatId))
  assert.equal(still?.crewId ?? null, null, 'the squatter row keeps no crew')
})
