// Taskmanager' MCP server, spoken over the Streamable HTTP transport: one JSON-RPC
// request per POST, answered with a single JSON response. There is no session
// state, so any agent that can send an `Authorization: Bearer` header can
// connect, and every request is authorised on its own.
import { authenticateApiKey, hasScope } from '../../utils/api-keys'
import type { ApiKeyContext } from '../../utils/api-keys'
import { toolsForScopes } from '../../utils/mcpRegistry'
import { recordAgentAction } from '../../utils/agentAudit'
import { McpToolError } from '../../utils/mcpToolKit'
import { API_KEY_SCOPES } from '../../db/schema'
import type { ApiKeyScope } from '../../db/schema'
import { publish, workspaceTopic } from '../../utils/realtime'
import type { ProjectResource, RealtimeEvent, WorkspaceCollection } from '../../utils/realtime'

const SERVER_NAME = 'taskmanager'
const SERVER_VERSION = '0.1.0'

// Newest first. The client's requested version is echoed when we speak it,
// otherwise we answer with the newest one we do speak and let it decide.
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0]!

const INSTRUCTIONS = `Taskmanager is a kanban board app for projects and tasks.

A board has columns (kanban stages such as Backlog, To do, Verify, Done) holding tasks, a description and a health status (on_track, at_risk, off_track); a task has a title, a Markdown description, labels, an optional start and due date (YYYY-MM-DD), an optional assignee, a done mark that is separate from its column, custom fields such as Priority or Estimate (list_fields shows them; set them with "fields" on create_task and update_task), and a running log of short updates. A board also keeps a history of status updates: read it with list_status_updates and add to it with post_status_update. Tasks can have their own subtask checklist in the app, but there is no tool here to manage subtasks yet.

Search or list before answering questions about the user's boards, and ground answers in what the tools return. Read the board with get_board before creating or moving tasks so board, column and task names match. When editing, send the complete replacement description rather than a fragment — read the task first if you are only changing part of it.

The list-shaped results are deliberately short: get_board and search_tasks return each task as its card — title, labels and the opening of the description, ending in an ellipsis when there is more. Read one thing in full with get_task rather than asking a board for every description at once.

Nothing here deletes permanently, with one exception: delete_task_update removes an update for good, with no trash. delete_column and delete_task move things to the trash, undone with restore_column and restore_task, and the user can see and restore both under "Show trashed" on the board itself. A board's trash is emptied after 7 days.

There is no tool for deleting a board — that stays with the user, in the app. Deleting is still the wrong move most of the time: a finished task belongs in a "Done" column via move_task, not in the trash. Say what you are about to delete and why before you do it, and when a delete turns out to be wrong, restore it rather than recreating it — a restored task keeps its updates and its place on the board.`

const JSON_RPC_VERSION = '2.0'

const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603
} as const

type JsonRpcId = string | number | null

interface JsonRpcMessage {
  jsonrpc?: unknown
  id?: JsonRpcId
  method?: unknown
  params?: unknown
}

function result(id: JsonRpcId, value: unknown) {
  return { jsonrpc: JSON_RPC_VERSION, id, result: value }
}

function failure(id: JsonRpcId, code: number, message: string) {
  return { jsonrpc: JSON_RPC_VERSION, id, error: { code, message } }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

const ALL_SCOPES: ApiKeyScope[] = [...API_KEY_SCOPES]

/**
 * Tells the workspace's open browsers that an agent changed something, so a
 * board on screen refreshes instead of going stale. Board results carry the
 * board they touched; anything else falls back to the coarse signal.
 */
function announceWrite(tool: { scope: ApiKeyScope, resource?: ProjectResource, collection?: WorkspaceCollection }, value: unknown, context: ApiKeyContext) {
  if (tool.scope !== 'boards:write') return

  const topic = workspaceTopic(context.userId, context.teamId)
  // Goals and portfolios are not a board's: they announce their own list and nothing else.
  if (tool.collection) {
    void publish(topic, { type: 'collection', collection: tool.collection })
    return
  }
  const record = asRecord(value)
  const board = asRecord(value).board
  const projectId = typeof board === 'object' && board !== null
    ? (board as Record<string, unknown>).id
    : undefined

  const event: RealtimeEvent = typeof projectId === 'string'
    ? { type: 'board', projectId }
    // Creating or renaming a board changes the list itself, and the client
    // reloads the open board along with it. The board-shaped results carry
    // their own id, which a renamed board's readers need.
    : { type: 'projects', ...(typeof record.id === 'string' && { projectId: record.id }) }
  void publish(topic, event)
  if (tool.resource && typeof projectId === 'string') void publish(topic, { type: 'resource', projectId, resource: tool.resource })
}

/** Tool failures are reported inside the result so the model can read and retry them. */
function toolFailure(id: JsonRpcId, message: string) {
  return result(id, { content: [{ type: 'text', text: message }], isError: true })
}

async function handleMessage(message: JsonRpcMessage, context: ApiKeyContext) {
  const id = message.id ?? null

  if (message.jsonrpc !== JSON_RPC_VERSION || typeof message.method !== 'string') {
    return failure(id, ErrorCode.InvalidRequest, 'Expected a JSON-RPC 2.0 request with a "method".')
  }

  const method = message.method
  const params = asRecord(message.params)

  // Notifications carry no id and get no reply.
  if (method.startsWith('notifications/')) return null

  switch (method) {
    case 'initialize': {
      const requested = params.protocolVersion
      const protocolVersion = typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : LATEST_PROTOCOL_VERSION

      return result(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, title: 'Taskmanager', version: SERVER_VERSION },
        instructions: INSTRUCTIONS
      })
    }

    case 'ping':
      return result(id, {})

    case 'tools/list':
      return result(id, {
        tools: toolsForScopes(context.scopes).map(tool => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: {
            title: tool.title,
            readOnlyHint: tool.readOnly,
            destructiveHint: tool.destructive === true,
            idempotentHint: tool.readOnly
          }
        }))
      })

    case 'tools/call': {
      const name = params.name
      if (typeof name !== 'string') {
        return failure(id, ErrorCode.InvalidParams, 'Expected a tool "name".')
      }

      const tool = toolsForScopes(context.scopes).find(candidate => candidate.name === name)
      if (!tool) {
        // A tool that exists but is out of scope gets a message the model can act
        // on, rather than one that reads like a client bug.
        const outOfScope = toolsForScopes(ALL_SCOPES).find(candidate => candidate.name === name)
        return outOfScope
          ? toolFailure(id, `This API key does not carry the "${outOfScope.scope}" permission that "${name}" requires.`)
          : failure(id, ErrorCode.MethodNotFound, `Unknown tool "${name}".`)
      }

      try {
        const value = await tool.handler(asRecord(params.arguments), context)
        if (!tool.readOnly) announceWrite(tool, value, context)
        // Only what succeeded is recorded; the recording never fails or slows the call.
        if (tool.audit ?? !tool.readOnly) void recordAgentAction(tool, asRecord(params.arguments), value, context)
        // Compact rather than indented: a model reads either the same, and the
        // whitespace is a fifth of a large board's payload.
        return result(id, { content: [{ type: 'text', text: JSON.stringify(value) }] })
      } catch (error) {
        if (error instanceof McpToolError) return toolFailure(id, error.message)
        console.error(`[mcp] ${name} failed`, error)
        return toolFailure(id, `The "${name}" tool failed. Check the Taskmanager server logs for details.`)
      }
    }

    // Advertised capabilities cover tools only, but clients probe these anyway.
    case 'resources/list':
      return result(id, { resources: [] })
    case 'prompts/list':
      return result(id, { prompts: [] })

    default:
      return failure(id, ErrorCode.MethodNotFound, `Unknown method "${method}".`)
  }
}

export default defineEventHandler(async (event) => {
  let context: ApiKeyContext
  try {
    context = await authenticateApiKey(event)
  } catch (error) {
    // Point unauthenticated clients at the scheme they should use.
    setResponseHeader(event, 'WWW-Authenticate', 'Bearer realm="Taskmanager MCP"')
    throw error
  }

  if (!ALL_SCOPES.some(scope => hasScope(context, scope))) {
    throw createError({ statusCode: 403, message: 'This API key carries no permissions' })
  }

  const raw = await readRawBody(event, 'utf8')
  let payload: unknown
  try {
    payload = JSON.parse(raw || '')
  } catch {
    setResponseStatus(event, 400)
    return failure(null, ErrorCode.ParseError, 'Request body is not valid JSON.')
  }

  // JSON-RPC batches were dropped in the current MCP revision but older clients
  // still send them, so both shapes are accepted.
  const messages = Array.isArray(payload) ? payload : [payload]
  if (!messages.length) {
    setResponseStatus(event, 400)
    return failure(null, ErrorCode.InvalidRequest, 'Request body is empty.')
  }

  const responses = (await Promise.all(
    messages.map(message => handleMessage(asRecord(message) as JsonRpcMessage, context))
  )).filter(response => response !== null)

  // Nothing but notifications — acknowledge without a body, as the transport requires.
  if (!responses.length) {
    setResponseStatus(event, 202)
    return null
  }

  setResponseHeader(event, 'Content-Type', 'application/json')
  return Array.isArray(payload) ? responses : responses[0]
})
