// "Blocked by" links between tasks (GH #36). Pure, with no imports and no database, so it can be
// tested on its own. The link table stores only the links; whether a task is blocked is derived
// from them, so it cannot go stale. The caller says which tasks are finished.
//
// Trash rule: a blocker in the trash does NOT block. The caller's isFinished returns true for a
// trashed or deleted blocker. Because blocked-ness is derived, a restored blocker blocks again by itself.

export interface TaskLink {
  /** The task that waits. */
  blockedId: string
  /** The task it waits for. */
  blockerId: string
}

export type LinkRefusal
  = | { reason: 'self' }
    | { reason: 'duplicate' }
    | { reason: 'cycle', cycle: string[] }

/**
 * Whether a new link (blockedId waits for blockerId) may be added to the existing links.
 * A cycle is returned as an ordered list that starts and ends with blockedId, for example
 * [B, A, B] for "A is blocked by B" plus a new "B is blocked by A".
 */
export function checkNewLink(links: readonly TaskLink[], blockedId: string, blockerId: string): LinkRefusal | null {
  if (blockedId === blockerId) return { reason: 'self' }
  if (links.some(l => l.blockedId === blockedId && l.blockerId === blockerId)) return { reason: 'duplicate' }
  const path = pathOfBlockers(blockersByTask(links), blockerId, blockedId)
  if (path) return { reason: 'cycle', cycle: [blockedId, ...path] }
  return null
}

/** Names a cycle for a person: "B -> A -> B", using the label the caller gives each task. */
export function describeCycle(cycle: readonly string[], labelOf: (taskId: string) => string): string {
  return cycle.map(labelOf).join(' -> ')
}

/**
 * The tasks a task waits for, directly, that are not finished yet. A task is blocked while
 * this list is not empty.
 */
export function openBlockers(taskId: string, links: readonly TaskLink[], isFinished: (taskId: string) => boolean): string[] {
  return links
    .filter(l => l.blockedId === taskId)
    .map(l => l.blockerId)
    .filter(id => !isFinished(id))
}

export function isBlocked(taskId: string, links: readonly TaskLink[], isFinished: (taskId: string) => boolean): boolean {
  return openBlockers(taskId, links, isFinished).length > 0
}

// Each task's blockers, built once per check so a walk never rescans every link.
function blockersByTask(links: readonly TaskLink[]): Map<string, string[]> {
  const byTask = new Map<string, string[]>()
  for (const link of links) {
    const list = byTask.get(link.blockedId)
    if (list) list.push(link.blockerId)
    else byTask.set(link.blockedId, [link.blockerId])
  }
  return byTask
}

// Breadth-first search along "is blocked by" edges from `from` to `target`. Returns the path
// (starting with `from`, ending with `target`), or null when `target` is not reached.
function pathOfBlockers(byTask: Map<string, string[]>, from: string, target: string): string[] | null {
  const via = new Map<string, string>()
  const queue = [from]
  const seen = new Set<string>([from])
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i]!
    if (current === target) {
      const path = [current]
      let step = current
      while (via.has(step)) {
        step = via.get(step)!
        path.unshift(step)
      }
      return path
    }
    for (const next of byTask.get(current) ?? []) {
      if (seen.has(next)) continue
      seen.add(next)
      via.set(next, current)
      queue.push(next)
    }
  }
  return null
}
