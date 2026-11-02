// Agent tool for the thread under a task: write an update on it, as a person does
// in the app. The thread is also where an agent answers a question or reports
// back, so it is signed with the key the agent came in on.
import { db } from '../db'
import { taskComments, VISIBILITIES } from '../db/schema'
import type { Visibility } from '../db/schema'
import { resolveReplyTarget } from './taskComments'
import { and, eq } from 'drizzle-orm'
import { audienceOf } from './mcpAccess'
import type { Audience } from './auth-helpers'
import { findTask } from './mcpBoardTools'
import { McpToolError, asToolErrorAsync, newId, optionalString, requireString } from './mcpToolKit'
import type { McpToolDefinition } from './mcpToolKit'
import { notificationExcerpt } from './notifications'
import { notifyComment } from './notifyEvents'
import { fireRules, newRuleChain } from './ruleEngine'

// The update an agent's key may change. The app's rule (api/tasks/[id]/comments/[commentId].ts) is the
// author's; an agent posts under its key owner's account, so an agent may change only what an agent
// posted under that account. Anything the owner typed in the app stays theirs to change there.
// A customer contact sees and changes only customer-visible updates, and only their own.
export function requireAuthorOf(comment: { userId: string, visibility: Visibility, createdVia: string }, context: { userId: string }, audience: Audience) {
  if (audience === 'customer' && comment.visibility !== 'customer') {
    throw new McpToolError('No update with that id on this task.')
  }
  if (comment.userId !== context.userId) {
    throw new McpToolError('Only the author can change this update. It was written by someone else.')
  }
  if (comment.createdVia !== 'mcp') {
    throw new McpToolError('An agent can change only an update an agent posted. This one was written in the app.')
  }
}

/** One answer for an update that is not there any more: a missing id, a hidden one, a deleted one, or one that vanished while the call ran. */
export function missingUpdate(updateId: string) {
  return new McpToolError(`No update with id "${updateId}" on this task.`)
}

// TODO: use the shared customer-visible predicate from the threadOptions slice (#39) once it is on master. Kept local until then.
/** The update, as the key's person may see it. One they cannot see is reported as missing, as the app does. */
async function visibleUpdate(taskId: string, updateId: string, audience: Audience) {
  const [comment] = await db
    .select()
    .from(taskComments)
    .where(and(
      eq(taskComments.id, updateId),
      eq(taskComments.taskId, taskId),
      audience === 'customer' ? eq(taskComments.visibility, 'customer') : undefined
    ))
  if (!comment) throw missingUpdate(updateId)
  return comment
}

/** What an edit writes: the new text and the time. Visibility and the reply target are not touched. */
export function editFields(body: string, now: number) {
  return { body, editedAt: now }
}

export const MCP_UPDATE_TOOLS: McpToolDefinition[] = [
  {
    name: 'edit_task_update',
    title: 'Edit an update on a task',
    description: 'Change the text of an update on a task that an agent posted for you, the key owner. Updates typed in the app stay in the app. A customer contact may change only their own customer-visible updates. The update is marked edited, with the time. Its old text is not kept, and its visibility and reply stay as they are. Nobody is told again. Read the thread with get_task to find the update id.',
    scope: 'boards:write',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The task id.' },
        updateId: { type: 'string', description: 'The id of the update to change, as get_task shows it.' },
        body: { type: 'string', description: 'The new text of the update, as inline Markdown. It replaces the old text.' }
      },
      required: ['id', 'updateId', 'body']
    },
    async handler(args, context) {
      const { task, board } = await findTask(requireString(args, 'id'), context)
      const updateId = requireString(args, 'updateId')
      const body = requireString(args, 'body').trim()
      if (!body) throw new McpToolError('The update is empty. To remove it, use delete_task_update.')

      const audience = audienceOf(context, board)
      const comment = await visibleUpdate(task.id, updateId, audience)
      requireAuthorOf(comment, context, audience)
      if (comment.body === body) throw new McpToolError('The update already says that, so nothing changed.')

      const [updated] = await db
        .update(taskComments)
        .set(editFields(body, Date.now()))
        .where(eq(taskComments.id, comment.id))
        .returning()

      if (!updated) throw missingUpdate(updateId)

      // No notification and no rule run: an edit is not a new update, and the people on the card heard the first one.
      return {
        edited: true,
        board: { id: board.id, name: board.name },
        task: { id: task.id, title: task.title },
        update: {
          id: updated!.id,
          visibility: updated!.visibility,
          length: body.length,
          editedAt: updated!.editedAt,
          replyTo: updated!.replyToId ?? null,
          excerpt: notificationExcerpt(body)
        }
      }
    }
  },
  {
    name: 'delete_task_update',
    title: 'Delete an update on a task',
    description: 'Delete an update on a task that an agent posted for you, the key owner. Updates typed in the app stay in the app. A customer contact may delete only their own customer-visible updates. The update is removed for good, not moved to a trash. Replies to it stay and show that the update they answered was deleted. Nobody is told. The key owner\'s Inbox records the deletion without the text.',
    scope: 'boards:write',
    readOnly: false,
    destructive: true,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The task id.' },
        updateId: { type: 'string', description: 'The id of the update to delete, as get_task shows it.' }
      },
      required: ['id', 'updateId']
    },
    async handler(args, context) {
      const { task, board } = await findTask(requireString(args, 'id'), context)
      const audience = audienceOf(context, board)
      const comment = await visibleUpdate(task.id, requireString(args, 'updateId'), audience)
      requireAuthorOf(comment, context, audience)

      // Only this row goes. taskComments.replyToId has no foreign key, so a reply keeps its target id and reads as deleted.
      const removed = await db.delete(taskComments).where(eq(taskComments.id, comment.id)).returning({ id: taskComments.id })
      // A row gone since the check above gets the same answer as a missing one.
      if (!removed.length) throw missingUpdate(comment.id)

      return {
        deleted: true,
        board: { id: board.id, name: board.name },
        task: { id: task.id, title: task.title },
        update: { id: comment.id, visibility: comment.visibility, length: comment.body.length }
      }
    }
  },
  {
    name: 'post_task_update',
    title: 'Write an update on a task',
    description: 'Add an update to a task\'s thread: report progress, ask a question, answer one. The people on the task are told in their Inbox. Staff updates are internal unless you say "customer"; a customer contact\'s are always visible to the customer. Read the thread first with get_task. To answer a comment, pass its id as replyTo; it must be a comment on this task that you can see.',
    scope: 'boards:write',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The task id.' },
        body: { type: 'string', description: 'The update, as inline Markdown.' },
        visibility: { type: 'string', description: '"internal" (default for staff) or "customer".' },
        replyTo: { type: 'string', description: 'The id of the comment this one answers (optional). It must be a comment on this task that you can see.' }
      },
      required: ['id', 'body']
    },
    async handler(args, context) {
      const { task, board } = await findTask(requireString(args, 'id'), context)
      const body = requireString(args, 'body').trim()
      if (!body) throw new McpToolError('The update is empty.')
      const asked = optionalString(args, 'visibility')
      if (asked !== undefined && !VISIBILITIES.includes(asked as Visibility)) {
        throw new McpToolError('Visibility is "internal" or "customer".')
      }
      const visibility: Visibility = audienceOf(context, board) === 'customer' ? 'customer' : ((asked as Visibility | undefined) ?? 'internal')

      // The reply target is checked as the app checks it (see taskComments.ts): same
      // task, and a customer never learns of an internal comment, not even by error.
      const replyTo = await asToolErrorAsync(() => resolveReplyTarget(task.id, optionalString(args, 'replyTo'), audienceOf(context, board)))

      const [comment] = await db.insert(taskComments).values({
        id: newId(),
        taskId: task.id,
        userId: context.userId,
        body,
        visibility,
        replyToId: replyTo ?? null,
        createdVia: 'mcp',
        apiKeyId: context.keyId,
        createdAt: Date.now()
      }).returning()

      await notifyComment(board, task, context.userId, body, visibility === 'internal')
      // A new update is a comment to the rules, as it is in the app.
      await fireRules({ type: 'comment_added', projectId: board.id, taskId: task.id, actorId: context.userId, actorIsAgent: true, detail: null }, newRuleChain()).catch(() => {})
      return {
        posted: true,
        // At the top level so the open browsers are told which board changed.
        board: { id: board.id, name: board.name },
        update: { id: comment!.id, visibility, excerpt: notificationExcerpt(body), replyTo: replyTo ?? null }
      }
    }
  }
]
