// The agent audit: one row per change an agent made through an API key, so the
// key's owner can read what it did in the Inbox, as if a colleague had done it.
// The MCP endpoint calls this once a tool has succeeded. Recording is best
// effort: any failure is logged and swallowed, so it can never fail or slow
// the agent's call.
import { eq, lt } from 'drizzle-orm'
import { db } from '../db'
import { agentAudit, projects, projectTasks } from '../db/schema'
import type { ApiKeyContext } from './api-keys'
import { idFromReference, newId } from './mcpToolKit'
import type { McpToolDefinition } from './mcpToolKit'
import { notificationExcerpt } from './notifications'
import { publishToUser } from './realtime'

const DAY_MS = 24 * 60 * 60 * 1000
const RETENTION_MS = 90 * DAY_MS
const PRUNE_INTERVAL_MS = 60 * 60 * 1000
const MAX_SUMMARY = 200

// The results of these tools are the board itself, so it is the board.
const BOARD_IS_RESULT = new Set(['create_board', 'update_board'])

// Tools whose task is named by an argument and not returned. The task is read
// back from the database by that id, so the row names the task that changed.
const TASK_ARGUMENT: Record<string, string> = {
  post_task_update: 'id',
  update_task: 'id',
  move_task: 'id',
  delete_task: 'id',
  restore_task: 'id',
  link_github: 'taskId',
  unlink_github: 'taskId'
}

// Arguments that name the target and are not a change, so they are left out of
// what update_task says it changed.
const TARGET_ARGUMENTS = new Set(['id', 'board', 'task', 'taskId', 'rule'])

// The results are read loosely: each entry only reads what its tool returns,
// and a missing field falls through to the title below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a result's shape is each tool's own; read loosely on purpose
type Loose = Record<string, any>
type Summary = (value: Loose, args: Record<string, unknown>) => string

const SECRET_NAMES_SHOWN = 5

function quote(text: unknown): string {
  return `"${String(text ?? '')}"`
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

function namesOf(items: { name: string }[]): string {
  const shown = items.slice(0, SECRET_NAMES_SHOWN).map(item => item.name).join(', ')
  return items.length > SECRET_NAMES_SHOWN ? `${shown}, ...` : shown
}

function secretsSummary(value: Loose): string {
  const saved: { name: string, action: string }[] = value.saved ?? []
  const created = saved.filter(entry => entry.action === 'created')
  const updated = saved.filter(entry => entry.action === 'updated')
  const parts: string[] = []
  if (created.length) parts.push(`Added ${plural(created.length, 'secret')} (${namesOf(created)})`)
  if (updated.length) parts.push(`Changed ${plural(updated.length, 'secret')} (${namesOf(updated)})`)
  return parts.join('; ') || 'Set the project secrets'
}

// What a person reads for each tool. Anything not listed falls back to the
// tool's title. Secrets only ever name themselves and count: never a value.
const SUMMARIES: Record<string, Summary> = {
  create_board: v => `Created the board ${quote(v.name)}`,
  update_board: v => v.renamedFrom ? `Renamed the board to ${quote(v.name)}` : `Changed the board ${quote(v.name)}`,
  create_column: v => `Added the column ${quote(v.column?.name)}`,
  update_column: v => `Changed the column ${quote(v.column?.name)}`,
  delete_column: v => `Deleted the column ${quote(v.column?.name)} (in the trash for 7 days)`,
  restore_column: v => v.alreadyActive
    ? `Restored the column ${quote(v.column)} (it was not in the trash)`
    : `Restored the column ${quote(v.column?.name)}`,
  create_task: v => `Created the task ${quote(v.task?.title)}`,
  update_task: (v, args) => {
    const changed = Object.keys(args).filter(key => !TARGET_ARGUMENTS.has(key))
    return `Updated the task ${quote(v.task?.title)}${changed.length ? ` (${changed.join(', ')})` : ''}`
  },
  move_task: v => v.from === v.to ? `Reordered in ${v.to}` : `Moved to ${v.to}`,
  delete_task: () => 'Deleted the task (in the trash for 7 days)',
  restore_task: v => v.alreadyActive ? 'Restored the task (it was not in the trash)' : 'Restored the task from the trash',
  post_message: v => `${v.message?.replyTo ? 'Replied to a message' : 'Posted a message'}: ${quote(v.message?.title ?? notificationExcerpt(v.message?.body ?? ''))}`,
  post_task_update: v => `Posted an update${v.update?.visibility === 'customer' ? ' for the customer' : ''}: ${quote(v.update?.excerpt)}`,
  post_status_update: v => `Posted a status update (${v.update?.status}): ${quote(notificationExcerpt(v.update?.body ?? ''))}`,
  create_field: v => `Added the field ${quote(v.field?.name)} (${v.field?.type})`,
  link_github: v => `Linked a GitHub ${v.kind} (${v.owner}/${v.repo} ${v.ref})`,
  unlink_github: () => 'Removed a GitHub link from the task',
  mark_notifications_read: (v, args) => args.all === true
    ? 'Marked all inbox notifications as read'
    : `Marked ${plural(v.marked ?? 0, 'inbox notification')} as read`,
  create_rule: v => `Added the rule ${quote(v.rule?.name)}`,
  update_rule: (v, args) => Object.keys(args).filter(key => key !== 'board' && key !== 'rule').join() === 'enabled'
    ? `Turned the rule ${quote(v.rule?.name)} ${v.rule?.enabled ? 'on' : 'off'}`
    : `Changed the rule ${quote(v.rule?.name)}`,
  create_goal: v => `Created the goal ${quote(v.title)}`,
  update_goal: v => `Changed the goal ${quote(v.title)}`,
  create_portfolio: v => `Created the portfolio ${quote(v.name)}`,
  update_portfolio: v => `Changed the portfolio ${quote(v.name)}`,
  log_time: v => `Logged ${v.entry?.duration} on the task`,
  set_project_secrets: secretsSummary,
  delete_project_secret: v => `Deleted the secret ${v.name}`,
  get_project_env: v => `Read the .env: ${plural(v.names?.length ?? 0, 'variable')}`
}

/** One line for the Inbox, plain text, never longer than the column allows. */
function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_SUMMARY ? `${flat.slice(0, MAX_SUMMARY - 1)}…` : flat
}

function summaryOf(tool: McpToolDefinition, args: Record<string, unknown>, value: unknown): string {
  try {
    const summary = SUMMARIES[tool.name]
    const text = summary ? summary((value ?? {}) as Loose, args) : tool.title
    return clip(text || tool.title)
  } catch {
    // A result that does not have the shape the table expects still gets a row.
    return clip(tool.title)
  }
}

function namedOf(value: unknown): { id: string, name: string } | null {
  const named = value as { id?: unknown, name?: unknown } | null
  return named && typeof named.id === 'string' && typeof named.name === 'string' ? { id: named.id, name: named.name } : null
}

/**
 * The board and task a change belongs to. The result names them when it can;
 * otherwise the task comes from the argument that named it, read back by id.
 * A row without a task or board is fine; a wrong one is not, so nothing is
 * guessed from titles.
 */
async function targetOf(tool: McpToolDefinition, args: Record<string, unknown>, value: Loose) {
  let board = namedOf(value.board) ?? (BOARD_IS_RESULT.has(tool.name) ? namedOf(value) : null)
  let task = value.task && typeof value.task.id === 'string' && typeof value.task.title === 'string'
    ? { id: value.task.id as string, title: value.task.title as string }
    : null

  const argument = TASK_ARGUMENT[tool.name]
  const reference = argument ? args[argument] : undefined
  if (!task && typeof reference === 'string' && reference.trim()) {
    const [row] = await db
      .select({ id: projectTasks.id, title: projectTasks.title, projectId: projectTasks.projectId })
      .from(projectTasks)
      .where(eq(projectTasks.id, idFromReference(reference, 'task')))
      .limit(1)
    if (row) {
      task = { id: row.id, title: row.title }
      if (!board) {
        const [project] = await db.select({ id: projects.id, name: projects.name }).from(projects).where(eq(projects.id, row.projectId)).limit(1)
        if (project) board = { id: project.id, name: project.name }
      }
    }
  }
  return { board, task }
}

// Pruning runs at most once an hour per process, from the write path.
let lastPrunedAt = 0

async function pruneOldRows(now: number) {
  if (now - lastPrunedAt < PRUNE_INTERVAL_MS) return
  lastPrunedAt = now
  await db.delete(agentAudit).where(lt(agentAudit.createdAt, now - RETENTION_MS))
}

/**
 * Records one successful change an agent made. Never throws: a failure is
 * logged and the agent's call goes on as if nothing happened.
 */
export async function recordAgentAction(
  tool: McpToolDefinition,
  args: Record<string, unknown>,
  value: unknown,
  context: ApiKeyContext
): Promise<void> {
  try {
    const now = Date.now()
    const { board, task } = await targetOf(tool, args, (value ?? {}) as Loose)

    await db.insert(agentAudit).values({
      id: newId(),
      userId: context.userId,
      apiKeyId: context.keyId,
      keyName: context.keyName,
      tool: tool.name,
      toolTitle: tool.title,
      projectId: board?.id ?? null,
      projectName: board?.name ?? null,
      taskId: task?.id ?? null,
      taskTitle: task?.title ?? null,
      summary: summaryOf(tool, args, value),
      createdAt: now
    })

    await pruneOldRows(now)
    await publishToUser(context.userId, { type: 'notification' }).catch(() => {})
  } catch (error) {
    console.error(`[agent-audit] could not record ${tool.name}`, error)
  }
}
