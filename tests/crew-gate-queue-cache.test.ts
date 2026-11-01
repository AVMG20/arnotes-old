// The crew gate's window-row cache (at most two seconds) and its bounded audit queue (dropped and
// counted on overflow). Pure: no database. The cache's clearing on open, close and expiry is
// covered by the live cases in crew-gate.test.ts.
//   node --import tsx --test tests/crew-gate-queue-cache.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_TTL_MS, readThrough, TtlCache } from '../server/utils/ttlCache'
import { BoundedQueue } from '../server/utils/boundedQueue'

test('the cache returns what was stored while it is fresh', () => {
  const cache = new TtlCache<string>()
  assert.equal(cache.get(0), undefined)
  cache.set('open', 1_000)
  assert.equal(cache.get(1_000), 'open')
  assert.equal(cache.get(2_999), 'open')
})

test('the cache answers nothing after two seconds, so the next read goes to the database', () => {
  const cache = new TtlCache<string>()
  cache.set('closed', 1_000)
  assert.equal(cache.get(1_000 + MAX_TTL_MS), undefined)
  assert.equal(cache.get(1_000 + MAX_TTL_MS + 1), undefined)
})

test('a longer time asked for is capped at two seconds', () => {
  const cache = new TtlCache<string>(60_000)
  cache.set('x', 0)
  assert.equal(cache.get(MAX_TTL_MS - 1), 'x')
  assert.equal(cache.get(MAX_TTL_MS), undefined)
})

test('clear drops the stored value at once, so an open or close is seen by the next read', () => {
  const cache = new TtlCache<string>()
  cache.set('open', 1_000)
  cache.clear()
  assert.equal(cache.get(1_001), undefined)
})

test('the queue keeps items oldest first and empties on drain', () => {
  const queue = new BoundedQueue<number>(5)
  queue.push(1)
  queue.push(2)
  queue.push(3)
  assert.equal(queue.length, 3)
  assert.deepEqual(queue.drain(), [1, 2, 3])
  assert.equal(queue.length, 0)
  assert.deepEqual(queue.drain(), [])
})

test('past its size the queue drops new items and counts them, without growing', () => {
  const queue = new BoundedQueue<number>(3)
  assert.equal(queue.push(1), true)
  assert.equal(queue.push(2), true)
  assert.equal(queue.push(3), true)
  assert.equal(queue.push(4), false)
  assert.equal(queue.push(5), false)
  assert.equal(queue.length, 3)
  assert.equal(queue.dropped, 2)
  assert.deepEqual(queue.drain(), [1, 2, 3], 'the items kept are the first ones')
})

test('after a drain the queue has room again and the drop count keeps its total', () => {
  const queue = new BoundedQueue<number>(1)
  queue.push(1)
  queue.push(2)
  assert.deepEqual(queue.drain(), [1])
  assert.equal(queue.push(3), true)
  assert.equal(queue.dropped, 1)
})

test('a close is visible to the very next read once the cache is cleared', async () => {
  const cache = new TtlCache<string>()
  let stored = 'open'
  const load = async () => stored

  assert.equal(await readThrough(cache, 1_000, load), 'open')
  stored = 'closed' // the window is shut in the database
  assert.equal(await readThrough(cache, 1_100, load), 'open', 'within two seconds the cached row is used')

  cache.clear() // what a close does in the process that made it
  assert.equal(await readThrough(cache, 1_101, load), 'closed', 'the very next read sees the close')
})

test('a read through the cache loads the database only when the value is missing or stale', async () => {
  const cache = new TtlCache<string>()
  let loads = 0
  const load = async () => {
    loads++
    return 'row'
  }
  await readThrough(cache, 0, load)
  await readThrough(cache, 1_500, load)
  assert.equal(loads, 1, 'a second read inside the window is served from the cache')
  await readThrough(cache, 1_500 + MAX_TTL_MS, load)
  assert.equal(loads, 2, 'after two seconds it loads again')
})
