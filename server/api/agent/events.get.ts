// The event stream a crew's channel server pulls (CH1): Server-Sent Events for the owner of
// the agent key. Outbound pull only; nothing here listens for Taskmanager to push.
import { db } from '../../db'
import { agentAudit } from '../../db/schema'
import { authenticateApiKey, hasScope } from '../../utils/api-keys'
import type { ApiKeyContext } from '../../utils/api-keys'
import { agentEventHub, currentMembership, parseLastEventId, streamVerdict } from '../../utils/agentEvents'
import type { StreamConnection } from '../../utils/agentEvents'

async function auditConnect(context: ApiKeyContext) {
  try {
    await db.insert(agentAudit).values({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2),
      userId: context.userId,
      apiKeyId: context.keyId,
      keyName: context.keyName,
      tool: 'agent.events',
      toolTitle: 'Event stream connected',
      summary: 'Opened the agent event stream',
      createdAt: Date.now()
    })
  } catch (error) {
    // The audit is best effort, as it is for the tools; the connect goes on.
    console.error('[agent-events] could not audit a connect', error)
  }
}

export default defineEventHandler(async (event) => {
  const context = await authenticateApiKey(event)
  if (!hasScope(context, 'boards:read')) {
    throw createError({ statusCode: 403, message: 'This API key does not carry the "boards:read" permission' })
  }

  // The slot is taken before anything is awaited, so the cap counts this stream at once.
  const key = { keyId: context.keyId, userId: context.userId, teamId: context.teamId }
  const slot = agentEventHub.reserve(key)
  if (slot === 'rate') {
    throw createError({ statusCode: 429, message: 'Too many event stream connects, try again in a minute' })
  }
  if (slot === 'full') {
    throw createError({ statusCode: 503, message: 'The event stream is full on this server, try again later' })
  }

  // One place frees the slot: the reader leaving, the socket failing, or the stream ending.
  const res = event.node.res
  const gone = new Promise<void>((resolve) => {
    res.once('close', () => {
      slot.release()
      resolve()
    })
  })
  res.once('error', () => slot.release())

  await auditConnect(context)
  const membership = await currentMembership(context.userId)
  // Gone during the audit or the lookup: the slot is freed and nothing is sent.
  if (res.destroyed) {
    slot.release()
    return
  }

  res.statusCode = 200
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store, no-transform')
  res.setHeader('Connection', 'keep-alive')
  // Stops a proxy from holding the stream back until it is full.
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  const connection: StreamConnection = {
    write: (chunk) => {
      if (res.writableEnded || res.destroyed) throw new Error('the stream is closed')
      res.write(chunk)
    },
    pending: () => res.writableLength,
    end: () => res.end(),
    abort: () => res.destroy()
  }
  const lastEventId = parseLastEventId(getRequestHeader(event, 'last-event-id'))
  // A slot evicted while it waited (a newer stream for this key or user) cannot start: its socket is closed.
  if (!slot.activate(lastEventId, connection, membership, () => streamVerdict(key))) {
    slot.release()
    res.destroy()
    return
  }

  // The response stays open until the reader goes, or the stream is replaced or ended.
  await gone
})
