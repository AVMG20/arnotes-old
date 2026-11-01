// Runs the audit flush on shutdown with a deadline, so a database that is down cannot hold the
// process: the wait is at most SHUTDOWN_FLUSH_MS, then the queued rows are given up and one line
// says so. The timer is cleared as soon as the flush settles, so it never keeps the process alive.
export const SHUTDOWN_FLUSH_MS = 2_000

export type FlushOutcome = 'done' | 'timeout' | 'failed'

export interface DeadlineTimers {
  set: (run: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

const realTimers: DeadlineTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

export async function flushWithDeadline(
  flush: () => Promise<void>,
  ms: number,
  log: (line: string) => void,
  timers: DeadlineTimers = realTimers
): Promise<FlushOutcome> {
  let handle: unknown
  const deadline = new Promise<'timeout'>((resolve) => {
    handle = timers.set(() => resolve('timeout'), ms)
  })
  try {
    const outcome = await Promise.race([
      flush().then((): FlushOutcome => 'done', (): FlushOutcome => 'failed'),
      deadline
    ])
    if (outcome === 'timeout') log(`[crew-api] audit flush on shutdown timed out after ${ms} ms; the queued rows were not written`)
    if (outcome === 'failed') log('[crew-api] audit flush on shutdown failed; the queued rows were not written')
    return outcome
  } finally {
    timers.clear(handle)
  }
}
