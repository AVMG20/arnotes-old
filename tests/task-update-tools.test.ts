// The agent tools that edit and delete a task's own updates (GH #37, slice A). The rules that decide who may
// change an update, what an edit writes, what the audit row holds and that a reply keeps its target are
// checked here without a database. The workspace gate (findTask) and the live thread need the dev server.
//   node --import tsx --test tests/task-update-tools.test.ts
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { SQL } from 'drizzle-orm'
import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core'
import { taskComments } from '../server/db/schema'
import { MCP_UPDATE_TOOLS, editFields, missingUpdate, requireAuthorOf } from '../server/utils/mcpUpdateTools'
import { buildReplyPreview } from '../server/utils/taskComments'
import { makeDatabaseCardStore } from '../server/utils/githubCardStore'
import { toolsForScopes } from '../server/utils/mcpRegistry'
import { summaryOf } from '../server/utils/agentAudit'
import { buildAgentSkill } from '../server/utils/agentSkill'
import { McpToolError } from '../server/utils/mcpToolKit'
import type { McpToolDefinition } from '../server/utils/mcpToolKit'

const ANN = 'user-ann'
const BEN = 'user-ben'
const SECRET = 'the quarterly salary figures are wrong'

function toolNamed(name: string): McpToolDefinition {
  const tool = MCP_UPDATE_TOOLS.find(candidate => candidate.name === name)
  assert.ok(tool, `${name} is registered`)
  return tool
}

const EDIT = toolNamed('edit_task_update')
const DELETE = toolNamed('delete_task_update')

function refusal(action: () => void): string {
  try {
    action()
  } catch (error) {
    assert.ok(error instanceof McpToolError, 'a refusal the model can read')
    return error.message
  }
  throw new Error('expected a refusal')
}

describe('who may change an update', () => {
  const posted = (userId: string, visibility: 'internal' | 'customer', createdVia: 'mcp' | 'ui' | 'ai' = 'mcp') => ({ userId, visibility, createdVia })

  test('the author may change what an agent posted for them', () => {
    requireAuthorOf(posted(ANN, 'internal'), { userId: ANN }, 'staff')
  })

  test('another user cannot change it, even on the same board', () => {
    const message = refusal(() => requireAuthorOf(posted(ANN, 'internal'), { userId: BEN }, 'staff'))
    assert.match(message, /Only the author can change this update/)
  })

  test('a teammate cannot change a customer-visible update they did not write', () => {
    refusal(() => requireAuthorOf(posted(ANN, 'customer'), { userId: BEN }, 'staff'))
  })

  test('the owner\'s own update typed in the app is not changed by an agent', () => {
    const message = refusal(() => requireAuthorOf(posted(ANN, 'internal', 'ui'), { userId: ANN }, 'staff'))
    assert.match(message, /An agent can change only an update an agent posted/)
  })

  test('a customer contact may change their own customer-visible update', () => {
    requireAuthorOf(posted('user-casey', 'customer'), { userId: 'user-casey' }, 'customer')
  })

  test('a customer contact cannot change another person\'s customer-visible update', () => {
    refusal(() => requireAuthorOf(posted(ANN, 'customer'), { userId: 'user-casey' }, 'customer'))
  })

  test('a customer contact is told an internal update does not exist, even one they wrote', () => {
    const message = refusal(() => requireAuthorOf(posted('user-casey', 'internal'), { userId: 'user-casey' }, 'customer'))
    assert.match(message, /^No update with that id on this task\.$/)
  })
})

describe('what an edit writes', () => {
  test('it sets the new text and the time, and nothing else', () => {
    const fields = editFields('a corrected line', 1_700_000_000_000)
    assert.deepEqual(Object.keys(fields).sort(), ['body', 'editedAt'])
    assert.equal(fields.body, 'a corrected line')
    assert.equal(fields.editedAt, 1_700_000_000_000)
  })

  test('visibility and the reply target are never part of an edit', () => {
    const fields = editFields('changed', 1)
    assert.equal('visibility' in fields, false)
    assert.equal('replyToId' in fields, false)
  })
})

describe('the tool definitions', () => {
  test('both tools are writes that need boards:write', () => {
    for (const tool of [EDIT, DELETE]) {
      assert.equal(tool.scope, 'boards:write')
      assert.equal(tool.readOnly, false)
    }
  })

  test('each takes the task and the update id, and the edit takes the new text only', () => {
    assert.deepEqual(EDIT.inputSchema.required, ['id', 'updateId', 'body'])
    assert.deepEqual(DELETE.inputSchema.required, ['id', 'updateId'])
    assert.equal('visibility' in EDIT.inputSchema.properties, false)
  })

  test('a delete is advertised as destructive, because it cannot be undone', () => {
    assert.equal(DELETE.destructive, true)
  })
})

describe('the agent audit row', () => {
  const editResult = {
    edited: true,
    board: { id: 'board-1', name: 'Board' },
    task: { id: 'task-1', title: 'Card' },
    update: { id: 'upd-42', visibility: 'internal', length: SECRET.length, editedAt: 1, replyTo: null, excerpt: SECRET }
  }

  test('an edit names the update and its length, never the text', () => {
    const summary = summaryOf(EDIT, { id: 'task-1', updateId: 'upd-42', body: SECRET }, editResult)
    assert.match(summary, /upd-42/)
    assert.match(summary, new RegExp(`${SECRET.length} characters`))
    assert.equal(summary.includes('salary'), false)
    assert.equal(summary.includes(SECRET), false)
  })

  test('a delete names the update and its length, and says who it was for, never the text', () => {
    const summary = summaryOf(DELETE, { id: 'task-1', updateId: 'upd-42' }, {
      deleted: true,
      update: { id: 'upd-42', visibility: 'customer', length: SECRET.length, excerpt: SECRET }
    })
    assert.match(summary, /Deleted an update for the customer/)
    assert.match(summary, /upd-42/)
    assert.equal(summary.includes('salary'), false)
  })

  test('a delete for the team says so', () => {
    const summary = summaryOf(DELETE, { id: 'task-1', updateId: 'upd-7' }, { deleted: true, update: { id: 'upd-7', visibility: 'internal', length: 3 } })
    assert.match(summary, /for the team/)
  })
})

describe('reply targets after a delete', () => {
  test('replyToId has no foreign key, so a reply keeps its target id when the parent is deleted', () => {
    const { foreignKeys } = getTableConfig(taskComments)
    const onReply = foreignKeys.filter(fk => fk.reference().columns.some(column => column.name === 'reply_to_id'))
    assert.equal(onReply.length, 0)
  })
})

describe('the served skill', () => {
  test('describes both tools, the author rule and that a delete is for good', () => {
    const skill = buildAgentSkill('https://example.test')
    assert.match(skill, /### Task updates/)
    assert.match(skill, /`edit_task_update`/)
    assert.match(skill, /`delete_task_update`/)
    assert.match(skill, /gone at once/)
    assert.match(skill, /can be changed or removed by its author/)
  })
})

describe('a key only reaches the update tools with boards:write', () => {
  test('a read-only key is not offered edit or delete', () => {
    const names = toolsForScopes(['boards:read']).map(tool => tool.name)
    assert.equal(names.includes('edit_task_update'), false)
    assert.equal(names.includes('delete_task_update'), false)
  })

  test('a write key is offered both', () => {
    const names = toolsForScopes(['boards:write']).map(tool => tool.name)
    assert.equal(names.includes('edit_task_update'), true)
    assert.equal(names.includes('delete_task_update'), true)
  })
})

describe('an update that is gone', () => {
  test('a missing, hidden or vanished update gets one clean answer, never a server error', () => {
    const error = missingUpdate('upd-9')
    assert.ok(error instanceof McpToolError)
    assert.equal(error.message, 'No update with id "upd-9" on this task.')
  })
})

describe('a reply to a deleted update', () => {
  test('reads as a deleted update, with no id of the parent', () => {
    const preview = buildReplyPreview('gone-parent-id', new Map(), 'customer')
    assert.deepEqual(preview, { id: null, authorName: null, excerpt: 'a deleted update', deleted: true })
    assert.equal(JSON.stringify(preview).includes('gone-parent-id'), false)
  })

  test('is the same for a staff reader', () => {
    const preview = buildReplyPreview('gone-parent-id', new Map(), 'staff')
    assert.equal(preview?.deleted, true)
    assert.equal(JSON.stringify(preview).includes('gone-parent-id'), false)
  })
})

describe('the GitHub syncer marker match', () => {
  test('only matches updates typed in the app (createdVia ui)', async () => {
    let captured: unknown = null
    const fake = {
      select: () => ({
        from: () => ({
          where: (condition: unknown) => {
            captured = condition
            return { limit: async () => [] }
          }
        })
      })
    }
    const store = makeDatabaseCardStore(fake as unknown as Parameters<typeof makeDatabaseCardStore>[0])
    const found = await store.hasUpdate({ id: 'task-1' } as never, '<!-- marker -->')
    assert.equal(found, false)
    const rendered = new PgDialect().sqlToQuery(captured as SQL)
    assert.match(rendered.sql, /"created_via"/)
    assert.ok(rendered.params.includes('ui'))
  })
})
