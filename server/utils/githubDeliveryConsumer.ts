// The consumer of GitHub deliveries. It takes one queued delivery at a time, applies it through
// processGithubDelivery, and returns what should happen to it: ack (applied, or applied before), a retry on a
// delay queue, or the failed path. On the failed path the database row is written first, then the queue
// copies the delivery to `failed`, then the original is acked. Every failure the adapter decides itself (a
// timeout, a throw, an oversize body) goes through beforeFail first, so it has its row too.
//
// Budgets. One delivery's whole run (its database calls and its work) has BUDGET_MS. The queue gives the handler
// ADAPTER_TIMEOUT_MS, which must be longer, so the consumer always answers first. Each database call of a run has
// DB_LIMIT_MS and never outlives the budget. The failure record and the late answers use their own DB_LIMIT_MS,
// so a run that ran out of budget still records its last failure.
//
// Abort. When the adapter gives up on an attempt, its signal is aborted; so is the apply's signal when the budget
// runs out. The run stops at its next step. The apply stops at its next store call: processGithubDelivery checks
// its signal before each card-store call and leaves a call that is waiting behind (see guardStore in githubCards).
// A store write that is already running may still finish on its own; no later call runs. Card writes are
// idempotent, so such a write is harmless when the delivery is retried.
//
// Late answers. An apply that finishes after its attempt was given up is decided by the attempt number, and the
// retry copy or the failed row already published decides what it may change:
//   - attempts made before the last one: a late success or failure is discarded. The retry copy is in the delay
//     queue and runs the work again (idempotent), so it is the one that records the success.
//   - the last attempt: the failed row was already written. A late success is recorded (success row) and the row
//     goes to resolved; a late failure is discarded (the row stays as it is).
// A late answer writes no hold and no new row of its own; each one logs one line with the delivery id.
//
// Ordering. One consumer with prefetch 1 applies one delivery at a time. A retry leaves main, so while a delivery
// of a repository waits in a delay queue its later deliveries would overtake it. They are not applied: they are
// published behind it in the same delay queue (same wait, so they come back after it) and acked here. The hold
// lasts at most HOLD_MAX_AGE_MS. It lives in this process: a restart forgets it, so a delivery that arrives after
// the restart can be applied before an older retried one, and the older one can then overwrite the newer content.
// An abandoned attempt sets no hold either (the retry copy is published by the adapter), so the same window applies.
// Idempotence prevents duplicates, not that order. Two consumers would not share the hold.
//
// Busy. An apply of a repository that is still running (an orphan of an abandoned attempt) is not overlapped. The
// delivery waits in the 30 s queue with the same attempt count, up to MAX_BUSY_DEFERRALS times in a row; then it
// takes an attempt. Once the orphan is older than the hold age, the next busy delivery takes an attempt too. So a
// hung orphan costs its repository at most the ladder, never an unbounded wait.
//
// At-least-once. A crash between a side effect and the ack, or between a publish and the ack, makes the broker
// redeliver. The card writes check what exists first, and the success row in github_deliveries makes a redelivery
// of an applied delivery a plain ack. A crash between a retry publish and the ack leaves a second copy of the retry;
// a crash between the copy to `failed` and the ack leaves a second copy there. Both are known.
import { DeliveryError, repositoryOf } from './githubCards'
import type { DeliveryJob } from './githubCards'
import { DELIVERY_LIMIT, errorSummary, MAX_ATTEMPTS, retryQueueForAttempt } from './githubDeliveryQueueTypes'
import type { ConsumeHandler, DeliveryQueue, Disposition, HandedMessage } from './githubDeliveryQueueTypes'
import { failureCode } from './githubDeliveryFailures'
import type { FailureClass, FailureRows } from './githubDeliveryFailures'
import { announceDeliveryFailed } from './agentEvents'

export { MAX_ATTEMPTS } from './githubDeliveryQueueTypes'
/** One delivery's whole run: its database calls and its work. Must be shorter than ADAPTER_TIMEOUT_MS. */
export const BUDGET_MS = 60_000
/** The queue's limit for the handler, longer than the budget: it fires only when the handler does not stop. */
export const ADAPTER_TIMEOUT_MS = 120_000
/** Every database call gets this long (and a run's calls never more than the budget left). */
export const DB_LIMIT_MS = 30_000
/** A repository hold, and a busy repository, older than this is dropped (a hold) or counts as stuck (busy). */
export const HOLD_MAX_AGE_MS = 10 * 60_000
/** A busy repository defers one delivery this many times in a row, then the delivery takes an attempt. */
export const MAX_BUSY_DEFERRALS = 20
/** On shutdown the work in hand gets this long to finish before it is requeued. */
export const SHUTDOWN_WAIT_MS = 20_000

type RetryQueue = 'retry30s' | 'retry2m'

/** The record of applied deliveries (github_deliveries). Insert-or-ignore: a second record changes nothing. */
export interface DeliveryLedger {
  succeeded(deliveryId: string): Promise<boolean>
  recordSucceeded(entry: { deliveryId: string, event: string, owner: string, repo: string, receivedAt: number }): Promise<void>
}

export interface ConsumerDeps {
  ledger: DeliveryLedger
  failures: FailureRows
  /** Applies one delivery. The signal is aborted when the attempt is given up (the adapter's timeout or the budget). */
  apply: (job: DeliveryJob, signal: AbortSignal) => Promise<unknown>
  now?: () => number
  log?: (line: string) => void
  budgetMs?: number
  dbLimitMs?: number
  holdMaxAgeMs?: number
}

export interface DeliveryConsumer {
  /** The handler the queue calls for each delivery. It returns the disposition; the queue performs it. */
  handle: ConsumeHandler
  /** Records a failure the adapter decided (a timeout after the last attempt, an oversize body), before its copy to failed. */
  beforeFail(message: HandedMessage, reason: string): Promise<void>
  /** Resolves true once no delivery is in hand and no apply is still running, or false when the limit passed first. */
  idle(limitMs: number): Promise<boolean>
}

interface Hold {
  deliveryId: string
  queue: RetryQueue
  since: number
}

interface Parsed {
  payload: unknown
  repo: { owner: string, repo: string } | null
  repoId: number
}

/** An apply of one repository that has not settled yet (an orphan of an abandoned attempt included). */
interface Running {
  done: boolean
  since: number
}

/** The run's signals: the adapter's (abandon), and the one that stops the apply (the adapter's or the budget's). */
interface Ctx {
  signal: AbortSignal
  apply: AbortSignal
  deadline: number
  /** Set when this run waited in the busy queue instead of concluding: its busy count is kept. */
  deferred: boolean
}

/** Thrown when the adapter has given up on the attempt: the run stops, and writes nothing more. */
class Abandoned extends Error {
  constructor() {
    super('the adapter gave up on this attempt')
    this.name = 'Abandoned'
  }
}

function cutText(text: string, max: number): string {
  return text.replace(/[\r\n\t]+/g, ' ').slice(0, max)
}

/**
 * Tells the crew's pm that a delivery gave up for good. Called only for a row that did not exist before, after the row
 * is written, and never throws: the failed path does not wait for it.
 */
function tellPm(failure: { deliveryId: string, event: string, owner: string, repo: string, class: FailureClass, attempts: number, reason: string }): void {
  try {
    announceDeliveryFailed({
      deliveryId: failure.deliveryId,
      event: failure.event,
      owner: failure.owner,
      repo: failure.repo,
      class: failure.class,
      attempts: failure.attempts,
      code: failureCode(failure.reason)
    })
  } catch (error) {
    console.error(`[github] could not tell the PM of ${failure.deliveryId || '(no id)'} (${errorSummary(error)})`)
  }
}

/** The body as the webhook received it, parsed. Null when it is not JSON (a poison body). */
function parseBody(body: Buffer): Parsed | null {
  let payload: unknown
  try {
    payload = JSON.parse(body.toString('utf8'))
  } catch {
    return null
  }
  const rawId = (payload as { repository?: { id?: unknown } } | null)?.repository?.id
  const repoId = typeof rawId === 'number' && Number.isSafeInteger(rawId) && rawId > 0 ? rawId : 0
  return { payload, repo: repositoryOf(payload), repoId }
}

/**
 * Waits for work at most limitMs, and never past the run's budget. The adapter's abort ends the wait with
 * Abandoned, and a limit ends it with a transient failure. The work is not cancelled here: the caller keeps
 * tracking it.
 */
function bounded<T>(work: Promise<T>, limitMs: number, what: string, ctx: Ctx): Promise<T> {
  if (ctx.signal.aborted) return Promise.reject(new Abandoned())
  const left = Math.min(limitMs, ctx.deadline - Date.now())
  if (left <= 0) return Promise.reject(new DeliveryError('transient', `${what}: the delivery ran past its budget`))
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: () => void = () => {}
  const stop = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DeliveryError('transient', `${what} took longer than ${Math.round(left / 1000)} s`)), left)
    ;(timer as { unref?: () => void }).unref?.()
    onAbort = () => reject(new Abandoned())
    ctx.signal.addEventListener('abort', onAbort, { once: true })
  })
  return Promise.race([work, stop]).finally(() => {
    clearTimeout(timer)
    ctx.signal.removeEventListener('abort', onAbort)
  })
}

/** A call made after its run has stopped: its own limit only, not any run's budget. */
function detached<T>(work: Promise<T>, what: string, limitMs = DB_LIMIT_MS): Promise<T> {
  return bounded(work, limitMs, what, {
    signal: new AbortController().signal,
    apply: new AbortController().signal,
    deadline: Date.now() + limitMs,
    deferred: false
  })
}

export function createDeliveryConsumer(queue: Pick<DeliveryQueue, 'publish'>, deps: ConsumerDeps): DeliveryConsumer {
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => {})
  const budgetMs = deps.budgetMs ?? BUDGET_MS
  const dbLimitMs = deps.dbLimitMs ?? DB_LIMIT_MS
  const holdMaxAgeMs = deps.holdMaxAgeMs ?? HOLD_MAX_AGE_MS
  const holds = new Map<string, Hold>()
  const applying = new Map<string, Running>()
  const busyDeferrals = new Map<string, number>()
  const inFlight = new Set<Promise<unknown>>()

  const track = <T>(work: Promise<T>): Promise<T> => {
    inFlight.add(work)
    const forget = (): void => {
      inFlight.delete(work)
    }
    work.then(forget, forget)
    return work
  }

  /** The hold of a repository, unless it is older than the maximum age: then it is dropped and the repository moves on. */
  function liveHold(key: string | null): Hold | undefined {
    if (!key) return undefined
    const hold = holds.get(key)
    if (!hold) return undefined
    if (now() - hold.since < holdMaxAgeMs) return hold
    holds.delete(key)
    log(`a hold on ${key} passed its maximum age and was dropped`)
    return undefined
  }

  function retryLater(message: HandedMessage, key: string | null, reason: string, holding: boolean): Disposition {
    const queueName = retryQueueForAttempt(message.attempt + 1)
    const text = cutText(reason, 200)
    if (holding && key) holds.set(key, { deliveryId: message.deliveryId, queue: queueName, since: now() })
    log(`GitHub delivery ${message.deliveryId || '(no id)'} (${message.event}): ${text}; retried in ${queueName}`)
    return { retry: queueName, reason: text }
  }

  /**
   * A success or a failure that came after its attempt was given up. The retry copy or the failed row that was
   * already published decides what it may change (see the header). One log line; never a hold.
   */
  async function lateAnswer(message: HandedMessage, made: number, succeeded: boolean, parsed: Parsed | null, at: number): Promise<void> {
    const id = message.deliveryId || '(no id)'
    if (!succeeded || made < MAX_ATTEMPTS) {
      log(`GitHub delivery ${id} (${message.event}): a late ${succeeded ? 'success' : 'failure'} after the attempt was given up is discarded; the retry runs the work again`)
      return
    }
    try {
      await detached(deps.ledger.recordSucceeded({
        deliveryId: message.deliveryId,
        event: message.event,
        owner: parsed?.repo?.owner ?? '',
        repo: parsed?.repo?.repo ?? '',
        receivedAt: at
      }), 'recording a late success')
      await detached(deps.failures.markResolved(message.deliveryId), 'resolving the record')
      log(`GitHub delivery ${id} (${message.event}): a late success after the last attempt is recorded; its row is resolved`)
    } catch (error) {
      log(`GitHub delivery ${id} (${message.event}): a late success could not be recorded (${errorSummary(error)})`)
    }
  }

  function stopIfAbandoned(error: unknown): void {
    if (error instanceof Abandoned) throw error
  }

  async function decideFor(message: HandedMessage, parsed: Parsed | null, key: string | null, ctx: Ctx): Promise<Disposition> {
    const id = message.deliveryId
    const made = message.attempt + 1
    const step = <T>(work: Promise<T>, what: string): Promise<T> => bounded(work, dbLimitMs, what, ctx)

    // The failed path: the row first. The row is written even when the run's budget is spent (its own limit), so
    // the last failure is kept; an abandoned attempt writes nothing (its adapter has already written the row).
    const giveUp = async (kind: FailureClass, reason: string): Promise<Disposition> => {
      const at = now()
      // A row that did not exist before: the PM is told once (tellPm); a retried row that fails again is not news.
      const fresh = !record
      try {
        if (ctx.signal.aborted) throw new Abandoned()
        await detached(deps.failures.upsertFailed({
          deliveryId: id,
          event: message.event,
          owner: parsed?.repo?.owner ?? null,
          repo: parsed?.repo?.repo ?? null,
          repoId: parsed && parsed.repoId > 0 ? parsed.repoId : null,
          attempts: Math.min(made, MAX_ATTEMPTS),
          class: kind,
          reason: cutText(reason, 300),
          payload: message.body.toString('utf8'),
          firstSeenAt: at,
          failedAt: at
        }), 'recording the failure')
        if (fresh) tellPm({ deliveryId: id, event: message.event, owner: parsed?.repo?.owner ?? '', repo: parsed?.repo?.repo ?? '', class: kind, attempts: Math.min(made, MAX_ATTEMPTS), reason })
      } catch (error) {
        stopIfAbandoned(error)
        return retryLater(message, key, `could not record the failure (${errorSummary(error)})`, true)
      }
      log(`GitHub delivery ${id} (${message.event}) gave up after ${made} attempt(s): ${kind}, ${cutText(reason, 200)}`)
      return { fail: cutText(reason, 200) }
    }

    // Applied before: ack without work, and the row of a retried delivery is resolved (idempotent).
    // Gave up before: copy to failed again (the copy may not have been confirmed). Discarded: done.
    let record: Awaited<ReturnType<FailureRows['find']>>
    try {
      if (await step(deps.ledger.succeeded(id), 'reading the ledger')) {
        await step(deps.failures.markResolved(id), 'resolving the record')
        return 'ack'
      }
      record = await step(deps.failures.find(id), 'reading the record')
    } catch (error) {
      stopIfAbandoned(error)
      return retryLater(message, key, `could not read the records (${errorSummary(error)})`, true)
    }
    if (record?.state === 'discarded' || record?.state === 'resolved') return 'ack'
    if (record?.state === 'failed') return { fail: cutText(record.reason ?? 'failed earlier', 200) }

    // The broker counts the hand-outs of a message. From the fourth on (one short of DELIVERY_LIMIT) the row is
    // written here and the delivery fails now. If the write or its retry publish fails, the message is requeued and
    // handed out again; the broker dead-letters it without a row only after a failed write at each of the fourth and
    // fifth hand-outs, when the next hand-out comes (README: "Dead-lettered messages without a row").
    if (message.deliveries >= DELIVERY_LIMIT - 1) {
      return giveUp('transient', `handed out ${message.deliveries} times by the broker (limit ${DELIVERY_LIMIT})`)
    }

    // An earlier delivery of this repository waits for its retry: this one goes behind it, unapplied.
    const holding = liveHold(key)
    if (holding && holding.deliveryId !== id) {
      try {
        await step(queue.publish(holding.queue, { deliveryId: id, event: message.event, attempt: message.attempt, body: message.body }), 'holding the delivery')
        return 'ack'
      } catch (error) {
        stopIfAbandoned(error)
        return retryLater(message, key, `could not wait behind an earlier delivery (${errorSummary(error)})`, false)
      }
    }

    // A failed record write leaves the delivery with its attempts used up: it is recorded, not applied again.
    if (message.attempt >= MAX_ATTEMPTS) return giveUp('transient', 'the attempts are used up')
    if (!parsed) return giveUp('permanent', 'the body is not JSON')

    // An apply of this repository still running (an orphan of an abandoned attempt) is not overlapped. The delivery
    // waits in the 30 s queue with the same attempt count, up to MAX_BUSY_DEFERRALS times in a row. An orphan older
    // than the hold age, or a streak past the bound, is counted as an attempt, so the ladder always ends.
    const busy = key ? applying.get(key) : undefined
    if (busy && !busy.done) {
      const deferrals = (busyDeferrals.get(id) ?? 0) + 1
      if (now() - busy.since >= holdMaxAgeMs || deferrals > MAX_BUSY_DEFERRALS) {
        busyDeferrals.delete(id)
        return retryLater(message, key, 'an earlier attempt of this repository is still running', false)
      }
      busyDeferrals.set(id, deferrals)
      ctx.deferred = true
      try {
        await step(queue.publish('retry30s', { deliveryId: id, event: message.event, attempt: message.attempt, body: message.body }), 'waiting for the repository')
        return 'ack'
      } catch (error) {
        stopIfAbandoned(error)
        return retryLater(message, key, `could not wait for the repository (${errorSummary(error)})`, false)
      }
    }
    busyDeferrals.delete(id)

    const at = now()
    const job: DeliveryJob = {
      deliveryId: id,
      event: message.event,
      repoOwner: parsed.repo?.owner ?? '',
      repoName: parsed.repo?.repo ?? '',
      repoId: parsed.repoId,
      payload: parsed.payload,
      receivedAt: at,
      firstSeenAt: at,
      attempt: message.attempt
    }
    const work = Promise.resolve().then(() => deps.apply(job, ctx.apply))
    let settled = false
    const finished = work.then(() => {
      settled = true
      return true
    }, () => {
      settled = true
      return false
    })
    const running: Running = { done: false, since: now() }
    if (key) applying.set(key, running)
    track(finished.then(() => {
      running.done = true
      if (key && applying.get(key) === running) applying.delete(key)
    }))
    try {
      await bounded(work, Infinity, 'the work', ctx)
    } catch (error) {
      // An apply still running after its attempt was given up: its answer is decided by lateAnswer.
      if (!settled) void finished.then(ok => lateAnswer(message, made, ok, parsed, at))
      stopIfAbandoned(error)
      if (error instanceof DeliveryError && error.kind === 'permanent') return giveUp('permanent', error.reason)
      const reason = error instanceof DeliveryError
        ? error.reason
        : error instanceof Error && error.name === 'AbortError' ? 'the work was stopped at the budget' : `handler ${errorSummary(error)}`
      if (made >= MAX_ATTEMPTS) return giveUp('transient', reason)
      return retryLater(message, key, reason, true)
    }

    // The apply finished, but the attempt was given up meanwhile: a late success.
    if (ctx.signal.aborted) {
      await lateAnswer(message, made, true, parsed, at)
      throw new Abandoned()
    }

    try {
      await step(deps.ledger.recordSucceeded({ deliveryId: id, event: message.event, owner: job.repoOwner, repo: job.repoName, receivedAt: at }), 'recording the success')
      await step(deps.failures.markResolved(id), 'resolving the record')
    } catch (error) {
      stopIfAbandoned(error)
      return retryLater(message, key, `could not record the success (${errorSummary(error)})`, true)
    }
    return 'ack'
  }

  async function run(message: HandedMessage, adapterSignal: AbortSignal): Promise<Disposition> {
    const parsed = parseBody(message.body)
    const key = parsed?.repo ? `${parsed.repo.owner}/${parsed.repo.repo}`.toLowerCase() : null
    // The apply is stopped by the adapter's give-up or by the budget, whichever comes first.
    const applyStop = new AbortController()
    const stopApply = (): void => applyStop.abort()
    adapterSignal.addEventListener('abort', stopApply, { once: true })
    if (adapterSignal.aborted) stopApply()
    const budget = setTimeout(stopApply, budgetMs)
    ;(budget as { unref?: () => void }).unref?.()
    const ctx: Ctx = { signal: adapterSignal, apply: applyStop.signal, deadline: Date.now() + budgetMs, deferred: false }

    // The disposition of a run that stopped early is 'ack': the adapter has already settled the delivery.
    let disposition: Disposition = 'ack'
    try {
      disposition = await decideFor(message, parsed, key, ctx)
    } catch (error) {
      if (error instanceof Abandoned) {
        log(`GitHub delivery ${message.deliveryId || '(no id)'} (${message.event}): the adapter gave up on this attempt; nothing more is written`)
      } else {
        disposition = retryLater(message, key, `handler ${errorSummary(error)}`, true)
      }
    } finally {
      clearTimeout(budget)
      adapterSignal.removeEventListener('abort', stopApply)
      // Every outcome that is not a retry ends this delivery's hold, whatever path it came by.
      const retrying = typeof disposition === 'object' && 'retry' in disposition
      if (!retrying && key && holds.get(key)?.deliveryId === message.deliveryId) holds.delete(key)
      if (!ctx.deferred && typeof disposition === 'string') busyDeferrals.delete(message.deliveryId)
    }
    return disposition
  }

  async function beforeFail(message: HandedMessage, reason: string): Promise<void> {
    const parsed = parseBody(message.body)
    const at = now()
    const kind: FailureClass = reason === 'body over size cap' ? 'permanent' : 'transient'
    const fresh = !(await detached(deps.failures.exists(message.deliveryId), 'reading the record'))
    await detached(deps.failures.upsertFailed({
      deliveryId: message.deliveryId,
      event: message.event,
      owner: parsed?.repo?.owner ?? null,
      repo: parsed?.repo?.repo ?? null,
      repoId: parsed && parsed.repoId > 0 ? parsed.repoId : null,
      attempts: Math.min(message.attempt + 1, MAX_ATTEMPTS),
      class: kind,
      reason: cutText(reason, 300),
      payload: message.body.toString('utf8'),
      firstSeenAt: at,
      failedAt: at
    }), 'recording the failure')
    if (fresh) tellPm({ deliveryId: message.deliveryId, event: message.event, owner: parsed?.repo?.owner ?? '', repo: parsed?.repo?.repo ?? '', class: kind, attempts: Math.min(message.attempt + 1, MAX_ATTEMPTS), reason })
  }

  return {
    handle: (message, context) => track(run(message, context.signal)),
    beforeFail,
    async idle(limitMs) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const late = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), limitMs)
      })
      const done = Promise.allSettled([...inFlight]).then(() => true as const)
      try {
        return await Promise.race([done, late])
      } finally {
        clearTimeout(timer)
      }
    }
  }
}
