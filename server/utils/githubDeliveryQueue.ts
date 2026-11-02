// The hand-off from the webhook to the card syncer. The webhook awaits enqueue, and answers 202 only
// once it resolved. Until the broker exists (GH6), the inline queue applies the job in this process
// after the answer and logs a failure with the delivery id; nothing retries it yet. GH6 replaces
// `useDeliveryQueue`'s default with the RabbitMQ publisher, and the webhook does not change.
import type { DeliveryJob } from './githubCards'
import { DeliveryError, processGithubDelivery } from './githubCards'
import { databaseCardStore } from './githubCardStore'

export interface DeliveryQueue {
  /**
   * Takes one delivery. Resolves once the job is kept: the webhook then answers 202. Rejects when it
   * cannot keep the job: the webhook then answers 503, so GitHub shows the delivery as failed and a
   * redelivery from its settings works.
   */
  enqueue(job: DeliveryJob): Promise<void>
}

/** Applies each job in this process, after the answer. A failure is logged with the delivery id; nothing retries it yet. */
export const inlineDeliveryQueue: DeliveryQueue = {
  async enqueue(job) {
    void applyJob(job)
  }
}

async function applyJob(job: DeliveryJob): Promise<void> {
  const id = job.deliveryId || '(no id)'
  try {
    await processGithubDelivery(job, { store: databaseCardStore })
  } catch (error) {
    if (error instanceof DeliveryError) {
      console.error(`GitHub delivery ${id} (${job.event}) was not applied: ${error.kind}, ${error.reason}`)
    } else {
      const kind = error instanceof Error ? error.name : 'non-Error'
      console.error(`GitHub delivery ${id} (${job.event}) was not applied: ${kind}`)
    }
  }
}

let current: DeliveryQueue = inlineDeliveryQueue

/** The queue the webhook hands jobs to. */
export function deliveryQueue(): DeliveryQueue {
  return current
}

/** Replaces the queue (the broker, or a test double). `null` puts the inline queue back. */
export function useDeliveryQueue(queue: DeliveryQueue | null): void {
  current = queue ?? inlineDeliveryQueue
}

const WINDOW_MS = 60_000
export const DEFAULT_PER_MINUTE = 120

/** GITHUB_DELIVERY_PER_MINUTE: the deliveries a repository may send in a minute. Read at each delivery. */
// Whole numbers from 1 to this are used; anything else (0, a negative, NaN, a huge value) is the default.
const MAX_PER_MINUTE = 100_000
let warnedBadPerMinute = false
/** Tests only: lets the next bad value log again. */
export function forgetPerMinuteWarning(): void {
  warnedBadPerMinute = false
}

/**
 * GITHUB_DELIVERY_PER_MINUTE: the deliveries a repository may send in a minute. Read at each delivery.
 * Unset, 0, negative, not a number, or above 100000 means the default, 120, and one log line says so.
 */
export function perMinuteFromEnv(): number {
  const raw = (process.env.GITHUB_DELIVERY_PER_MINUTE ?? '').trim()
  if (!raw) return DEFAULT_PER_MINUTE
  const value = Number(raw)
  if (Number.isInteger(value) && value >= 1 && value <= MAX_PER_MINUTE) return value
  if (!warnedBadPerMinute) {
    warnedBadPerMinute = true
    console.warn(`GITHUB_DELIVERY_PER_MINUTE is not a number from 1 to ${MAX_PER_MINUTE}: using ${DEFAULT_PER_MINUTE}`)
  }
  return DEFAULT_PER_MINUTE
}

/**
 * At the webhook edge: how many deliveries a repository may send in a minute. Over that, the webhook
 * answers 429 with Retry-After, so GitHub shows the delivery as failed and a redelivery is possible.
 * One log line a minute per repository names the first refused delivery.
 */
export class RepoAcceptLimit {
  private readonly accepted = new Map<string, number[]>()
  private readonly lastWarning = new Map<string, number>()
  private readonly fixedPerMinute: number | undefined
  private readonly now: () => number
  private readonly warn: (message: string) => void

  constructor(options: { perMinute?: number, now?: () => number, warn?: (message: string) => void } = {}) {
    this.fixedPerMinute = options.perMinute
    this.now = options.now ?? Date.now
    this.warn = options.warn ?? (message => console.warn(message))
  }

  /** Whether one more delivery for this repository may be taken now. */
  allow(repository: string, deliveryId: string): boolean {
    const now = this.now()
    const cap = this.fixedPerMinute ?? perMinuteFromEnv()
    const times = (this.accepted.get(repository) ?? []).filter(at => now - at < WINDOW_MS)
    if (times.length < cap) {
      times.push(now)
      this.accepted.set(repository, times)
      return true
    }
    this.accepted.set(repository, times)
    if (now - (this.lastWarning.get(repository) ?? Number.NEGATIVE_INFINITY) >= WINDOW_MS) {
      this.lastWarning.set(repository, now)
      this.warn(`GitHub delivery ${deliveryId || '(no id)'} for ${repository} was answered 429: more than ${cap} deliveries in a minute`)
    }
    return false
  }
}

export const repoAcceptLimit = new RepoAcceptLimit()
