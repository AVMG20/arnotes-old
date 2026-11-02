// The live cases of the update tools (GH #37, slice A): the real MCP endpoint of a running dev server, with real
// keys. Env-gated like agent-events.test.ts, so a plain run skips them:
//   UPDATE_TOOLS_LIVE=1 UPDATE_TOOLS_BASE=http://localhost:3000 UPDATE_TOOLS_KEY=<staff key, board A> \
//   UPDATE_TOOLS_TASK=<card on board A> UPDATE_TOOLS_OTHER_TASK=<another card on board A> \
//   [UPDATE_TOOLS_READ_KEY=<key with boards:read only, same workspace>] \
//   [UPDATE_TOOLS_OTHER_TEAM_KEY=<key of another team or workspace>] \
//   node --import tsx --test tests/task-update-tools-live.test.ts
// The keys are read from the environment and never printed. Every update a case posts is deleted again.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

const BASE = process.env.UPDATE_TOOLS_BASE ?? 'http://localhost:3000'
const KEY = process.env.UPDATE_TOOLS_KEY ?? ''
const TASK = process.env.UPDATE_TOOLS_TASK ?? ''
const OTHER_TASK = process.env.UPDATE_TOOLS_OTHER_TASK ?? ''
const READ_KEY = process.env.UPDATE_TOOLS_READ_KEY ?? ''
const OTHER_TEAM_KEY = process.env.UPDATE_TOOLS_OTHER_TEAM_KEY ?? ''
const LIVE = process.env.UPDATE_TOOLS_LIVE === '1' && !!KEY && !!TASK && !!OTHER_TASK

interface Reply {
  isError: boolean
  text: string
}

async function call(key: string, name: string, args: Record<string, unknown>): Promise<Reply> {
  const res = await fetch(`${BASE}/api/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', 'authorization': `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  })
  const body = await res.json() as { result?: { isError?: boolean, content?: { text?: string }[] }, error?: { message?: string } }
  if (body.error) return { isError: true, text: body.error.message ?? 'error' }
  return { isError: body.result?.isError === true, text: body.result?.content?.[0]?.text ?? '' }
}

async function post(key: string, task: string, body: string, replyTo?: string): Promise<string> {
  const reply = await call(key, 'post_task_update', { id: task, body, ...(replyTo ? { replyTo } : {}) })
  assert.equal(reply.isError, false, reply.text)
  return (JSON.parse(reply.text) as { update: { id: string } }).update.id
}

async function remove(key: string, task: string, updateId: string) {
  await call(key, 'delete_task_update', { id: task, updateId })
}

async function thread(key: string, task: string): Promise<string> {
  const reply = await call(key, 'get_task', { id: task })
  assert.equal(reply.isError, false, reply.text)
  return reply.text
}

describe('live: the update tools against the dev server', { skip: !LIVE }, () => {
  test('a read-only key is refused both tools', { skip: !READ_KEY }, async () => {
    const edit = await call(READ_KEY, 'edit_task_update', { id: TASK, updateId: 'x', body: 'y' })
    const del = await call(READ_KEY, 'delete_task_update', { id: TASK, updateId: 'x' })
    assert.equal(edit.isError, true)
    assert.equal(del.isError, true)
    assert.match(edit.text, /does not carry the "boards:write" permission/)
    assert.match(del.text, /does not carry the "boards:write" permission/)
  })

  test('another team\'s key cannot edit or delete an update, and the update is unchanged', { skip: !OTHER_TEAM_KEY }, async () => {
    const id = await post(KEY, TASK, 'live probe: another team must not touch this')
    try {
      const edit = await call(OTHER_TEAM_KEY, 'edit_task_update', { id: TASK, updateId: id, body: 'changed by another team' })
      const del = await call(OTHER_TEAM_KEY, 'delete_task_update', { id: TASK, updateId: id })
      assert.equal(edit.isError, true)
      assert.equal(del.isError, true)
      assert.match(await thread(KEY, TASK), /live probe: another team must not touch this/)
    } finally {
      await remove(KEY, TASK, id)
    }
  })

  test('an update id from another card is not reachable through this card', async () => {
    const id = await post(KEY, OTHER_TASK, 'live probe: belongs to the other card')
    try {
      const edit = await call(KEY, 'edit_task_update', { id: TASK, updateId: id, body: 'idor' })
      const del = await call(KEY, 'delete_task_update', { id: TASK, updateId: id })
      assert.equal(edit.isError, true)
      assert.equal(del.isError, true)
      assert.equal(edit.text, `No update with id "${id}" on this task.`)
      assert.equal(del.text, `No update with id "${id}" on this task.`)
    } finally {
      await remove(KEY, OTHER_TASK, id)
    }
  })

  test('edit, same-text edit, double delete and edit after delete each get a clean answer', async () => {
    const id = await post(KEY, TASK, 'live probe: lifecycle')
    const edited = await call(KEY, 'edit_task_update', { id: TASK, updateId: id, body: 'live probe: lifecycle, edited' })
    assert.equal(edited.isError, false, edited.text)
    assert.equal(typeof (JSON.parse(edited.text) as { update: { editedAt: unknown } }).update.editedAt, 'number')

    const same = await call(KEY, 'edit_task_update', { id: TASK, updateId: id, body: 'live probe: lifecycle, edited' })
    assert.equal(same.isError, true)
    assert.equal(same.text, 'The update already says that, so nothing changed.')

    const deleted = await call(KEY, 'delete_task_update', { id: TASK, updateId: id })
    assert.equal(deleted.isError, false, deleted.text)

    const again = await call(KEY, 'delete_task_update', { id: TASK, updateId: id })
    assert.equal(again.text, `No update with id "${id}" on this task.`)

    const after = await call(KEY, 'edit_task_update', { id: TASK, updateId: id, body: 'too late' })
    assert.equal(after.text, `No update with id "${id}" on this task.`)
  })

  test('a reply to a deleted update stays, reads as deleted and gives no id of the parent', async () => {
    const parent = await post(KEY, TASK, 'live probe: parent')
    const reply = await post(KEY, TASK, 'live probe: reply to the parent', parent)
    try {
      await remove(KEY, TASK, parent)
      const text = await thread(KEY, TASK)
      assert.match(text, /live probe: reply to the parent/)
      assert.match(text, /"deleted":true/)
      assert.match(text, /a deleted update/)
      assert.equal(text.includes(parent), false, 'the deleted parent id must not appear')
    } finally {
      await remove(KEY, TASK, reply)
    }
  })
})
