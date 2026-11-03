import { processGithubDelivery } from '../utils/githubCards'
import { processTagDelivery, databaseTagStore } from '../utils/githubTags'
import { databaseCardStore, databaseDeliveryLedger } from '../utils/githubCardStore'
import { databaseFailureRows, purgeDeliveryPayloads } from '../utils/githubDeliveryFailures'
import { ADAPTER_TIMEOUT_MS, BUDGET_MS, createDeliveryConsumer, SHUTDOWN_WAIT_MS } from '../utils/githubDeliveryConsumer'
import { beginShutdown, closeDeliveryQueue, getDeliveryQueue } from '../utils/githubDeliveryQueue'
import { errorSummary } from '../utils/githubDeliveryQueueTypes'

// Applies the queued GitHub deliveries. It starts once the queue is reachable and keeps trying with backoff while
// it is not (the webhook answers 503 meanwhile). On shutdown it stops taking work, lets the work in hand finish
// for a while, and closes the queue. The janitor removes the stored payloads of old failed deliveries, hourly.
const RETRY_MIN_MS = 5_000
const RETRY_MAX_MS = 60_000
const JANITOR_INTERVAL_MS = 60 * 60 * 1000

/**
 * The budget of one delivery's run, and the queue's timeout for the handler. The budget must be the shorter one, so
 * the consumer always answers before the queue gives up. Both may be set in the environment (milliseconds).
 */
function timeoutsFromEnv(): { budgetMs: number, adapterMs: number } {
  const read = (name: string, fallback: number): number => {
    const raw = (process.env[name] ?? '').trim()
    const value = Number(raw)
    return raw && Number.isInteger(value) && value >= 1_000 && value <= 3_600_000 ? value : fallback
  }
  const budgetMs = read('GITHUB_DELIVERY_BUDGET_MS', BUDGET_MS)
  const adapterMs = read('GITHUB_DELIVERY_ADAPTER_TIMEOUT_MS', ADAPTER_TIMEOUT_MS)
  if (budgetMs < adapterMs) return { budgetMs, adapterMs }
  console.warn('[github] GITHUB_DELIVERY_BUDGET_MS must be shorter than GITHUB_DELIVERY_ADAPTER_TIMEOUT_MS: using the defaults')
  return { budgetMs: BUDGET_MS, adapterMs: ADAPTER_TIMEOUT_MS }
}

// A dev reload of this plugin runs it again while the last one is still consuming on the shared queue. The last
// instance's release is kept on globalThis (a module-level variable would be new on every reload), so the new
// instance releases it before it starts.
type Release = (closing: boolean) => Promise<void>
const reloads = globalThis as typeof globalThis & { __githubDeliveryRelease?: Release }

export default defineNitroPlugin((nitroApp) => {
  void reloads.__githubDeliveryRelease?.(false)

  const timeouts = timeoutsFromEnv()
  const consumer = createDeliveryConsumer(
    { publish: (queue, message) => getDeliveryQueue().publish(queue, message) },
    {
      ledger: databaseDeliveryLedger,
      failures: databaseFailureRows,
      apply: (job, signal) => processGithubDelivery(job, {
        store: databaseCardStore,
        signal,
        tagWork: (tagJob, tagSignal) => processTagDelivery(tagJob, { store: databaseTagStore, signal: tagSignal })
      }),
      log: line => console.warn(line),
      budgetMs: timeouts.budgetMs
    }
  )

  let stopConsuming: (() => Promise<void>) | null = null
  let stopping = false
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let retryDelay = RETRY_MIN_MS
  // One log line per state change, not per attempt.
  let state = ''
  const note = (next: string) => {
    if (next === state) return
    state = next
    console.info(`[github] delivery consumer ${next}`)
  }

  const start = async () => {
    if (stopping) return
    try {
      stopConsuming = await getDeliveryQueue().consume(consumer.handle, {
        prefetch: 1,
        handlerTimeoutMs: timeouts.adapterMs,
        beforeFail: consumer.beforeFail
      })
      retryDelay = RETRY_MIN_MS
      note('consuming')
    } catch (error) {
      note(`waiting for the queue (${errorSummary(error)})`)
      retryTimer = setTimeout(() => void start(), retryDelay)
      retryTimer.unref?.()
      retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS)
    }
  }
  void start()

  const sweepPayloads = async () => {
    try {
      const removed = await purgeDeliveryPayloads()
      if (removed) console.info(`[github] cleared the stored payload of ${removed} failed delivery(ies) past their retention`)
    } catch (error) {
      console.error(`[github] payload janitor failed (${errorSummary(error)})`)
    }
  }
  void sweepPayloads()
  const janitor = setInterval(() => void sweepPayloads(), JANITOR_INTERVAL_MS)
  janitor.unref?.()

  // closing: the server is going down (refuse new connections); false for a dev reload, which starts again.
  const release: Release = async (closing) => {
    stopping = true
    clearTimeout(retryTimer)
    clearInterval(janitor)
    if (closing) beginShutdown()
    const finished = await consumer.idle(SHUTDOWN_WAIT_MS)
    if (!finished) console.warn('[github] shutdown: a delivery in hand did not finish in time; it is requeued')
    await stopConsuming?.()
    stopConsuming = null
    await closeDeliveryQueue()
  }
  reloads.__githubDeliveryRelease = release
  nitroApp.hooks.hook('close', () => release(true))
})
