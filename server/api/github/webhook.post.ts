import { createError, defineEventHandler, getHeader, getRequestWebStream, setResponseHeader, setResponseStatus } from 'h3'
import { refreshForEvent } from '../../utils/githubSync'
import { readCappedBody, repositoryOf, signatureMatches } from '../../utils/githubCards'
import type { DeliveryJob } from '../../utils/githubCards'
import { deliveryQueue, repoAcceptLimit } from '../../utils/githubDeliveryQueue'

const MAX_BODY_BYTES = 2 * 1024 * 1024

// The events that can change what a link shows. Others are accepted and ignored.
const HANDLED_EVENTS = new Set(['issues', 'issue_comment', 'pull_request', 'check_run', 'workflow_run'])
// The events the card syncer takes. Each is queued, and counted against the repository's per-minute limit.
const SYNCED_EVENTS = new Set(['issues', 'issue_comment'])

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
    // The job is kept before the answer: if the queue cannot take it, GitHub is told 503 and retries.
    const rawId = (payload as { repository?: { id?: unknown } }).repository?.id
    const now = Date.now()
    const job: DeliveryJob = {
      deliveryId,
      event: name,
      repoOwner: repository.owner,
      repoName: repository.repo,
      repoId: typeof rawId === 'number' && Number.isSafeInteger(rawId) && rawId > 0 ? rawId : 0,
      payload,
      receivedAt: now,
      firstSeenAt: now,
      attempt: 0
    }
    try {
      await deliveryQueue().enqueue(job)
    } catch (error) {
      console.error(`GitHub delivery ${deliveryId || '(no id)'} (${name}) could not be queued (${error instanceof Error ? error.name : 'non-Error'}); answered 503`)
      throw createError({ statusCode: 503, message: 'The delivery could not be taken; redeliver it' })
    }
  }
  setResponseStatus(event, 202)
  return { ok: true, handled: true }
})
