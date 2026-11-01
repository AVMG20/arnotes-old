import { auditRefusal, checkCrewKey, closeWindow, expireWindowIfDue, readGate, windowIsOpen } from '../utils/crewGate'
import { auditPeer, bucketOf, decide, isCrewApiPath, isLocalRequest, limitedStatus, noteDenial, overDenialLimit, peerOf, rateKey, trustSocket } from '../utils/crewGatePolicy'

// Every call on /api/crews and /api/crews/* passes here first (BRIEF-crew-feature 2b).
// A remote caller, or any caller while the window is shut and it is not local, gets a plain
// 404 that gives nothing away. Everything else must present a crews:manage key.
// Refused calls are counted per caller in its own bucket (local or remote), see crewGatePolicy.
export default defineEventHandler(async (event) => {
  if (!isCrewApiPath(event.path)) return

  const now = Date.now()
  const peer = peerOf(event)
  const local = isLocalRequest(peer, event.headers, trustSocket())
  const bucket = bucketOf(local)
  const key = rateKey(local, peer, event.headers)
  const from = auditPeer(peer, event.headers)
  const keyPresented = event.headers.has('authorization')

  // Over the limit of its own bucket: a local caller gets 429, a remote one the plain 404 and
  // nothing is counted or audited for it.
  if (overDenialLimit(bucket, key, now)) {
    const status = limitedStatus(local)
    throw createError({ statusCode: status, statusMessage: status === 429 ? 'Too Many Requests' : 'Not Found' })
  }

  // The window row comes from a cache of at most two seconds, so a flood of calls does not
  // read the database each time.
  const gate = await expireWindowIfDue(await readGate(), now)
  const windowOpen = windowIsOpen(gate, now)

  const verdict = local || windowOpen ? await checkCrewKey(event) : null
  const step = decide({ local, windowOpen, tempKeyId: gate.tempKeyId, verdict })
  if (step.pass) return

  noteDenial(bucket, key, now)
  // A refusal that closes the window is written now, before the window closes and the caller is answered.
  await auditRefusal({ from, method: event.method, path: event.path, outcome: step.outcome, keyPresented, now }, Boolean(step.closeReason))
  if (step.closeReason) await closeWindow(step.closeReason, from, now)

  if (step.status === 404) throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  throw createError({ statusCode: 401, statusMessage: 'Unauthorized', message: 'Invalid or missing API key' })
})
