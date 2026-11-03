// Blocked-by links, GH #36 follow-up: the savepoint around the link insert, and the activity line
// each link change writes in the same transaction. The database is replaced by a script of results
// (one per query, in order), so this runs without Postgres. Run:
//   node --import tsx --test tests/task-blocker-activity.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addBlocker, cutTitle, removeBlocker } from '../server/utils/taskDependencyService'
import type { Actor, Tx } from '../server/utils/taskDependencyService'
import { briefOf, liveTitlesOf, readerDetail } from '../server/utils/taskActivity'
import { taskDependencies, taskActivity } from '../server/db/schema'

type Row = Record<string, unknown>

const blockedRow: Row = { id: 'A', projectId: 'board-1', columnId: 'todo', title: 'Write the spec', visibility: 'customer', completedAt: null, deletedAt: null }
const blockerRow: Row = { id: 'B', projectId: 'board-1', columnId: 'todo', title: 'Build the table', visibility: 'customer', completedAt: null, deletedAt: null }
const hiddenRow: Row = { ...blockerRow, id: 'C', title: 'Secret plan', visibility: 'internal' }
const staff: Actor = { userId: 'user-1', audience: 'staff', via: 'mcp' }

interface Script {
  /** Results of the selects, in the order the service makes them. */
  selects: Row[][]
  /** Each insert into the link table: 'ok', or the error it throws. */
  inserts?: Array<'ok' | { code: string }>
  /** Each delete from the link table: the rows it removes. */
  deletes?: Row[][]
}

// A transaction stand-in: queries answer from the script in order, and every write is recorded.
function fakeTx(script: Script) {
  const selects = [...script.selects]
  const inserts = [...(script.inserts ?? [])]
  const deletes = [...(script.deletes ?? [])]
  const written = { savepoints: 0, links: [] as Row[], activity: [] as Row[][] }
  const later = <T>(run: () => T) => ({
    then: (resolve: (value: T) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve().then(run).then(resolve, reject)
  })
  const tx = {
    execute: async () => undefined,
    select: () => {
      const query = {
        from: () => query,
        innerJoin: () => query,
        where: () => query,
        orderBy: () => query,
        then: (resolve: (value: Row[]) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(selects.shift() ?? []).then(resolve, reject)
      }
      return query
    },
    insert: (table: unknown) => ({
      values: (values: Row | Row[]) => {
        if (table === taskActivity) {
          written.activity.push(values as Row[])
          return later(() => undefined)
        }
        return {
          returning: () => later(() => {
            const next = inserts.shift() ?? 'ok'
            if (next !== 'ok') throw next
            written.links.push(values as Row)
            return [{ id: 'link-1', blockedTaskId: 'A', blockerTaskId: 'B', createdAt: 1 }]
          })
        }
      }
    }),
    delete: (table: unknown) => ({
      where: () => ({
        returning: () => later(() => {
          if (table !== taskDependencies) throw new Error('unexpected delete')
          return deletes.shift() ?? []
        })
      })
    }),
    transaction: async (work: (savepoint: unknown) => Promise<unknown>) => {
      written.savepoints++
      return work(tx)
    }
  }
  return { tx: tx as unknown as Tx, written }
}

test('a duplicate inside the caller transaction is refused in a savepoint, and the caller can write again', async () => {
  // Pass one: the insert hits the unique pair. Pass two: the same caller transaction adds the link.
  const { tx, written } = fakeTx({
    selects: [[blockedRow], [blockerRow], [], [blockedRow], [blockerRow], []],
    inserts: [{ code: '23505' }, 'ok']
  })
  const first = await addBlocker('board-1', 'A', 'B', staff, tx)
  assert.deepEqual(first, { ok: false, reason: 'duplicate', message: 'This task already waits for that one.' })
  assert.equal(written.savepoints, 1, 'the insert ran inside its own savepoint')
  assert.equal(written.activity.length, 0, 'a refused link writes no activity line')

  const second = await addBlocker('board-1', 'A', 'B', staff, tx)
  assert.equal(second.ok, true)
  assert.equal(written.savepoints, 2)
})

test('adding a link writes one activity line on the blocked task, naming the blocker, from the MCP', async () => {
  const { tx, written } = fakeTx({ selects: [[blockedRow], [blockerRow], []] })
  const result = await addBlocker('board-1', 'A', 'B', staff, tx)
  assert.equal(result.ok, true)
  assert.equal(written.activity.length, 1)
  const [line] = written.activity[0]!
  assert.equal((line as Row).taskId, 'A')
  assert.equal((line as Row).kind, 'blocker_added')
  assert.deepEqual((line as Row).detail, { to: 'Build the table', blockerId: 'B' })
  assert.equal((line as Row).via, 'mcp')
})

test('a team-only blocker is named as a hidden task, and its title never reaches the line', async () => {
  const { tx, written } = fakeTx({ selects: [[blockedRow], [hiddenRow], []] })
  await addBlocker('board-1', 'A', 'C', staff, tx)
  const [line] = written.activity[0]!
  assert.deepEqual((line as Row).detail, { to: 'a hidden task', blockerId: 'C' })
  assert.equal(JSON.stringify(written.activity).includes('Secret plan'), false)
})

test('removing a link writes "no longer waits for" on the blocked task, in the same transaction', async () => {
  const { tx, written } = fakeTx({
    selects: [[blockedRow], [blockerRow]],
    deletes: [[{ id: 'link-1' }]]
  })
  const result = await removeBlocker('board-1', 'A', 'B', staff, tx)
  assert.deepEqual(result, { ok: true, blockerId: 'B' })
  const [line] = written.activity[0]!
  assert.equal((line as Row).kind, 'blocker_removed')
  assert.deepEqual((line as Row).detail, { from: 'Build the table', blockerId: 'B' })
})

test('a removal that removes nothing writes no line', async () => {
  const { tx, written } = fakeTx({ selects: [[blockedRow]], deletes: [[]] })
  const result = await removeBlocker('board-1', 'A', 'B', staff, tx)
  assert.equal(result.ok, false)
  assert.equal(written.activity.length, 0)
})

test('a long blocker title is cut on the activity line, and a short one is kept whole', () => {
  assert.equal(cutTitle('Build the table'), 'Build the table')
  const cut = cutTitle('x'.repeat(120))
  assert.equal(cut.length, 80)
  assert.ok(cut.endsWith('…'))
})

test('a removal of a hidden blocker: a customer reads a hidden task and no title, staff read the live title', async () => {
  const { tx, written } = fakeTx({ selects: [[blockedRow], [hiddenRow]], deletes: [[{ id: 'link-1' }]] })
  await removeBlocker('board-1', 'A', 'C', staff, tx)
  const [line] = written.activity[0]!
  const entry = { kind: (line as Row).kind as 'blocker_removed', detail: (line as Row).detail as Record<string, string | null> }
  assert.deepEqual(readerDetail(entry, true, 'Secret plan'), { from: 'a hidden task' })
  assert.deepEqual(readerDetail(entry, false, 'Secret plan'), { from: 'Secret plan' })
  assert.equal(JSON.stringify(written.activity).includes('Secret plan'), false)
})

test('a staff reader sees the live title of a blocker that still exists, and the stored text once it is gone', () => {
  const entry = { kind: 'blocker_added' as const, detail: { to: 'Build the table', blockerId: 'B' } }
  assert.deepEqual(readerDetail(entry, false, 'Build the table, v2'), { to: 'Build the table, v2' })
  assert.deepEqual(readerDetail(entry, false, null), { to: 'Build the table' })
  assert.deepEqual(readerDetail(entry, true, 'Build the table, v2'), { to: 'Build the table' }, 'the customer keeps the stored text')
  assert.equal(readerDetail(entry, false, 'x'.repeat(120)).to?.length, 80, 'a live title is cut like a stored one')
  assert.deepEqual(readerDetail({ kind: 'moved', detail: { from: 'Todo', to: 'Done' } }, false, 'x'), { from: 'Todo', to: 'Done' })
})

test('a trashed blocker keeps its stored text for staff; a live one shows its title; the id never reaches a reader', () => {
  const titles = liveTitlesOf([
    { id: 'B', title: 'Build the table, v2', deletedAt: null },
    { id: 'T', title: 'Trashed', deletedAt: 1700000000000 }
  ])
  assert.equal(titles.get('B'), 'Build the table, v2')
  assert.equal(titles.has('T'), false)
  const trashed = { kind: 'blocker_added' as const, detail: { to: 'Build the table', blockerId: 'T' } }
  assert.deepEqual(readerDetail(trashed, false, titles.get('T') ?? null), { to: 'Build the table' })
  for (const forCustomer of [true, false]) {
    assert.equal('blockerId' in readerDetail(trashed, forCustomer, 'x'), false)
  }
})

test('the inbox reads the two link kinds in plain words', () => {
  assert.equal(briefOf({ kind: 'blocker_added', detail: { to: 'Build the table' } }), 'Waits for Build the table')
  assert.equal(briefOf({ kind: 'blocker_removed', detail: { from: 'a hidden task' } }), 'No longer waits for a hidden task')
})
