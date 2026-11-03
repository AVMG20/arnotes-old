// Who a task update reads as. An update the GitHub card syncer wrote is signed with the
// project owner's account in the database, so the name has to come from how it was posted,
// never from the account: a reader must not take the owner for the writer.

export interface CommentAuthorInput {
  createdVia?: string | null
  userName?: string | null
  keyName?: string | null
}

/** True for an update the GitHub sync wrote (a comment copy, a close or a reopen). */
export function isGithubUpdate(comment: Pick<CommentAuthorInput, 'createdVia'>): boolean {
  return comment.createdVia === 'github'
}

/** The name an update is shown under: the agent's key, AI, GitHub, or the person who posted it. */
export function commentAuthorName(comment: CommentAuthorInput): string {
  if (comment.createdVia === 'mcp') return comment.keyName ?? 'MCP key'
  if (comment.createdVia === 'ai') return 'AI assistant'
  if (isGithubUpdate(comment)) return 'GitHub'
  return comment.userName ?? 'Unknown'
}
