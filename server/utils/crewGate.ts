import type { H3Event } from 'h3'
import { desc, eq, lt } from 'drizzle-orm'
import { db } from '../db'
import { apiKeys, crewApiAudit, crewApiGate, user } from '../db/schema'
import { authenticateApiKey, generateApiKey, hasScope } from './api-keys'
import { closingWriter, recordAudit, type AuditRoute } from './auditRouting'
import { throttledTask } from './periodicTask'
import { BoundedQueue } from './boundedQueue'
import { CREW_KEY_SCOPE, type KeyVerdict } from './crewGatePolicy'
import { MAX_TTL_MS, readThrough, TtlCache } from './ttlCache'

// The window state (BRIEF-crew-feature 2b) lives in the database: one row, so a restart
// neither leaves the window open nor forgets why it closed. Reads go through a cache of at
// most two seconds, cleared on every open, close and expiry in this process.
const GATE_ID = 'gate'
export const WINDOW_MS = 10 * 60_000

export interface GateState {
  openUntil: number | null
  openedBy: string | null
  tempKeyId: string | null
  closedReason: string | null
  closedFrom: string | null
  closedAt: number | null
}

const CLOSED: GateState = { openUntil: null, openedBy: null, tempKeyId: null, closedReason: null, closedFrom: null, closedAt: null }
const gateCache = new TtlCache<GateState>(MAX_TTL_MS)

/** Forgets the cached window row; the next read goes to the database. */
export function forgetGate(): void {
  gateCache.clear()
}

async function loadGate(): Promise<GateState> {
  const [row] = await db.select().from(crewApiGate).where(eq(crewApiGate.id, GATE_ID))
  if (!row) return { ...CLOSED }
  return {
    openUntil: row.openUntil ?? null,
    openedBy: row.openedBy ?? null,
    tempKeyId: row.tempKeyId ?? null,
    closedReason: row.closedReason ?? null,
    closedFrom: row.closedFrom ?? null,
    closedAt: row.closedAt ?? null
  }
}

export async function readGate(): Promise<GateState> {
  return { ...(await readThrough(gateCache, Date.now(), loadGate)) }
}

export function windowIsOpen(gate: GateState, now: number): boolean {
  return gate.openUntil !== null && gate.openUntil > now
}

async function revokeKey(keyId: string | null): Promise<void> {
  if (!keyId) return
  await db.delete(apiKeys).where(eq(apiKeys.id, keyId))
}

async function saveGate(values: Partial<GateState>): Promise<void> {
  const row = { id: GATE_ID, ...values }
  try {
    await db.insert(crewApiGate).values(row).onConflictDoUpdate({ target: crewApiGate.id, set: values })
  } finally {
    forgetGate()
  }
}

/** Shuts the window: its temporary key is revoked and the reason and place are kept. */
export async function closeWindow(reason: string, from: string | null, at: number): Promise<void> {
  const gate = await readGate()
  await revokeKey(gate.tempKeyId)
  await saveGate({ openUntil: null, tempKeyId: null, closedReason: reason, closedFrom: from, closedAt: at })
}

/** Closes the window by itself once its time has passed. Returns the state after that. */
export async function expireWindowIfDue(gate: GateState, now: number): Promise<GateState> {
  if (gate.openUntil === null || gate.openUntil > now) return gate
  await closeWindow('timed out', null, gate.openUntil)
  return readGate()
}

/** Opens the window for WINDOW_MS and mints its key. The token is returned once and never stored. */
export async function openWindow(adminId: string, now: number): Promise<{ token: string, openUntil: number }> {
  const previous = await readGate()
  await revokeKey(previous.tempKeyId)

  const generated = generateApiKey()
  const keyId = Date.now().toString(36) + Math.random().toString(36).slice(2)
  const openUntil = now + WINDOW_MS
  await db.insert(apiKeys).values({
    id: keyId,
    userId: adminId,
    teamId: null,
    name: 'crew API window (temporary)',
    keyHash: generated.hash,
    keyPrefix: generated.displayPrefix,
    scopes: [CREW_KEY_SCOPE],
    expiresAt: openUntil,
    createdAt: now
  })
  await saveGate({
    openUntil,
    openedBy: adminId,
    tempKeyId: keyId,
    closedReason: null,
    closedFrom: null,
    closedAt: null
  })
  return { token: generated.token, openUntil }
}

/** Test and maintenance use: revokes the window's key and removes the window row, back to the fresh state. */
export async function resetGate(): Promise<void> {
  const gate = await readGate()
  await revokeKey(gate.tempKeyId)
  await db.delete(crewApiGate).where(eq(crewApiGate.id, GATE_ID))
  forgetGate()
}

/**
 * Checks the presented key the way the crew API does, plus the two rules the gate adds:
 * it needs crews:manage and its owner must still be the instance admin. Never throws.
 */
export async function checkCrewKey(event: H3Event): Promise<KeyVerdict> {
  let context
  try {
    context = await authenticateApiKey(event)
  } catch (error) {
    const message = (error as { message?: string }).message ?? ''
    return { ok: false, reason: /expired/i.test(message) ? 'expired' : 'bad key' }
  }
  if (!hasScope(context, CREW_KEY_SCOPE)) return { ok: false, reason: 'wrong scope' }
  const [row] = await db.select({ isInstanceAdmin: user.isInstanceAdmin }).from(user).where(eq(user.id, context.userId))
  if (!row?.isInstanceAdmin) return { ok: false, reason: 'not admin' }
  return { ok: true, keyId: context.keyId }
}

// Audit rows of ordinary refusals are queued and written in one batch a second. The queue is
// bounded: past its size a row is dropped and counted. The row of a call that closes the window
// is never queued; it is written at once (see auditRouting.ts). The prune runs in the background
// and never blocks a write; its failures are counted, not thrown.
const AUDIT_QUEUE_MAX = 1000
const FLUSH_EVERY_MS = 1000
// Audit rows older than this are dropped; the prune runs at most once an hour per process.
const AUDIT_RETENTION_MS = 90 * 86_400_000
const PRUNE_EVERY_MS = 3_600_000
type AuditRow = typeof crewApiAudit.$inferInsert
const auditQueue = new BoundedQueue<AuditRow>(AUDIT_QUEUE_MAX)
let flushTimer: ReturnType<typeof setInterval> | null = null
const failures = { rows: 0, closing: 0 }

const prune = throttledTask(PRUNE_EVERY_MS, async (now) => {
  await db.delete(crewApiAudit).where(lt(crewApiAudit.at, now - AUDIT_RETENTION_MS))
})

export function auditStats(): { queued: number, dropped: number, failedRows: number, closingFailed: number, pruneRuns: number, pruneFailures: number } {
  return {
    queued: auditQueue.length,
    dropped: auditQueue.dropped,
    failedRows: failures.rows,
    closingFailed: failures.closing,
    pruneRuns: prune.runs,
    pruneFailures: prune.failures
  }
}

async function insertRows(rows: AuditRow[]): Promise<void> {
  await db.insert(crewApiAudit).values(rows)
}

/** Writes the queued audit rows in one insert. A failed batch is counted and logged by count only. */
export async function flushAudit(): Promise<void> {
  prune.trigger(Date.now())
  const batch = auditQueue.drain()
  if (!batch.length) return
  try {
    await insertRows(batch)
  } catch (error) {
    failures.rows += batch.length
    console.error(`[crew-api] audit write failed for ${batch.length} rows:`, (error as Error).message)
  }
}

// A closing row that fails to write is counted and logged; the refusal is answered regardless.
const writeClosingRow = closingWriter((row: AuditRow) => insertRows([row]), (error) => {
  failures.closing++
  console.error('[crew-api] audit write failed for a closing refusal:', (error as Error).message)
})

function ensureFlushing(): void {
  if (flushTimer) return
  flushTimer = setInterval(() => void flushAudit(), FLUSH_EVERY_MS)
  // The timer must not keep the process alive on its own.
  flushTimer.unref?.()
}

/**
 * Records the audit row for one refused call. Records the peer and the outcome; never the key.
 * A call that closes the window is written now, before the caller is answered.
 */
export async function auditRefusal(
  input: { from: string, method: string, path: string, outcome: string, keyPresented: boolean, now: number },
  closesWindow: boolean
): Promise<AuditRoute> {
  const row: AuditRow = {
    id: input.now.toString(36) + Math.random().toString(36).slice(2),
    at: input.now,
    peer: input.from,
    method: input.method,
    path: input.path.split('?')[0] ?? input.path,
    outcome: input.outcome,
    keyPresented: input.keyPresented
  }
  const route = await recordAudit({ queue: auditQueue, writeDirect: writeClosingRow }, row, closesWindow)
  ensureFlushing()
  return route
}

export async function recentAudit(limit = 20) {
  return db.select().from(crewApiAudit).orderBy(desc(crewApiAudit.at)).limit(limit)
}
