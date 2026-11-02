// The in-memory delivery queue: the same interface as the RabbitMQ adapter, for development and tests.
// Nothing here survives a restart, so the factory in githubDeliveryQueue.ts never gives it out outside
// NODE_ENV development and test. It also serves as the fake broker of the contract tests: a crash can be
// simulated between a publish and its confirm, or between a delivery and its ack, and the retry queues run
// on a clock the test moves itself.
//
// Differences from RabbitMQ, on purpose: a dropped connection ends the consumers, and the next consume starts
// them again (the client resubscribes by itself; the fake makes the caller do it, so the test shows it).
import { DELIVERY_LIMIT, DELIVERY_QUEUES, DeliveryQueueUnavailable, DeliveryTooLarge, MAX_BODY_BYTES, DEFAULT_HANDLER_TIMEOUT_MS, RETRY_TTL_MS, cutReason, decide, errorSummary } from './githubDeliveryQueueTypes'
import type { BeforeFail, ConsumeHandler, ConsumeOptions, Disposition, DeliveryQueue, DeliveryQueueName, HandedMessage, QueueMessage, QueueStatus } from './githubDeliveryQueueTypes'

const SWEEP_MS = 250

export type CrashPoint = 'publish' | 'ack'

export interface MemoryDeliveryQueue extends DeliveryQueue {
  /** Tests: moves the clock forward and dead-letters the retry messages that are due. Needs manualClock. */
  advance(ms: number): void
  /**
   * Tests: the next publish, or the next settle of a delivery, takes effect, then the connection drops
   * before the confirm (or the ack) reaches the broker. Every unacked delivery goes back to its queue, marked
   * redelivered, and the consumers stop. Arms once.
   */
  crashAfter(point: CrashPoint): void
  /** Tests: the next copy of a delivery to failed is not confirmed: the delivery is requeued, as a closed channel would. */
  failNextFailedCopy(): void
  /** Tests: drops the connection now, as a restart of the broker would. */
  dropConnection(): void
  /** Tests: deliveries handed out and not yet settled. */
  unackedCount(): number
  /** Tests: the body limit, as the webhook's cap would be set. */
  setMaxBodyBytes(bytes: number): void
  /** Tests: a copy of what one queue holds, oldest first. */
  peek(queue: DeliveryQueueName): Array<{ deliveryId: string, event: string, attempt: number, redelivered: boolean, reason?: string, deliveries: number, body: string }>
}

interface StoredMessage extends QueueMessage {
  redelivered: boolean
  /** Retry queues only: when the message is dead-lettered back to main. */
  expiresAt: number | null
  /** How many times the broker has handed this message out (the delivery limit counts these). */
  deliveries: number
  reason?: string
}

interface Consumer {
  onMessage: ConsumeHandler
  timeoutMs: number
  beforeFail: BeforeFail
  active: boolean
  inFlight: number
}

export function createMemoryDeliveryQueue(options: { manualClock?: boolean, log?: (line: string) => void } = {}): MemoryDeliveryQueue {
  const manualClock = options.manualClock === true
  const log = options.log ?? (() => {})
  let clock = 0
  const now = (): number => (manualClock ? clock : Date.now())
  let maxBodyBytes = MAX_BODY_BYTES

  const queues: Record<DeliveryQueueName, StoredMessage[]> = { main: [], retry30s: [], retry2m: [], failed: [] }
  const consumers = new Set<Consumer>()
  /** Handed out and not yet settled, with the consumer that holds them. */
  const unacked = new Map<StoredMessage, Consumer>()
  let crashPoint: CrashPoint | null = null
  let failCopyOnce = false
  let closed = false
  let pumping = false
  let repump = false

  const sweeper = manualClock ? undefined : setInterval(sweep, SWEEP_MS)
  sweeper?.unref?.()

  function ensureOpen(): void {
    if (closed) throw new DeliveryQueueUnavailable('the queue is closed')
  }

  /** Dead-letters the retry messages whose time has come, into main, in their order. */
  function sweep(): void {
    const time = now()
    let moved = false
    for (const name of ['retry30s', 'retry2m'] as const) {
      const queue = queues[name]
      for (let i = 0; i < queue.length;) {
        const message = queue[i]!
        if (message.expiresAt !== null && message.expiresAt <= time) {
          queue.splice(i, 1)
          message.expiresAt = null
          message.redelivered = false
          queues.main.push(message)
          moved = true
        } else {
          i++
        }
      }
    }
    if (moved) pump()
  }

  /** Hands ready main messages to consumers that have room. Deliveries go out on a microtask, never inside a call. */
  function pump(): void {
    if (pumping) {
      repump = true
      return
    }
    pumping = true
    do {
      repump = false
      for (const consumer of consumers) {
        while (consumer.active && consumer.inFlight < 1 && queues.main.length > 0) {
          const message = queues.main.shift()!
          message.deliveries += 1
          if (message.deliveries > DELIVERY_LIMIT) {
            // The broker's delivery limit: the message goes to failed, not back to a consumer.
            message.reason = 'delivery limit'
            queues.failed.push(message)
            continue
          }
          consumer.inFlight++
          unacked.set(message, consumer)
          const handed: HandedMessage = {
            deliveryId: message.deliveryId,
            event: message.event,
            attempt: message.attempt,
            body: message.body,
            redelivered: message.redelivered,
            deliveries: message.deliveries
          }
          void decide(consumer.onMessage, handed, { timeoutMs: consumer.timeoutMs, maxBodyBytes, beforeFail: consumer.beforeFail }, log)
            .then(disposition => settle(message, consumer, disposition))
            .catch((error: unknown) => {
              log(`GitHub delivery ${cutReason(message.deliveryId) || '(no id)'} was not settled (${errorSummary(error)}); the broker redelivers it`)
            })
        }
      }
    } while (repump)
    pumping = false
  }

  /**
   * Performs a disposition. Throws DeliveryQueueUnavailable when the delivery is no longer held by this
   * consumer (its connection dropped), as a closed channel refuses an ack.
   */
  function settle(message: StoredMessage, consumer: Consumer, disposition: Disposition): void {
    if (unacked.get(message) !== consumer) {
      throw new DeliveryQueueUnavailable('the delivery is no longer held: the connection dropped before its ack')
    }
    if (failCopyOnce && disposition !== 'ack' && 'fail' in disposition) {
      // The failed copy is not confirmed: the delivery is requeued, unacked, as a closed channel would return it.
      failCopyOnce = false
      unacked.delete(message)
      message.redelivered = true
      queues.main.unshift(message)
      consumer.inFlight--
      pump()
      throw new DeliveryQueueUnavailable('the failed copy was not confirmed; the delivery is requeued')
    }
    if (disposition !== 'ack') {
      const copy: StoredMessage = {
        deliveryId: message.deliveryId,
        event: message.event,
        attempt: 'fail' in disposition ? message.attempt : message.attempt + 1,
        body: Buffer.from(message.body),
        redelivered: false,
        expiresAt: null,
        deliveries: 0,
        reason: cutReason('fail' in disposition ? disposition.fail : disposition.reason)
      }
      if ('retry' in disposition) {
        copy.expiresAt = now() + RETRY_TTL_MS[disposition.retry]
        queues[disposition.retry].push(copy)
      } else {
        queues.failed.push(copy)
      }
    }
    if (crashPoint === 'ack') {
      crashPoint = null
      dropConnection()
      throw new DeliveryQueueUnavailable('the connection dropped before the ack reached the broker')
    }
    unacked.delete(message)
    consumer.inFlight--
    pump()
  }

  function dropConnection(): void {
    for (const consumer of consumers) consumer.active = false
    consumers.clear()
    const back = [...unacked.keys()]
    unacked.clear()
    for (const message of back.reverse()) {
      message.redelivered = true
      queues.main.unshift(message)
    }
  }

  return {
    kind: 'memory',

    async publish(queue, message) {
      ensureOpen()
      if (!(DELIVERY_QUEUES as readonly string[]).includes(queue)) throw new TypeError(`unknown queue ${String(queue)}`)
      if (message.body.length > maxBodyBytes) throw new DeliveryTooLarge(message.body.length)
      const ttl = queue === 'retry30s' || queue === 'retry2m' ? RETRY_TTL_MS[queue] : undefined
      queues[queue].push({
        deliveryId: message.deliveryId,
        event: message.event,
        attempt: message.attempt,
        body: Buffer.from(message.body),
        redelivered: false,
        expiresAt: ttl === undefined ? null : now() + ttl,
        deliveries: 0
      })
      if (queue === 'main') pump()
      if (crashPoint === 'publish') {
        crashPoint = null
        dropConnection()
        throw new DeliveryQueueUnavailable('the connection dropped before the publish was confirmed')
      }
    },

    async consume(onMessage, options: ConsumeOptions) {
      ensureOpen()
      if (options.prefetch !== 1) throw new RangeError('prefetch must be 1')
      if (typeof options.beforeFail !== 'function') throw new TypeError('beforeFail is required')
      const consumer: Consumer = {
        onMessage,
        timeoutMs: options.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS,
        beforeFail: options.beforeFail,
        active: true,
        inFlight: 0
      }
      consumers.add(consumer)
      pump()
      return async () => {
        if (!consumer.active) return
        consumer.active = false
        consumers.delete(consumer)
        // Deliveries still in hand go back for redelivery, as a closed channel would return them.
        for (const [message, holder] of [...unacked]) {
          if (holder !== consumer) continue
          unacked.delete(message)
          message.redelivered = true
          queues.main.unshift(message)
        }
        consumer.inFlight = 0
        pump()
      }
    },

    async depth() {
      ensureOpen()
      return queues.main.length
    },

    async failedDepth() {
      ensureOpen()
      return queues.failed.length
    },

    status(): QueueStatus {
      return { state: closed ? 'closed' : 'connected', broker: 'memory (development and tests only)' }
    },

    async close() {
      closed = true
      if (sweeper) clearInterval(sweeper)
      consumers.clear()
      unacked.clear()
    },

    advance(ms) {
      if (!manualClock) throw new Error('advance needs manualClock')
      clock += ms
      sweep()
    },

    crashAfter(point) {
      crashPoint = point
    },

    dropConnection,

    failNextFailedCopy() {
      failCopyOnce = true
    },

    unackedCount() {
      return unacked.size
    },

    setMaxBodyBytes(bytes) {
      maxBodyBytes = bytes
    },

    peek(queue) {
      return queues[queue].map(message => ({
        deliveryId: message.deliveryId,
        event: message.event,
        attempt: message.attempt,
        redelivered: message.redelivered,
        reason: message.reason,
        deliveries: message.deliveries,
        body: message.body.toString('utf8')
      }))
    }
  }
}
