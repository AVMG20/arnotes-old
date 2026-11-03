// "Blocked by" links (GH #36, slice 1): the pure model and the link table's shape. No database, no network.
//   node --import tsx --test tests/task-dependencies.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { taskDependencies } from '../server/db/schema'
import { checkNewLink, describeCycle, isBlocked, openBlockers } from '../server/utils/taskDependencies'
import type { TaskLink } from '../server/utils/taskDependencies'

const finishedSet = (ids: string[]) => (id: string) => ids.includes(id)

test('a link that would make two tasks wait for each other is refused, and the refusal names the loop', () => {
  const links: TaskLink[] = [{ blockedId: 'A', blockerId: 'B' }]
  const refusal = checkNewLink(links, 'B', 'A')
  assert.deepEqual(refusal, { reason: 'cycle', cycle: ['B', 'A', 'B'] })
  assert.equal(describeCycle(refusal!.reason === 'cycle' ? refusal!.cycle : [], id => `task ${id}`), 'task B -> task A -> task B')
})

test('a three-step loop is refused and the cycle lists every task in it', () => {
  const links: TaskLink[] = [
    { blockedId: 'A', blockerId: 'B' },
    { blockedId: 'B', blockerId: 'C' }
  ]
  const refusal = checkNewLink(links, 'C', 'A')
  assert.deepEqual(refusal, { reason: 'cycle', cycle: ['C', 'A', 'B', 'C'] })
})

test('a task cannot wait for itself, and the same link cannot be added twice', () => {
  assert.deepEqual(checkNewLink([], 'A', 'A'), { reason: 'self' })
  assert.deepEqual(checkNewLink([{ blockedId: 'A', blockerId: 'B' }], 'A', 'B'), { reason: 'duplicate' })
})

test('an ordinary link, and a second blocker for the same task, are allowed', () => {
  const links: TaskLink[] = [{ blockedId: 'A', blockerId: 'B' }]
  assert.equal(checkNewLink(links, 'A', 'C'), null)
  assert.equal(checkNewLink(links, 'C', 'A'), null)
  // a diamond is not a loop
  assert.equal(checkNewLink([{ blockedId: 'D', blockerId: 'B' }, { blockedId: 'D', blockerId: 'C' }, { blockedId: 'B', blockerId: 'A' }], 'C', 'A'), null)
})

test('a diamond that contains a cycle is refused, and every step of the named cycle is a real link', () => {
  // A waits for B and C; both wait for D; D would wait for A, which closes A -> B -> D -> A.
  const links: TaskLink[] = [
    { blockedId: 'A', blockerId: 'B' },
    { blockedId: 'A', blockerId: 'C' },
    { blockedId: 'B', blockerId: 'D' },
    { blockedId: 'C', blockerId: 'D' }
  ]
  const refusal = checkNewLink(links, 'D', 'A')
  assert.equal(refusal?.reason, 'cycle')
  const cycle = refusal!.reason === 'cycle' ? refusal!.cycle : []
  assert.equal(cycle[0], 'D')
  assert.equal(cycle[cycle.length - 1], 'D')
  assert.ok(cycle.includes('A'))
  const known = [...links, { blockedId: 'D', blockerId: 'A' }]
  for (let i = 0; i + 1 < cycle.length; i++) {
    assert.ok(known.some(l => l.blockedId === cycle[i] && l.blockerId === cycle[i + 1]), `step ${cycle[i]} -> ${cycle[i + 1]} is a link`)
  }
})

test('a chain of 1000 links is checked quickly, and closing it names all 1001 tasks', () => {
  // t0 waits for t1, t1 for t2 ... t999 for t1000. A new link t1000 waits for t0 closes the loop.
  const links: TaskLink[] = []
  for (let i = 0; i < 1000; i++) links.push({ blockedId: `t${i}`, blockerId: `t${i + 1}` })
  const started = Date.now()
  const refusal = checkNewLink(links, 't1000', 't0')
  const elapsed = Date.now() - started
  assert.equal(refusal?.reason, 'cycle')
  const cycle = refusal!.reason === 'cycle' ? refusal!.cycle : []
  assert.equal(cycle.length, 1002)
  assert.equal(cycle[0], 't1000')
  assert.equal(cycle[cycle.length - 1], 't1000')
  assert.ok(elapsed < 500, `the check took ${elapsed} ms`)
  // and an open chain is allowed, quickly
  assert.equal(checkNewLink(links, 't0', 't1500'), null)
})

test('a task with one unfinished blocker is blocked; with all blockers finished it is not', () => {
  const links: TaskLink[] = [
    { blockedId: 'A', blockerId: 'B' },
    { blockedId: 'A', blockerId: 'C' }
  ]
  assert.equal(isBlocked('A', links, finishedSet(['B'])), true)
  assert.deepEqual(openBlockers('A', links, finishedSet(['B'])), ['C'])
  assert.equal(isBlocked('A', links, finishedSet(['B', 'C'])), false)
  assert.deepEqual(openBlockers('A', links, finishedSet(['B', 'C'])), [])
})

test('a trashed blocker counts as finished (the caller says so), so it does not block; restoring it blocks again', () => {
  const links: TaskLink[] = [{ blockedId: 'A', blockerId: 'B' }]
  const trashedB = finishedSet(['B'])
  assert.equal(isBlocked('A', links, trashedB), false)
  const restoredB = finishedSet([])
  assert.equal(isBlocked('A', links, restoredB), true)
})

test('a task with no blockers is not blocked, and a finished task still reports its own state only', () => {
  assert.equal(isBlocked('A', [], finishedSet([])), false)
  // B is blocked by A; A being finished does not make A blocked
  const links: TaskLink[] = [{ blockedId: 'B', blockerId: 'A' }]
  assert.equal(isBlocked('A', links, finishedSet(['A'])), false)
  assert.equal(isBlocked('B', links, finishedSet(['A'])), false)
})

test('the table is additive: its own name, its columns, a unique pair of blocked and blocker, and foreign keys to tasks', () => {
  const config = getTableConfig(taskDependencies)
  assert.equal(config.name, 'task_dependencies')
  const columns = config.columns.map(c => c.name).sort()
  assert.deepEqual(columns, ['blocked_task_id', 'blocker_task_id', 'created_at', 'created_by', 'id'])
  assert.equal(config.foreignKeys.length, 3)
  const unique = config.indexes.filter(i => i.config.unique)
  assert.equal(unique.length, 1, 'exactly one unique index')
  assert.equal(unique[0].config.name, 'task_dependencies_pair_idx')
  assert.deepEqual(unique[0].config.columns.map(c => (c as { name: string }).name), ['blocked_task_id', 'blocker_task_id'])
})
