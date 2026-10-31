import { db } from '../db'
import { taskComments, user, apiKeys } from '../db/schema'
import { and, eq, inArray } from 'drizzle-orm'
import type { Audience } from './auth-helpers'

// Reply previews for task comments. This file is the only place a preview is
// built, so the app and the MCP tools cannot disagree about what a reply shows.

export interface ReplyPreview {
  id: string
  authorName: string | null
  excerpt: string
  deleted: boolean
}

const EXCERPT_LENGTH = 80

// Comments are stored as Markdown, so the excerpt keeps the words and drops the syntax.
export function plainExcerpt(body: string): string {
  const text = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > EXCERPT_LENGTH ? `${text.slice(0, EXCERPT_LENGTH - 1).trimEnd()}…` : text
}

// Checks the reply target sent with a new comment. A missing, foreign or hidden
// comment gets the same answer, so an internal comment is not revealed to a contact.
export async function resolveReplyTarget(taskId: string, replyTo: unknown, audience: Audience): Promise<string | null> {
  if (replyTo === undefined || replyTo === null || replyTo === '') return null
  const [parent] = typeof replyTo === 'string'
    ? await db
        .select({ visibility: taskComments.visibility })
        .from(taskComments)
        .where(and(eq(taskComments.id, replyTo), eq(taskComments.taskId, taskId)))
    : []
  if (!parent || (audience === 'customer' && parent.visibility !== 'customer')) {
    throw createError({ statusCode: 400, message: 'No such comment on this task.' })
  }
  return replyTo as string
}

// Adds `replyTo` to each comment and drops the raw `replyToId`, which would
// otherwise hand a contact the id of an internal comment.
export async function attachReplyPreviews<T extends { replyToId: string | null }>(
  taskId: string,
  comments: T[],
  audience: Audience
): Promise<Array<Omit<T, 'replyToId'> & { replyTo: ReplyPreview | null }>> {
  const parentIds = [...new Set(comments.map(c => c.replyToId).filter((id): id is string => !!id))]
  // Read without the audience filter: staff previews show internal parents too.
  const parents = parentIds.length === 0
    ? []
    : await db
        .select({
          id: taskComments.id,
          body: taskComments.body,
          visibility: taskComments.visibility,
          userName: user.name,
          keyName: apiKeys.name
        })
        .from(taskComments)
        .leftJoin(user, eq(user.id, taskComments.userId))
        .leftJoin(apiKeys, eq(apiKeys.id, taskComments.apiKeyId))
        .where(and(eq(taskComments.taskId, taskId), inArray(taskComments.id, parentIds)))
  const byId = new Map(parents.map(p => [p.id, p]))

  return comments.map(({ replyToId, ...comment }) => ({
    ...comment,
    replyTo: buildReplyPreview(replyToId, byId, audience)
  }))
}

function buildReplyPreview(
  replyToId: string | null,
  parents: Map<string, { id: string, body: string, visibility: string, userName: string | null, keyName: string | null }>,
  audience: Audience
): ReplyPreview | null {
  if (!replyToId) return null
  const parent = parents.get(replyToId)
  // Gone (or not on this task): the reply still loads, and says so.
  if (!parent) return { id: replyToId, authorName: null, excerpt: '', deleted: true }
  // A contact learns nothing about an internal comment: not its text, author or id.
  if (audience === 'customer' && parent.visibility !== 'customer') return null
  return {
    id: parent.id,
    authorName: parent.keyName ?? parent.userName ?? null,
    excerpt: plainExcerpt(parent.body),
    deleted: false
  }
}
