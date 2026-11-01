// Runs a housekeeping task at most once per interval, never waiting for it. The caller does not
// await the task: its failures are counted, not thrown, and a task that is still running is not
// started again. The crew gate uses it for the audit prune.
export interface ThrottledTask {
  /** Starts the task if the interval has passed and it is not already running. Returns at once. */
  trigger: (now: number) => void
  /** How many runs have failed since the process started. */
  readonly failures: number
  /** How many runs have been started since the process started. */
  readonly runs: number
}

export function throttledTask(everyMs: number, task: (now: number) => Promise<void>): ThrottledTask {
  let last = Number.NEGATIVE_INFINITY
  let running = false
  let failures = 0
  let runs = 0
  return {
    trigger(now: number) {
      if (running || now - last < everyMs) return
      last = now
      running = true
      runs++
      void task(now)
        .catch(() => {
          failures++
        })
        .finally(() => {
          running = false
        })
    },
    get failures() {
      return failures
    },
    get runs() {
      return runs
    }
  }
}
