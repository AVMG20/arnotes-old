// The RabbitMQ delivery queue, on rabbitmq-client (MIT, runs on Node and on Bun). The client reconnects
// by itself with exponential backoff (1 s up to 30 s, with jitter) and resubscribes its consumers. This
// adapter adds the topology (declared again after every reconnect, idempotent), the confirm and the
// disposition rules of the queue interface, one log line per state change, and the state for the health check.
// The URL goes to the client and is never printed: every line uses describeBrokerUrl.
import { Connection, ConsumerStatus } from 'rabbitmq-client'
import type { Publisher } from 'rabbitmq-client'
import {
  DELIVERY_LIMIT, DELIVERY_QUEUES, DeliveryQueueUnavailable, DeliveryTooLarge, MAX_BODY_BYTES, DEFAULT_HANDLER_TIMEOUT_MS,
  RETRY_TTL_MS, cutReason, decide, errorSummary
} from './githubDeliveryQueueTypes'
import type { ConsumeHandler, ConsumeOptions, Disposition, DeliveryQueue, DeliveryQueueName, HandedMessage, QueueMessage, QueueState, QueueStatus } from './githubDeliveryQueueTypes'

export const EXCHANGE = 'github.deliveries'
const ROUTING_KEY = 'delivery'
const QUEUE_NAMES: Record<DeliveryQueueName, string> = {
  main: 'github.deliveries',
  retry30s: 'github.deliveries.retry.30s',
  retry2m: 'github.deliveries.retry.2m',
  failed: 'github.deliveries.failed'
}

/**
 * Quorum queues: replicated and durable. `main` has a delivery limit with failed as its dead-letter target,
 * so a message a dying consumer keeps handing back ends in failed instead of looping. The retry queues
 * dead-letter back to the exchange. `failed` has no TTL and no limit, so nothing expires silently.
 */
export function queueArguments(name: DeliveryQueueName): Record<string, unknown> {
  const args: Record<string, unknown> = { 'x-queue-type': 'quorum' }
  if (name === 'main') {
    args['x-delivery-limit'] = DELIVERY_LIMIT
    args['x-dead-letter-exchange'] = ''
    args['x-dead-letter-routing-key'] = QUEUE_NAMES.failed
  }
  if (name === 'retry30s' || name === 'retry2m') {
    args['x-message-ttl'] = RETRY_TTL_MS[name]
    args['x-dead-letter-exchange'] = EXCHANGE
    args['x-dead-letter-routing-key'] = ROUTING_KEY
  }
  return args
}

/** Where a queue's messages are published: main through the exchange, the others straight to the queue. */
function routeOf(queue: DeliveryQueueName): { exchange: string, routingKey: string } {
  return queue === 'main' ? { exchange: EXCHANGE, routingKey: ROUTING_KEY } : { exchange: '', routingKey: QUEUE_NAMES[queue] }
}

/** The subset of the client's connection this adapter uses. A test passes a fake. */
export type BrokerConnection = Connection

export interface AmqpQueueOptions {
  url: string
  /** describeBrokerUrl(url): the only form of the broker address that may be printed. */
  label: string
  /** One line per state change, per distinct topology failure, and per delivery that could not be settled. */
  log: (line: string) => void
  /** Tests only: builds the connection instead of opening one. */
  connect?: (url: string) => BrokerConnection
  /** How long a publish or consume waits for a connection before it answers unavailable. */
  connectWaitMs?: number
  /** First wait after a failed topology declaration; doubles up to 30 s. Default 1 s. */
  retryBaseMs?: number
  /** Wait before a delivery whose copy could not be published goes back on the queue. Default 1 s. */
  requeueDelayMs?: number
}

export interface AmqpDeliveryQueue extends DeliveryQueue {
  /** Tests only: drops the TCP connection without a close frame, as a crashed process would. */
  crashForTest(): void
}

const DEFAULT_CONNECT_WAIT_MS = 3_000
const DEFAULT_RETRY_BASE_MS = 1_000
const DEFAULT_REQUEUE_DELAY_MS = 1_000
const MAX_RETRY_MS = 30_000

/** A declaration that failed: which queue (or the exchange, or the binding) and the cause. */
class TopologyFailure extends Error {
  readonly step: string
  readonly failure: unknown

  constructor(step: string, failure: unknown) {
    super(step)
    this.step = step
    this.failure = failure
    this.name = 'TopologyFailure'
  }
}

/** The real connection: reconnects with exponential backoff (1 s up to 30 s, with jitter) on its own. */
function openConnection(url: string): Connection {
  return new Connection({ url, connectionName: 'taskmanager', retryLow: 1_000, retryHigh: 30_000 })
}

export function createAmqpDeliveryQueue(options: AmqpQueueOptions): AmqpDeliveryQueue {
  const { url, label, log } = options
  const connectWaitMs = options.connectWaitMs ?? DEFAULT_CONNECT_WAIT_MS
  const retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS
  const requeueDelayMs = options.requeueDelayMs ?? DEFAULT_REQUEUE_DELAY_MS
  let state: QueueState = 'idle'
  let detail: string | undefined
  let closed = false
  /** The client's link: true between a 'connection' event and the next error. */
  let up = false
  let connection: BrokerConnection | null = null
  let publisher: Publisher | null = null
  /** The declaration for the current connection, while it runs or once it succeeded. Null: not declared yet. */
  let topology: Promise<void> | null = null
  let topologyError: string | undefined
  let topologyKey = ''
  let topologyFailures = 0
  let topologyRetryAt = 0
  let waiters: Array<() => void> = []
  // The settle functions of the deliveries in hand, one set per consumer. The client waits for in-hand
  // handlers before it resubscribes, so a connection loss must release them (the broker has them back).
  const hands = new Set<Set<(status: ConsumerStatus) => void>>()

  function setState(next: QueueState, message?: string): void {
    if (next === state) return
    state = next
    detail = next === 'connected' ? undefined : message
    if (message) log(message)
  }

  function onConnected(): void {
    up = true
    // A new connection declares again at once: the backoff belonged to the old one.
    topology = null
    topologyRetryAt = 0
    if (state === 'reconnecting') {
      setState('connected', `RabbitMQ reconnected to ${label}`)
    } else {
      setState('connected', `RabbitMQ connected to ${label}`)
    }
    const ready = waiters
    waiters = []
    for (const wake of ready) wake()
  }

  function onError(error: unknown): void {
    up = false
    // The in-hand deliveries are dead with the connection: release them so the consumer can resubscribe.
    for (const hand of hands) for (const settle of [...hand]) settle(ConsumerStatus.REQUEUE)
    // The client retries on its own and reports every failed attempt; one line marks the change, the rest stay quiet.
    if (state === 'reconnecting' || closed) return
    setState('reconnecting', `RabbitMQ unreachable at ${label} (${errorSummary(error)}); retrying with backoff`)
  }

  /** The connection is opened on first use, so a server that never publishes never dials the broker. */
  function connect(): BrokerConnection {
    if (closed) throw new DeliveryQueueUnavailable('the queue is closed')
    if (connection) return connection
    setState('connecting', `RabbitMQ connecting to ${label}`)
    const opened = options.connect ? options.connect(url) : openConnection(url)
    opened.on('connection', onConnected)
    opened.on('error', onError)
    connection = opened
    return opened
  }

  /** Resolves once connected, or rejects after connectWaitMs, so a webhook answers 503 instead of hanging. */
  function waitConnected(): Promise<void> {
    if (up) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters = waiters.filter(w => w !== wake)
        reject(new DeliveryQueueUnavailable(`RabbitMQ is ${state} at ${label}`))
      }, connectWaitMs)
      const wake = (): void => {
        clearTimeout(timer)
        resolve()
      }
      waiters.push(wake)
    })
  }

  /** Declares the exchange, the four queues and the binding. Idempotent: runs again after every reconnect. */
  async function declareTopology(broker: BrokerConnection): Promise<void> {
    let step = EXCHANGE
    try {
      await broker.exchangeDeclare({ exchange: EXCHANGE, type: 'direct', durable: true })
      for (const name of DELIVERY_QUEUES) {
        step = QUEUE_NAMES[name]
        await broker.queueDeclare({ queue: QUEUE_NAMES[name], durable: true, arguments: queueArguments(name) })
      }
      step = `binding to ${QUEUE_NAMES.main}`
      await broker.queueBind({ queue: QUEUE_NAMES.main, exchange: EXCHANGE, routingKey: ROUTING_KEY })
    } catch (error) {
      throw new TopologyFailure(step, error)
    }
  }

  /**
   * A declaration failed (an argument changed since an earlier version, an auth failure, a lost connection).
   * One line per distinct failure, naming the queue and the error class and code only. The state becomes
   * unavailable with that detail, and declarations wait out a backoff (1 s doubling to 30 s).
   */
  function failTopology(error: unknown): void {
    const step = error instanceof TopologyFailure ? error.step : 'connection'
    const cause = error instanceof TopologyFailure ? error.failure : error
    const summary = errorSummary(cause)
    topologyFailures += 1
    topologyRetryAt = Date.now() + Math.min(retryBaseMs * 2 ** (topologyFailures - 1), MAX_RETRY_MS)
    topologyError = `${step}: ${summary}`
    const key = `${step} ${summary}`
    if (key !== topologyKey) {
      topologyKey = key
      log(`RabbitMQ topology not declared at ${label} (${step}: ${summary}); requests fail until it is, retrying with backoff`)
    }
  }

  function recoverTopology(): void {
    if (topologyKey !== '') log(`RabbitMQ topology declared at ${label}`)
    topologyError = undefined
    topologyKey = ''
    topologyFailures = 0
    topologyRetryAt = 0
  }

  /** The connection, connected and with the topology declared. Every failure comes out as DeliveryQueueUnavailable. */
  async function ready(): Promise<BrokerConnection> {
    try {
      const broker = connect()
      if (!up) await waitConnected()
      if (!topology) {
        if (Date.now() < topologyRetryAt) {
          throw new DeliveryQueueUnavailable(`RabbitMQ topology not declared at ${label} (${topologyError ?? 'retry pending'})`)
        }
        topology = declareTopology(broker).then(recoverTopology, (error: unknown) => {
          topology = null
          failTopology(error)
          throw error
        })
      }
      await topology
      return broker
    } catch (error) {
      if (error instanceof DeliveryQueueUnavailable) throw error
      throw new DeliveryQueueUnavailable(`RabbitMQ ${errorSummary(error)} at ${label}`)
    }
  }

  function attemptOf(headers: unknown): number {
    const value = (headers as { attempt?: unknown } | undefined)?.attempt
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
  }

  /** Publishes with confirm. Used by publish() and by the disposition of a consumed delivery. */
  async function send(queue: DeliveryQueueName, message: QueueMessage, reason?: string): Promise<void> {
    const broker = await ready()
    publisher ??= broker.createPublisher({ confirm: true, maxAttempts: 1 })
    try {
      await publisher.send({
        ...routeOf(queue),
        messageId: message.deliveryId,
        type: message.event,
        contentType: 'application/json',
        durable: true,
        headers: { attempt: message.attempt, ...(reason ? { reason: cutReason(reason) } : {}) }
      }, message.body)
    } catch (error) {
      // Not confirmed: the caller must not treat the delivery as kept.
      throw new DeliveryQueueUnavailable(`publish not confirmed (${errorSummary(error)})`)
    }
  }

  /**
   * Performs the handler's disposition and returns the status the client settles the delivery with. A copy that
   * is not confirmed returns REQUEUE after a pause, so the handler does not run again at once; the attempt
   * count and x-delivery-limit bound the loop, and each failed attempt logs one line with the delivery id.
   */
  async function settleWith(disposition: Disposition, message: HandedMessage): Promise<ConsumerStatus> {
    if (disposition === 'ack') return ConsumerStatus.ACK
    try {
      if ('fail' in disposition) {
        await send('failed', { ...message, attempt: message.attempt }, disposition.fail)
      } else {
        await send(disposition.retry, { ...message, attempt: message.attempt + 1 }, disposition.reason)
      }
      // The copy is confirmed; now the original is removed. A repeat after a crash here is safe (the claim table).
      return ConsumerStatus.ACK
    } catch (error) {
      log(`GitHub delivery ${cutReason(message.deliveryId) || '(no id)'} could not be moved (${errorSummary(error)}); requeued after ${requeueDelayMs} ms`)
      await new Promise(resolve => setTimeout(resolve, requeueDelayMs))
      return ConsumerStatus.REQUEUE
    }
  }

  return {
    kind: 'rabbitmq',

    async publish(queue, message: QueueMessage) {
      if (message.body.length > MAX_BODY_BYTES) throw new DeliveryTooLarge(message.body.length)
      await send(queue, message)
    },

    async consume(onMessage: ConsumeHandler, options: ConsumeOptions) {
      if (options.prefetch !== 1) throw new RangeError('prefetch must be 1')
      const timeoutMs = options.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS
      const broker = await ready()
      // The handler's disposition stands for the delivery: the client acks or requeues the delivery when this
      // promise resolves. On RabbitMQ the ack is implicit in that status. A failed ack is not seen by the handler;
      // it arrives as a consumer error, logged with the id of the last delivery this consumer handled (prefetch 1
      // makes that the one in question), and the broker redelivers.
      const pending = new Set<(status: ConsumerStatus) => void>()
      hands.add(pending)
      let stopping = false
      let lastId = '(none)'
      const consumer = broker.createConsumer({
        queue: QUEUE_NAMES.main,
        queueOptions: { durable: true, arguments: queueArguments('main') },
        // The prefetch of 1 is per channel, and a reconnect opens a fresh channel. No client-side limit is set,
        // so a handler still in hand from the dead connection cannot hold the new consumer back.
        qos: { prefetchCount: 1 },
        requeue: true
      }, message => new Promise<ConsumerStatus>((resolve) => {
        let settled = false
        const settle = (status: ConsumerStatus): void => {
          if (settled) return
          settled = true
          pending.delete(settle)
          resolve(status)
        }
        pending.add(settle)
        // After stop, a redelivery is given straight back: no new work starts.
        if (stopping) {
          settle(ConsumerStatus.REQUEUE)
          return
        }
        const handed: HandedMessage = {
          deliveryId: message.messageId ?? '',
          event: message.type ?? '',
          attempt: attemptOf(message.headers),
          body: message.rawBody,
          redelivered: message.redelivered
        }
        lastId = cutReason(handed.deliveryId) || '(no id)'
        void decide(onMessage, handed, { timeoutMs, maxBodyBytes: MAX_BODY_BYTES }, log)
          .then(disposition => settleWith(disposition, handed))
          .then(settle, () => settle(ConsumerStatus.REQUEUE))
      }))
      consumer.on('error', (error: unknown) => {
        log(`RabbitMQ consumer reported ${errorSummary(error)} after delivery ${lastId}; the client resubscribes`)
      })
      return async () => {
        stopping = true
        hands.delete(pending)
        for (const settle of [...pending]) settle(ConsumerStatus.REQUEUE)
        await consumer.close()
      }
    },

    async depth() {
      const broker = await ready()
      const { messageCount } = await broker.queueDeclare({ queue: QUEUE_NAMES.main, passive: true })
      return messageCount
    },

    async failedDepth() {
      const broker = await ready()
      const { messageCount } = await broker.queueDeclare({ queue: QUEUE_NAMES.failed, passive: true })
      return messageCount
    },

    status(): QueueStatus {
      // Connected but not declared: the queue is unavailable, and the health view says why.
      if (topologyError && state === 'connected') return { state: 'unavailable', broker: label, detail: topologyError }
      return { state, broker: label, ...(detail ? { detail } : {}) }
    },

    crashForTest() {
      connection?.unsafeDestroy()
    },

    async close() {
      if (closed) return
      closed = true
      setState('closed', `RabbitMQ closed for ${label}`)
      await publisher?.close()
      await connection?.close()
    }
  }
}
