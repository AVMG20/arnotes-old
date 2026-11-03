// The blocked-by parts of the MCP board tools that need no database (GH #36, slice 3): how a
// blocked mark reads for each audience, the cap on a call's id lists, and what a refused link says.
// Kept apart from mcpBoardTools.ts so tests/mcp-task-blockers.test.ts can run them on their own.
import type { Audience } from './auth-helpers'
import { McpToolError } from './mcpToolKit'

/** The most task ids one call may add or remove as blockers. */
export const MAX_LINK_IDS = 50

/** A task's blocked mark as the tools show it. `blockedBy` lists the open blockers, for the team only. */
export interface BlockedMark {
  blocked: boolean
  blockedBy?: string[]
}

/** The derived state from the service: blocked, and the blockers still open. */
export interface BlockedState {
  blocked: boolean
  openBlockerIds: string[]
}

/**
 * A customer sees that a task waits, not what it waits for: an open blocker can be a task the
 * customer may not see, so its id is left out for them.
 */
export function blockedMark(state: BlockedState, audience: Audience): BlockedMark {
  return state.blocked && audience === 'staff'
    ? { blocked: true, blockedBy: state.openBlockerIds }
    : { blocked: state.blocked }
}

/** Refuses a call that names more than MAX_LINK_IDS tasks under `key`. */
export function checkLinkCount(ids: readonly string[], key: string): void {
  if (ids.length > MAX_LINK_IDS) {
    throw new McpToolError(`"${key}" takes at most ${MAX_LINK_IDS} tasks per call. Make the change in batches.`)
  }
}

/** A link the service refused becomes the tool's error, so the write that holds it stops and rolls back. */
export function linkOrFail(result: { ok: true } | { ok: false, message: string }): void {
  if (!result.ok) throw new McpToolError(result.message)
}
