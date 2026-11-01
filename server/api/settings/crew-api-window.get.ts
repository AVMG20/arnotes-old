import { auditStats, expireWindowIfDue, readGate, recentAudit, windowIsOpen } from '../../utils/crewGate'
import { requireInstanceAdmin } from '../../utils/instanceAdmin'

// The crew API window as the instance admin sees it: open or closed, why it closed, and the
// latest refused calls on /api/crews (peer, method, path and outcome; never a key).
export default defineEventHandler(async (event) => {
  await requireInstanceAdmin(event)
  const now = Date.now()
  const gate = await expireWindowIfDue(await readGate(), now)
  const rows = await recentAudit(20)
  return {
    open: windowIsOpen(gate, now),
    openUntil: gate.openUntil,
    openedBy: gate.openedBy,
    closedReason: gate.closedReason,
    closedFrom: gate.closedFrom,
    closedAt: gate.closedAt,
    auditQueue: auditStats(),
    audit: rows.map(row => ({ at: row.at, peer: row.peer, method: row.method, path: row.path, outcome: row.outcome, keyPresented: row.keyPresented }))
  }
})
