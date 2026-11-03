// Pinned boards: a person pins any board they can open, in any of their workspaces, and the
// list says which workspace each one opens in. Needs the dev database (DATABASE_URL). Run:
//   DATABASE_URL=postgresql://arnotes:arnotes@localhost:5433/arnotes node --import tsx --test tests/board-pins.test.ts
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createError } from 'h3'
import { eq, inArray } from 'drizzle-orm'

// Nitro provides createError as a global; the helper under test expects it.
Object.assign(globalThis, { createError })

const { db } = await import('../server/db')
const { customerMembers, customers, member, organization, projects, user } = await import('../server/db/schema')
const { listPins, pinBoard, unpinBoard } = await import('../server/utils/boardPins')
const { workspaceOf } = await import('../server/utils/workspaces')

const tag = randomBytes(4).toString('hex')
const id = (name: string) => `pins-${tag}-${name}`
const now = Date.now()

// Me: in team A, not in team B, a contact of B's customer. Someone else owns a personal board.
const me = id('me')
const other = id('other')
const teamA = id('team-a')
const teamB = id('team-b')
const customerB = id('customer-b')
const board = {
  personal: id('personal'),
  teamA: id('board-a'),
  teamB: id('board-b'),
  customerB: id('board-cust-b'),
  othersPersonal: id('others-personal'),
  archived: id('archived')
}

before(async () => {
  const at = new Date()
  await db.insert(user).values([me, other].map(u => ({ id: u, name: u, email: `${u}@arnotes.test`, emailVerified: true, createdAt: at, updatedAt: at })))
  await db.insert(organization).values([teamA, teamB].map(t => ({ id: t, name: `Team ${t.slice(-6)}`, slug: t, createdAt: at })))
  await db.insert(member).values([
    { id: id('m-a'), organizationId: teamA, userId: me, role: 'member', createdAt: at },
    { id: id('m-b'), organizationId: teamB, userId: other, role: 'owner', createdAt: at }
  ])
  await db.insert(customers).values({ id: customerB, organizationId: teamB, name: 'Customer B', createdAt: now, updatedAt: now })
  await db.insert(customerMembers).values({ id: id('cm'), customerId: customerB, userId: me, createdAt: now })
  const row = (pid: string, userId: string, teamId: string | null, extra = {}) => ({ id: pid, userId, teamId, name: pid.slice(-12), createdAt: now, updatedAt: now, ...extra })
  await db.insert(projects).values([
    row(board.personal, me, null),
    row(board.teamA, other, teamA),
    row(board.teamB, other, teamB),
    row(board.customerB, other, teamB, { customerId: customerB }),
    row(board.othersPersonal, other, null),
    row(board.archived, other, teamA, { archivedAt: now })
  ])
})

after(async () => {
  await db.delete(projects).where(inArray(projects.id, Object.values(board)))
  await db.delete(customers).where(eq(customers.id, customerB))
  await db.delete(organization).where(inArray(organization.id, [teamA, teamB]))
  await db.delete(user).where(inArray(user.id, [me, other]))
  await db.$client.end() // the open pool would keep the test process alive
})

test('a board in my personal workspace, my team and my customer can be pinned, and each opens in its own workspace', async () => {
  await pinBoard(me, board.teamA)
  await pinBoard(me, board.personal)
  await pinBoard(me, board.customerB)
  const pins = await listPins(me)
  assert.deepEqual(pins.map(p => p.projectId), [board.teamA, board.personal, board.customerB], 'oldest pin first')
  assert.equal(pins[0]!.teamId, teamA, 'a team board opens in that team')
  assert.ok(pins[0]!.teamName, 'and names it')
  assert.equal(pins[1]!.teamId, null, 'my own board opens in the personal workspace')
  // I log in for the customer but am not in team B, so it opens where customer boards do.
  assert.equal(pins[2]!.teamId, null)
  assert.equal(pins[2]!.customerName, 'Customer B')
})

test('a board I cannot open is refused with a 404 and never pinned', async () => {
  for (const foreign of [board.teamB, board.othersPersonal, id('missing')]) {
    await assert.rejects(pinBoard(me, foreign), (e: { statusCode?: number }) => e.statusCode === 404)
  }
  assert.ok(!(await listPins(me)).some(p => p.projectId === board.teamB || p.projectId === board.othersPersonal))
})

test('pinning twice keeps one pin; unpinning removes it and is harmless when repeated', async () => {
  await pinBoard(me, board.teamA)
  assert.equal((await listPins(me)).filter(p => p.projectId === board.teamA).length, 1)
  await unpinBoard(me, board.teamA)
  await unpinBoard(me, board.teamA)
  assert.ok(!(await listPins(me)).some(p => p.projectId === board.teamA))
})

test('a pin disappears from the list when I leave the team, and an archived board is not listed', async () => {
  await pinBoard(me, board.teamA)
  await db.update(projects).set({ archivedAt: null }).where(eq(projects.id, board.archived))
  await pinBoard(me, board.archived)
  await db.update(projects).set({ archivedAt: now }).where(eq(projects.id, board.archived))
  assert.ok(!(await listPins(me)).some(p => p.projectId === board.archived), 'archived boards are left out')
  await db.delete(member).where(eq(member.id, id('m-a')))
  assert.ok(!(await listPins(me)).some(p => p.projectId === board.teamA), 'a team I left is left out')
})

test('a board opens in its team for a member, in the personal workspace for a customer contact, and nowhere for a stranger', async () => {
  assert.equal((await workspaceOf(other, board.teamB))?.teamId, teamB)
  assert.equal((await workspaceOf(me, board.customerB))?.teamId, null)
  assert.equal((await workspaceOf(me, board.personal))?.teamId, null)
  assert.equal(await workspaceOf(me, board.teamB), null)
  assert.equal(await workspaceOf(me, board.othersPersonal), null)
})

test('pins are personal: someone else sees none of mine', async () => {
  assert.deepEqual(await listPins(other), [])
})
