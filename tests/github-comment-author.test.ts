// Who a GitHub sync copy reads as, on the server: the comments route, get_task, reply previews, and the
// syncer's own check for its markers. A copy is stored under the project owner's account; no reader may
// show that name for it. Run with the Nuxt server path aliases:
//   TSX_TSCONFIG_PATH=.nuxt/tsconfig.server.json node --import tsx --test tests/github-comment-author.test.ts
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { buildReplyPreview, signedName } from '../server/utils/taskComments'
import { makeDatabaseCardStore } from '../server/utils/githubCardStore'
import type { CardTask } from '../server/utils/githubCards'

const OWNER = 'Wick Worker'

describe('signedName (comments route, get_task)', () => {
  test('a GitHub copy is GitHub, never the owner', () => {
    assert.equal(signedName({ createdVia: 'github', userName: OWNER }), 'GitHub')
  })

  test('a person in the app keeps their own name; an agent update keeps the name the reader already had', () => {
    assert.equal(signedName({ createdVia: 'ui', userName: OWNER }), OWNER)
    assert.equal(signedName({ createdVia: 'mcp', userName: OWNER }), OWNER)
    assert.equal(signedName({ createdVia: 'ai', userName: null }), null)
  })
})

describe('buildReplyPreview', () => {
  const parentRow = (createdVia: string, extra: { keyName?: string | null, body?: string } = {}) => new Map([
    ['p1', { id: 'p1', body: extra.body ?? 'a comment', visibility: 'customer', userName: OWNER, keyName: extra.keyName ?? null, createdVia }]
  ])

  test('a reply to a GitHub copy names GitHub', () => {
    const preview = buildReplyPreview('p1', parentRow('github'), 'staff')
    assert.equal(preview?.authorName, 'GitHub')
    assert.equal(preview?.deleted, false)
  })

  test('a reply to a person names the person; to an agent, its key', () => {
    assert.equal(buildReplyPreview('p1', parentRow('ui'), 'staff')?.authorName, OWNER)
    assert.equal(buildReplyPreview('p1', parentRow('mcp', { keyName: 'Claude Code' }), 'staff')?.authorName, 'Claude Code')
  })

  test('a contact is not shown an internal GitHub copy at all', () => {
    const internal = new Map([['p1', { id: 'p1', body: 'x', visibility: 'internal', userName: OWNER, keyName: null, createdVia: 'github' }]])
    assert.equal(buildReplyPreview('p1', internal, 'customer'), null)
  })
})

describe('the syncer checks its own markers', () => {
  // A fake database that records the WHERE clause hasUpdate sends, so the test sees the real SQL parameters.
  function recordingStore() {
    const seen: unknown[] = []
    const database = {
      select: () => ({
        from: () => ({
          where: (condition: unknown) => {
            seen.push(condition)
            return { limit: async () => [] }
          }
        })
      })
    }
    return { store: makeDatabaseCardStore(database as never), seen }
  }
  const task = { id: 'task-1', projectId: 'p', title: 't', description: '', tags: [], visibility: 'internal', completedAt: null, trashed: false } as CardTask

  test('a marker in a GitHub copy counts, and one in an older owner copy counts too', async () => {
    const { store, seen } = recordingStore()
    assert.equal(await store.hasUpdate(task, 'marker'), false)
    const query = new PgDialect().sqlToQuery(seen[0] as SQL)
    assert.ok(query.params.includes('github'), 'github copies are searched')
    assert.ok(query.params.includes('ui'), 'older copies (written as ui) are still searched')
  })

  test('an agent update never counts as a marker', async () => {
    const { store, seen } = recordingStore()
    await store.hasUpdate(task, 'marker')
    const query = new PgDialect().sqlToQuery(seen[0] as SQL)
    assert.ok(!query.params.includes('mcp'))
    assert.ok(!query.params.includes('ai'))
  })
})
