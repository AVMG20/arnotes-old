import type { CommentReplyPreview } from '~/composables/useProjects'

// Pure helpers for the task comment thread: the link that opens one comment,
// and the "In reply to" line above a reply. No DOM, so the drawer can call them
// and so can a script.

// The link to a comment: opens the task and jumps to that comment.
export function commentLink(projectId: string, taskId: string, commentId: string): string {
  return `/projects/${encodeURIComponent(projectId)}?task=${encodeURIComponent(taskId)}&comment=${encodeURIComponent(commentId)}`
}

// The line above a reply, or null when the comment answers nothing. The server
// already drops the preview for a viewer who may not see the parent.
export function replyLineText(replyTo: CommentReplyPreview | null | undefined): string | null {
  if (!replyTo) return null
  if (replyTo.deleted) return 'In reply to a deleted update'
  const who = replyTo.authorName || 'someone'
  return replyTo.excerpt ? `In reply to ${who}: ${replyTo.excerpt}` : `In reply to ${who}`
}
