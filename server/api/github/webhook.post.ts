import { createError, defineEventHandler, getHeader, getRequestWebStream, setResponseHeader, setResponseStatus } from 'h3'
import { refreshForEvent } from '../../utils/githubSync'
import { readCappedBody, repositoryOf, signatureMatches } from '../../utils/githubCards'
import { DeliveryTooLarge } from '../../utils/githubDeliveryQueueTypes'
import { getDeliveryQueue } from '../../utils/githubDeliveryQueue'
import { repoAcceptLimit } from '../../utils/githubDeliveryLimit'

const MAX_BODY_BYTES = 2 * 1024 * 1024

// The events that can change what a link shows. Others are accepted and ignored.
const HANDLED_EVENTS = new Set(['issues', 'issue_comment', 'pull_request', 'check_run', 'workflow_run'])
// The events the card syncer takes. Each is queued, and counted against the repository's per-minute limit.
const SYNCED_EVENTS = new Set(['issues', 'issue_comment'])

// The delivery id GitHub sends in X-GitHub-Delivery (a UUID): plain characters, at most 100.
const DELIVERY_ID = /^[A-Za-z0-9-]{1,100}$/

// A synced event with no repository is answered 202 and queued for nothing. Logged, at most once a minute.
let lastNullRepositoryLog = 0
function logNullRepository(deliveryId: string, name: string): void {
  const now = Date.now()
  if (now - lastNullRepositoryLog < 60_000) return
  lastNullRepositoryLog = now
  console.warn(`GitHub delivery ${deliveryId} (${name}) names no repository: answered 202, nothing queued`)
}

// GitHub posts here when something changes. The body is signed with the webhook
// secret, so the signature is checked before a single field of it is read.
export default defineEventHandler(async (event) => {
  const secret = process.env.GITHUB_WEBHOOK_SECRET?.trim()
  if (!secret) throw createError({ statusCode: 503, message: 'GitHub webhooks are not set up on this server' })

  // Anyone can reach this route, so the body is bounded while it is read: a declared length
  // over the cap is refused at once, and a missing, chunked or wrong length is counted as the
  // bytes arrive. Nothing past the cap is buffered, and the signature is checked after the read.
  const declared = getHeader(event, 'content-length')
  if (declared !== undefined && /^\d+$/.test(declared) && Number(declared) > MAX_BODY_BYTES) {
    throw createError({ statusCode: 413, message: 'The webhook body is too large' })
  }
  const raw = await readCappedBody(getRequestWebStream(event) ?? event.node.req, MAX_BODY_BYTES)
  if (raw === null) throw createError({ statusCode: 413, message: 'The webhook body is too large' })
  if (raw.length === 0) throw createError({ statusCode: 401, message: 'Signature does not match' })

  if (!signatureMatches(raw, getHeader(event, 'x-hub-signature-256') ?? '', secret)) {
    throw createError({ statusCode: 401, message: 'Signature does not match' })
  }

  const name = getHeader(event, 'x-github-event') ?? ''
  const deliveryId = getHeader(event, 'x-github-delivery') ?? ''
  if (!HANDLED_EVENTS.has(name)) {
    setResponseStatus(event, 202)
    return { ok: true, handled: false }
  }

  // GitHub always sends the delivery id: it is the message id and the primary key of the failed table, so it must be
  // a plain id of at most 100 characters. Anything else is refused before it is stored.
  if (!DELIVERY_ID.test(deliveryId)) throw createError({ statusCode: 400, message: 'The webhook delivery id is not valid' })

  let payload: unknown
  try {
    payload = JSON.parse(raw.toString('utf8'))
  } catch {
    throw createError({ statusCode: 400, message: 'The webhook body is not JSON' })
  }

  // The per-minute limit runs before anything else for a synced event. Over it, GitHub is told 429
  // with Retry-After, so the delivery shows as failed and can be redelivered.
  const repository = SYNCED_EVENTS.has(name) ? repositoryOf(payload) : null
  if (repository && !repoAcceptLimit.allow(`${repository.owner}/${repository.repo}`.toLowerCase(), deliveryId)) {
    setResponseHeader(event, 'Retry-After', 60)
    throw createError({ statusCode: 429, message: 'Too many deliveries for this repository; redeliver it in a minute' })
  }

  // GitHub wants a quick answer; the refresh of the affected links runs after it.
  // A failed refresh is kept in the cache's retry time, so nothing is lost by dropping it here.
  refreshForEvent(name, (payload ?? {}) as Parameters<typeof refreshForEvent>[1]).catch((error: unknown) => {
    console.error(`GitHub delivery ${deliveryId || '(no id)'} (${name}): the link refresh failed (${error instanceof Error ? error.name : 'non-Error'})`)
  })

  if (repository) {
    // The delivery is queued before the answer: GitHub is told 202 only once the broker confirmed it. If the queue
    // cannot take it, GitHub is told 503 and redelivers. A body the queue will not take is 413, never dropped.
    try {
      await getDeliveryQueue().publish('main', { deliveryId, event: name, attempt: 0, body: raw })
    } catch (error) {
      if (error instanceof DeliveryTooLarge) throw createError({ statusCode: 413, message: 'The webhook body is too large' })
      console.error(`GitHub delivery ${deliveryId} (${name}) could not be queued (${error instanceof Error ? error.name : 'non-Error'}); answered 503`)
      throw createError({ statusCode: 503, message: 'The delivery could not be taken; redeliver it' })
    }
  } else if (SYNCED_EVENTS.has(name)) {
    logNullRepository(deliveryId, name)
  }
  setResponseStatus(event, 202)
  return { ok: true, handled: true }
})
