// Which column moves reach agents, who hears them, and how many at once (GH #38 slice B).
// Pure, no imports, so it tests on its own: notifyEvents.ts reads the database and sends.

// The columns an agent always hears about when a card reaches them.
export const AGENT_MOVE_COLUMNS = new Set(['verify', 'ready for live', 'done', 'bugs'])

/** How long one run of moves on a board counts as one: the first notifies, the rest are counted. */
export const MOVE_WINDOW_MS = 30_000

/** Whether a column is one of the four an agent always hears about, by its name. */
export function isDefaultMoveColumn(name: string): boolean {
  return AGENT_MOVE_COLUMNS.has(name.toLowerCase())
}

/** Whether a trigger says "a task is moved to" this column. Anything malformed is not a match. */
export function isMoveTriggerFor(trigger: unknown, columnId: string): boolean {
  if (typeof trigger !== 'object' || trigger === null) return false
  const { kind, columnId: chosen } = trigger as { kind?: unknown, columnId?: unknown }
  return kind === 'task_moved' && chosen === columnId
}

/** Whether a card moved into a column should reach its agents: a default column, or one an enabled rule chooses. */
export function agentHearsMove(column: { id: string, name: string }, enabledRuleTriggers: unknown[]): boolean {
  if (isDefaultMoveColumn(column.name)) return true
  return enabledRuleTriggers.some(trigger => isMoveTriggerFor(trigger, column.id))
}

/** Who hears of a move: the assignee, the creator and the crew pm, once each, never the person who moved it. */
export function moveRecipients(task: { assigneeId?: string | null, createdBy?: string | null }, actorId: string | null, pmIds: string[]): string[] {
  const all = [task.assigneeId, task.createdBy, ...pmIds].filter((id): id is string => !!id && id !== actorId)
  return [...new Set(all)]
}

/**
 * Coalesces moves per key (board, recipient, visibility). The first move in a window is sent at once; the moves
 * after it in the same window are only counted. When the window closes, one summary goes out, and only if the
 * count is above zero. Window state is held only while a window is open, and expired windows are swept on every
 * offer, so the state stays as large as the number of keys moved in the last window.
 */
export function createMoveCoalescer<T>(options: {
  /** Called with the payload and how many moves it stands for beyond itself: 0 for a first move, N for a summary. */
  send: (payload: T, more: number) => void
  windowMs?: number
  now?: () => number
  /** Runs `fn` after `ms`. Defaults to an unref'd timer, so an open window never keeps the process alive. */
  schedule?: (fn: () => void, ms: number) => void
}) {
  const windowMs = options.windowMs ?? MOVE_WINDOW_MS
  const now = options.now ?? Date.now
  const schedule = options.schedule ?? ((fn: () => void, ms: number) => {
    const timer = setTimeout(fn, ms)
    timer.unref?.()
  })
  const open = new Map<string, { start: number, more: number, last: T }>()

  function close(key: string) {
    const entry = open.get(key)
    if (!entry) return
    open.delete(key)
    if (entry.more > 0) options.send(entry.last, entry.more)
  }

  function sweep(at: number) {
    for (const [key, entry] of open) {
      if (at - entry.start >= windowMs) close(key)
    }
  }

  return {
    /** Offers a move. Returns true when it was sent at once, false when it was counted into an open window. */
    offer(key: string, payload: T): boolean {
      const at = now()
      sweep(at)
      const entry = open.get(key)
      if (entry) {
        entry.more++
        entry.last = payload
        return false
      }
      open.set(key, { start: at, more: 0, last: payload })
      schedule(() => {
        // Only this window closes its own entry: a later window for the same key has a later start.
        if (open.get(key)?.start === at) close(key)
      }, windowMs)
      options.send(payload, 0)
      return true
    },
    /** How many windows are open now. */
    openWindows(): number {
      return open.size
    }
  }
}
