// The owner's right to change any update on a board (GH #37, slice B): the board's owner, and a team's owner or
// admin, may edit or delete a teammate's update through the agent tools. Plain members, customer contacts and
// people off the team may not. The decision is checked here without a database; the live case is in
// task-update-tools-live.test.ts. Run with the Nuxt server path aliases:
//   TSX_TSCONFIG_PATH=.nuxt/tsconfig.server.json node --import tsx --test tests/task-update-owner.test.ts
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { MCP_UPDATE_TOOLS, managesAnyUpdate, requireAuthorOf } from '../server/utils/mcpUpdateTools'
import { summaryOf } from '../server/utils/agentAudit'
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

const posted = (userId: string, visibility: 'internal' | 'customer', createdVia: 'mcp' | 'ui' | 'ai' = 'mcp') => ({ userId, visibility, createdVia })
const teamBoard = { userId: ANN, teamId: 'team-1' }

describe('the board owner and team owners or admins may change any update', () => {
  test('a plain team member who is not the author is refused, as before', () => {
    const allowed = managesAnyUpdate(teamBoard, BEN, 'member')
    assert.equal(allowed, false)
    refusal(() => requireAuthorOf(posted(ANN, 'internal'), { userId: BEN }, 'staff', allowed))
  })

  test('the board owner may change a teammate update', () => {
    const allowed = managesAnyUpdate(teamBoard, ANN, 'member')
    assert.equal(allowed, true)
    requireAuthorOf(posted(BEN, 'internal', 'ui'), { userId: ANN }, 'staff', allowed)
  })

  test('a team owner or admin may change a teammate update on any board of the team', () => {
    requireAuthorOf(posted(BEN, 'internal'), { userId: 'user-cam' }, 'staff', managesAnyUpdate(teamBoard, 'user-cam', 'admin'))
    requireAuthorOf(posted(BEN, 'customer'), { userId: 'user-cam' }, 'staff', managesAnyUpdate(teamBoard, 'user-cam', 'owner'))
  })

  test('someone who is not on the team has no such right', () => {
    assert.equal(managesAnyUpdate(teamBoard, BEN, null), false)
  })

  test('a personal board has only its owner', () => {
    assert.equal(managesAnyUpdate({ userId: ANN, teamId: null }, ANN, null), true)
    assert.equal(managesAnyUpdate({ userId: ANN, teamId: null }, BEN, null), false)
  })

  test('a customer contact never gets the right, even on a customer-visible update', () => {
    const message = refusal(() => requireAuthorOf(posted(ANN, 'customer'), { userId: 'user-casey' }, 'customer', true))
    assert.match(message, /Only the author can change this update/)
  })
})

describe('the agent audit row for a change made by the owner', () => {
  test('an edit by the owner says so, with the update and its length, never the text', () => {
    const summary = summaryOf(EDIT, { id: 'task-1', updateId: 'upd-42', body: SECRET }, {
      edited: true,
      byOwner: true,
      update: { id: 'upd-42', visibility: 'internal', length: SECRET.length, editedAt: 1, replyTo: null, excerpt: SECRET }
    })
    assert.match(summary, /edited by owner/)
    assert.match(summary, /upd-42/)
    assert.equal(summary.includes('salary'), false)
  })

  test('a delete by the owner says so, never the text', () => {
    const summary = summaryOf(DELETE, { id: 'task-1', updateId: 'upd-42' }, {
      deleted: true,
      byOwner: true,
      update: { id: 'upd-42', visibility: 'internal', length: SECRET.length, excerpt: SECRET }
    })
    assert.match(summary, /deleted by owner/)
    assert.equal(summary.includes('salary'), false)
  })

  test('a change the author made to their own update does not say so', () => {
    const summary = summaryOf(DELETE, { id: 'task-1', updateId: 'upd-7' }, { deleted: true, byOwner: false, update: { id: 'upd-7', visibility: 'internal', length: 3 } })
    assert.equal(summary.includes('by owner'), false)
  })
})
