// The vocabulary of the delivery queue, shared by the RabbitMQ adapter, the in-memory queue and the
// factory. No client code here, so the adapters import it without importing the factory back.

/** The queues of the delivery pipeline. `main` is the work; the retry queues come back to it; `failed` keeps what gave up. */
export const DELIVERY_QUEUES = ['main', 'retry30s', 'retry2m', 'failed'] as const
export type DeliveryQueueName = (typeof DELIVERY_QUEUES)[number]

/** How long each retry queue holds a delivery before it returns to main. The broker's TTL and the fake clock both read this. */
export const RETRY_TTL_MS = { retry30s: 30_000, retry2m: 120_000 } as const

/** The largest body accepted by publish and by consume: the webhook's own cap. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024

/** A handler that has not answered by then is failed as 'handler timeout'. */
export const DEFAULT_HANDLER_TIMEOUT_MS = 5 * 60_000

/** The broker moves a message that has been handed out this many times to failed (the backstop for consumers that die). */
export const DELIVERY_LIMIT = 5

/** The longest reason kept on a retry or failed delivery. Reasons are one line and never carry the payload. */
export const REASON_MAX = 200

/** One delivery as it is published. `body` is the signed GitHub payload, exactly as it arrived. */
export interface QueueMessage {
  deliveryId: string
  event: string
  /** Attempts made so far. A fresh delivery is 0; a retry is published with one more. */
  attempt: number
  body: Buffer
}

/** A delivery handed to the handler. */
export interface HandedMessage extends QueueMessage {
  /** The broker handed this message out before: an earlier consumer stopped or died with it unacked. */
  redelivered: boolean
}

/**
 * What the handler decides for a delivery; the adapter performs it:
 * - 'ack': the work is done, the delivery is removed.
 * - { retry, reason }: published again to that queue (with confirm, attempt + 1), then the original is removed.
 * - { fail, reason }: published to `failed` (with confirm), then the original is removed.
 * A handler that throws, returns nothing, returns something else, or takes longer than the timeout is
 * failed as 'handler error' or 'handler timeout'. A failed publish requeues the original and logs once.
 */
export type Disposition = 'ack' | { retry: 'retry30s' | 'retry2m', reason: string } | { fail: string }

/**
 * The handler. It must not requeue or ack by itself: it returns the disposition. Side effects happen
 * before it returns, so the ack always comes after them. Effects can run again after a crash, so they
 * must be idempotent (the claim table, keyed by the delivery id). A handler past its timeout gets its signal
 * aborted and its late answer discarded, but effects it has already made are not stopped or undone.
 */
// void is the handler that returns nothing: it is failed as 'handler error' at runtime.
// eslint-disable-next-line @typescript-eslint/no-invalid-void-type
export type ConsumeHandler = (message: HandedMessage, context: { signal: AbortSignal }) => Disposition | void | Promise<Disposition | void>

export interface ConsumeOptions {
  /** One delivery at a time per consumer. Only 1 is accepted. */
  prefetch: 1
  /** Time the handler gets before the delivery is failed as 'handler timeout'. Default 5 minutes. */
  handlerTimeoutMs?: number
}

export type QueueState = 'unavailable' | 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed'

export interface QueueStatus {
  state: QueueState
  /** describeBrokerUrl() of the broker, or null when there is none. Never the URL itself. */
  broker: string | null
  /** Why the queue is unavailable, in words without secrets. */
  detail?: string
}

/**
 * The one queue interface. Publish resolves only after the broker confirmed the message. Consume hands
 * out one delivery at a time and performs the disposition the handler returns. Returns the stop function:
 * stop leaves the delivery in hand for redelivery (its late disposition is then ignored).
 *
 * Ack reporting: on RabbitMQ the client acks when the handler's status is returned, so a failed ack is not
 * seen by the handler and only shows as a logged consumer error. A connection lost before the ack reached
 * the broker means the delivery is redelivered. A failed ack on RabbitMQ is logged with the id of the last delivery
 * the consumer handled (prefetch 1 makes that the one in question). The memory queue logs the id of the settle that failed.
 * A repeat is therefore possible, and the claim table keyed
 * by delivery id is what makes it safe. The in-memory queue reports a settle after a drop as an error.
 */
export interface DeliveryQueue {
  readonly kind: 'rabbitmq' | 'memory'
  publish(queue: DeliveryQueueName, message: QueueMessage): Promise<void>
  consume(onMessage: ConsumeHandler, options: ConsumeOptions): Promise<() => Promise<void>>
  /** Ready messages in `main`. */
  depth(): Promise<number>
  /** Messages in `failed`. */
  failedDepth(): Promise<number>
  status(): QueueStatus
  close(): Promise<void>
}

/** The queue cannot take or hand out work right now. The webhook maps it to 503. */
export class DeliveryQueueUnavailable extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'DeliveryQueueUnavailable'
  }
}

/** The body is over MAX_BODY_BYTES. The webhook maps it to 413. */
export class DeliveryTooLarge extends Error {
  constructor(bytes: number) {
    super(`body of ${bytes} bytes is over ${MAX_BODY_BYTES}`)
    this.name = 'DeliveryTooLarge'
  }
}

/**
 * The only thing allowed to print a broker URL: scheme, host, port and vhost, with the user and the
 * password replaced. `amqp://user:pw@127.0.0.1:5672/vhost` becomes `amqp://***@127.0.0.1:5672/vhost`.
 * Input that does not parse is not echoed at all.
 */
export function describeBrokerUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return 'amqp://***'
  }
  if (url.protocol !== 'amqp:' && url.protocol !== 'amqps:') return 'amqp://***'
  const port = url.port || (url.protocol === 'amqps:' ? '5671' : '5672')
  return `${url.protocol}//***@${url.hostname}:${port}${url.pathname || '/'}`
}

/**
 * The class and, when it is a short plain code, the code of an error. Messages are never used: a
 * client error can carry the broker URL, and a URL parse error carries its input.
 */
export function errorSummary(error: unknown): string {
  if (!(error instanceof Error)) return 'non-Error'
  const code = (error as { code?: unknown }).code
  const plain = typeof code === 'string' || typeof code === 'number' ? String(code) : ''
  return /^[A-Za-z0-9_.-]{1,40}$/.test(plain) ? `${error.name} ${plain}` : error.name
}

/** A reason as it is kept: one line, cut, never more than REASON_MAX characters. */
export function cutReason(reason: string): string {
  return reason.replace(/[\r\n\t]+/g, ' ').slice(0, REASON_MAX)
}

function isDisposition(value: unknown): value is Exclude<Disposition, 'ack'> {
  if (typeof value !== 'object' || value === null) return false
  const v = value as { retry?: unknown, fail?: unknown, reason?: unknown }
  if (typeof v.fail === 'string') return true
  return (v.retry === 'retry30s' || v.retry === 'retry2m') && typeof v.reason === 'string'
}

/**
 * Runs the handler and turns its outcome into a disposition. Never throws, and never leaves a delivery
 * undecided: a throw, a missing or malformed answer, an oversize body or a timeout becomes a failure.
 * On a timeout the handler's AbortSignal is aborted, and an answer that comes later is discarded with one line.
 * Aborting stops nothing by itself: effects the handler already made are not undone, so they are idempotent
 * by the claim table. Logs the delivery id and the error class only.
 */
export async function decide(
  onMessage: ConsumeHandler,
  message: HandedMessage,
  options: { timeoutMs: number, maxBodyBytes: number },
  log: (line: string) => void
): Promise<Disposition> {
  const id = cutReason(message.deliveryId) || '(no id)'
  if (message.body.length > options.maxBodyBytes) return { fail: 'body over size cap' }
  const controller = new AbortController()
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<Disposition>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
      resolve({ fail: 'handler timeout' })
    }, options.timeoutMs)
    // A handler that never answers must not keep the process alive for the rest of its timeout.
    ;(timer as { unref?: () => void }).unref?.()
  })
  const outcome = Promise.resolve()
    .then(() => onMessage(message, { signal: controller.signal }))
    .then((result): Disposition => {
      if (timedOut) {
        log(`GitHub delivery ${id} (${message.event}): handler answered after its timeout; the answer is discarded`)
        return { fail: 'handler timeout' }
      }
      if (result === 'ack') return 'ack'
      if (isDisposition(result)) {
        return 'fail' in result ? { fail: cutReason(result.fail) } : { retry: result.retry, reason: cutReason(result.reason) }
      }
      log(`GitHub delivery ${id} (${message.event}): handler returned no disposition; failed`)
      return { fail: 'handler error' }
    }, (error: unknown): Disposition => {
      if (timedOut) {
        log(`GitHub delivery ${id} (${message.event}): handler threw after its timeout (${errorSummary(error)}); discarded`)
        return { fail: 'handler timeout' }
      }
      log(`GitHub delivery ${id} (${message.event}): handler threw ${errorSummary(error)}; failed`)
      return { fail: 'handler error' }
    })
  try {
    const decided = await Promise.race([outcome, timeout])
    if (decided !== 'ack' && 'fail' in decided && decided.fail === 'handler timeout') {
      log(`GitHub delivery ${id} (${message.event}): handler timeout; failed, handler aborted`)
    }
    return decided
  } finally {
    clearTimeout(timer)
  }
}
