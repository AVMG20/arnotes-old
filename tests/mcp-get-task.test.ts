// get_task's thread options: limit, order, since (its shape), prefix, the thread cap, and
// the customer rule. Fake rows only where the database is not needed. Run:
//   node --import tsx --test tests/mcp-get-task.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PgDialect } from 'drizzle-orm/pg-core'
import { readThreadOptions, selectUpdates, parseSinceTime, foldCase, capThread, THREAD_CAP, THREAD_CAP_NOTE, SINCE_REFUSAL } from '../server/utils/threadOptions'
import type { ThreadOptions } from '../server/utils/threadOptions'
import { commentVisibleTo, CUSTOMER_COMMENT_VISIBILITY } from '../server/utils/commentVisibility'
import { commentVisibilityFilter } from '../server/utils/auth-helpers'
import { McpToolError } from '../server/utils/mcpToolKit'

// Five updates, oldest first. Nothing here touches the database: the since cut is made there.
const rows = [
  { id: 'u1', body: 'NITPICKER: first pass', visibility: 'staff' },
  { id: 'u2', body: 'QUESTION: is the rate limit per key?', visibility: 'customer' },
  { id: 'u3', body: 'plain update', visibility: 'staff' },
  { id: 'u4', body: 'nitpicker: second pass', visibility: 'staff' },
  { id: 'u5', body: '  QUESTION: and the due date?', visibility: 'customer' }
]

const options = (overrides: Partial<ThreadOptions> = {}): ThreadOptions => ({ order: 'oldest', ...overrides })
const ids = (updates: { id: string }[]) => updates.map(update => update.id)
const refusal = (pattern: RegExp) => (error: unknown) => error instanceof McpToolError && pattern.test(error.message)

test('with no options every update comes back oldest first and the counts agree', () => {
  assert.deepEqual(readThreadOptions({}), { limit: undefined, order: 'oldest', since: undefined, prefix: undefined })
  const { shown, matched } = selectUpdates(rows, options(), 'staff')
  assert.deepEqual(ids(shown), ['u1', 'u2', 'u3', 'u4', 'u5'])
  assert.equal(matched, 5)
})

test('null limit, order and filters count as left out', () => {
  assert.deepEqual(readThreadOptions({ limit: null, order: null, since: null, prefix: null }), { limit: undefined, order: 'oldest', since: undefined, prefix: undefined })
})

test('limit keeps the oldest updates, and 1 and 200 are accepted', () => {
  const { shown, matched } = selectUpdates(rows, options({ limit: 2 }), 'staff')
  assert.deepEqual(ids(shown), ['u1', 'u2'])
  assert.equal(matched, 5)
  assert.deepEqual(ids(selectUpdates(rows, options({ limit: 1 }), 'staff').shown), ['u1'])
  assert.equal(readThreadOptions({ limit: 200 }).limit, 200)
})

test('order newest lists the thread newest first, and limit with it keeps the newest', () => {
  assert.deepEqual(ids(selectUpdates(rows, options({ order: 'newest' }), 'staff').shown), ['u5', 'u4', 'u3', 'u2', 'u1'])
  const newest = selectUpdates(rows, options({ order: 'newest', limit: 2 }), 'staff')
  assert.deepEqual(ids(newest.shown), ['u5', 'u4'])
  assert.equal(newest.matched, 5)
})

test('a zoned ISO time is read as the instant it names, with or without fractions', () => {
  const utc = Date.parse('2026-11-02T09:00:00Z')
  assert.equal(parseSinceTime('2026-11-02T09:00:00Z'), utc)
  assert.equal(parseSinceTime('2026-11-02T10:00:00+01:00'), utc)
  assert.equal(parseSinceTime('2026-11-02T04:00:00-05:00'), utc)
  assert.equal(parseSinceTime('2026-11-02T09:00:00.250Z'), utc + 250)
  assert.equal(parseSinceTime('2026-11-02T10:00:00.250+01:00'), utc + 250)
  assert.equal(parseSinceTime('2024-02-29T00:00:00Z'), Date.parse('2024-02-29T00:00:00Z'))
})

test('a time that is not a full zoned ISO 8601 time is refused, by round trip', () => {
  for (const bad of [
    '2026-02-30T10:00:00Z', // no such day: refused, not rolled over to March
    '2026-02-29T10:00:00Z', // 2026 is not a leap year
    '2026-13-01T10:00:00Z',
    '2026-11-02T25:00:00Z',
    '2026-11-02T10:00:00', // no zone
    '2026-11-02T10:00:00+24:00',
    '2026-11-02T10:00Z', // no seconds
    '2026-11-02T10:00:00Zjunk',
    '2026-11-02 (x)', // trailing text
    '2026-11-02'
  ]) {
    assert.equal(parseSinceTime(bad), undefined, bad)
  }
  // Something that starts like a date but is not a zoned time is refused before the database is asked.
  for (const bad of ['2026-02-30T10:00:00Z', '2026-11-02T10:00:00', '2026-11-02 (x)']) {
    assert.throws(() => readThreadOptions({ since: bad }), refusal(/ISO 8601 time with a zone.*update on this task/), bad)
  }
})

test('the since refusal names both accepted forms', () => {
  assert.throws(() => readThreadOptions({ since: '   ' }), refusal(/with a zone, such as 2026-11-02T10:00:00Z, or the id of an update on this task/))
  assert.match(SINCE_REFUSAL, /2026-11-02T10:00:00\.250\+01:00/)
  assert.match(SINCE_REFUSAL, /update on this task that you can see/)
})

test('a since that is neither a zoned time nor a date-shaped value is read as an update id', () => {
  assert.equal(readThreadOptions({ since: 'mvzu2kq5jzn7ikkjvi' }).since, 'mvzu2kq5jzn7ikkjvi')
})

test('prefix matches the start of the body, ignoring case, and ignores leading spaces', () => {
  assert.deepEqual(ids(selectUpdates(rows, options({ prefix: 'NITPICKER:' }), 'staff').shown), ['u1', 'u4'])
  assert.deepEqual(ids(selectUpdates(rows, options({ prefix: 'question' }), 'staff').shown), ['u2', 'u5'])
  assert.deepEqual(ids(selectUpdates(rows, options({ prefix: 'update' }), 'staff').shown), [])
})

test('prefix folds Greek final sigma, compatibility forms and Turkish dotted capitals', () => {
  const greek = [
    { body: 'ΟΔΟΣΑ: the road', visibility: 'staff' },
    { body: 'other', visibility: 'staff' }
  ]
  assert.equal(selectUpdates(greek, options({ prefix: 'ΟΔΟΣ' }), 'staff').matched, 1)
  assert.equal(selectUpdates(greek, options({ prefix: 'οδος' }), 'staff').matched, 1)
  assert.equal(selectUpdates(greek, options({ prefix: 'οδοσ' }), 'staff').matched, 1)
  assert.equal(foldCase('ΟΔΟΣ'), foldCase('οδος'))
  assert.equal(foldCase('ODOS'), foldCase('odos'))
  // The full-width form folds to the ordinary letters, on both sides.
  assert.equal(selectUpdates([{ body: 'ＡＢＣ item', visibility: 'staff' }], options({ prefix: 'abc' }), 'staff').matched, 1)
  // Turkish dotted capital I lower-cases to i plus a combining dot: no crash, and it matches itself.
  const turkish = [{ body: 'İstanbul note', visibility: 'staff' }]
  assert.equal(selectUpdates(turkish, options({ prefix: 'İst' }), 'staff').matched, 1)
  assert.equal(selectUpdates(turkish, options({ prefix: 'ist' }), 'staff').matched, 0)
})

test('filters apply before the limit, so matched counts the whole filtered set', () => {
  const { shown, matched } = selectUpdates(rows, options({ prefix: 'NITPICKER', limit: 1 }), 'staff')
  assert.deepEqual(ids(shown), ['u1'])
  assert.equal(matched, 2)
})

test('prefix, order and limit combine', () => {
  const latestQuestion = selectUpdates(rows, options({ prefix: 'QUESTION', order: 'newest', limit: 1 }), 'staff')
  assert.deepEqual(ids(latestQuestion.shown), ['u5'])
  assert.equal(latestQuestion.matched, 2)
})

test('a customer contact counts and sees only customer-visible updates, whatever the options', () => {
  const all = selectUpdates(rows, options(), 'customer')
  assert.deepEqual(ids(all.shown), ['u2', 'u5'])
  assert.equal(all.matched, 2)
  const nitpicks = selectUpdates(rows, options({ prefix: 'NITPICKER' }), 'customer')
  assert.deepEqual(nitpicks.shown, [])
  assert.equal(nitpicks.matched, 0)
  const newest = selectUpdates(rows, options({ order: 'newest', limit: 1 }), 'customer')
  assert.deepEqual(ids(newest.shown), ['u5'])
  assert.equal(newest.matched, 2)
})

test('the customer rule and the database filter agree', () => {
  const dialect = new PgDialect()
  assert.equal(commentVisibilityFilter('staff'), undefined)
  const customerFilter = commentVisibilityFilter('customer')
  assert.ok(customerFilter)
  const { params } = dialect.sqlToQuery(customerFilter)
  assert.deepEqual(params, [CUSTOMER_COMMENT_VISIBILITY])
  for (const visibility of ['customer', 'internal', 'staff']) {
    assert.equal(commentVisibleTo('staff', visibility), true)
    assert.equal(commentVisibleTo('customer', visibility), visibility === params[0])
  }
})

test('the thread is capped at 5000 updates, with a note that says to use since', () => {
  const thread = (count: number) => Array.from({ length: count }, (_, index) => ({ index }))
  assert.equal(capThread(thread(THREAD_CAP)).truncated, false)
  const capped = capThread(thread(THREAD_CAP + 1))
  assert.equal(capped.truncated, true)
  assert.equal(capped.rows.length, THREAD_CAP)
  assert.equal(capped.rows[THREAD_CAP - 1]?.index, THREAD_CAP - 1)
  assert.match(THREAD_CAP_NOTE, /thread longer than 5000, use since/)
})

test('an empty thread gives nothing and counts nothing', () => {
  assert.deepEqual(selectUpdates([], options({ limit: 3, order: 'newest' }), 'staff'), { shown: [], matched: 0 })
})

test('bad values are refused, and the message names what is valid', () => {
  const refuse = (args: Record<string, unknown>, pattern: RegExp) => assert.throws(() => readThreadOptions(args), refusal(pattern))
  refuse({ limit: 0 }, /1 to 200/)
  refuse({ limit: 201 }, /1 to 200/)
  refuse({ limit: 1.5 }, /1 to 200/)
  refuse({ limit: '2' }, /1 to 200/)
  refuse({ order: 'Newest' }, /"oldest" or "newest"/)
  refuse({ order: 3 }, /"oldest" or "newest"/)
  refuse({ prefix: '' }, /starts with, such as/)
  refuse({ prefix: 7 }, /starts with, such as/)
})
