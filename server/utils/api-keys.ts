import type { H3Event } from 'h3'
import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { apiKeys, API_KEY_SCOPES } from '../db/schema'
import type { ApiKeyScope } from '../db/schema'
import { isTeamMember } from './auth-helpers'

// Keys are recognisable on sight so they can be spotted in configs and logs.
export const API_KEY_PREFIX = 'arn_'
const SECRET_BYTES = 32
// Enough of the key to tell two of them apart in the settings list.
const DISPLAY_PREFIX_LENGTH = API_KEY_PREFIX.length + 6

export interface GeneratedApiKey {
  /** The full key. Returned to the creator once and never stored. */
  token: string
  hash: string
  displayPrefix: string
}

export function hashApiKey(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function generateApiKey(): GeneratedApiKey {
  const token = API_KEY_PREFIX + randomBytes(SECRET_BYTES).toString('base64url')
  return {
    token,
    hash: hashApiKey(token),
    displayPrefix: token.slice(0, DISPLAY_PREFIX_LENGTH)
  }
}

export function isApiKeyScope(value: unknown): value is ApiKeyScope {
  return typeof value === 'string' && (API_KEY_SCOPES as readonly string[]).includes(value)
}

export interface ApiKeyContext {
  keyId: string
  /** The name the key was given, as the owner sees it in the agent audit. */
  keyName: string
  userId: string
  /** The single workspace this key may touch; null for the owner's personal workspace. */
  teamId: string | null
  scopes: ApiKeyScope[]
}

function readBearerToken(event: H3Event): string | null {
  const header = getRequestHeader(event, 'authorization')
  if (!header) return null
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || null
}

// Only touch the database when the stored value is meaningfully stale, so a busy
// agent does not issue a write per tool call.
const LAST_USED_WRITE_INTERVAL = 60_000

function touchLastUsed(keyId: string, previous: number | null, now: number) {
  if (previous && now - previous < LAST_USED_WRITE_INTERVAL) return
  db.update(apiKeys)
    .set({ lastUsedAt: now })
    .where(eq(apiKeys.id, keyId))
    .catch(() => {
      // Usage tracking is best-effort; never fail a request over it.
    })
}

// Sprocket's Claude Code runs call the MCP endpoint back as the agent the person picked.
// Each run gets its own token, held only in this process's memory and resolved to that
// agent's key, so the audit names the agent and nothing new is stored.
const RUN_TOKEN_TTL = 15 * 60_000
const runTokens = new Map<string, { keyId: string, expiresAt: number }>()

/** A token that acts as the key `keyId` until `revoke` is called or the TTL runs out. */
export function issueRunToken(keyId: string): { token: string, revoke: () => void } {
  const { token, hash } = generateApiKey()
  runTokens.set(hash, { keyId, expiresAt: Date.now() + RUN_TOKEN_TTL })
  return { token, revoke: () => runTokens.delete(hash) }
}

async function findKey(token: string) {
  const hash = hashApiKey(token)
  const run = runTokens.get(hash)
  if (run) {
    if (run.expiresAt <= Date.now()) {
      runTokens.delete(hash)
      return undefined
    }
    const [key] = await db.select().from(apiKeys).where(eq(apiKeys.id, run.keyId))
    return key
  }

  const [key] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, hash))
  if (!key) return undefined
  // The lookup already matched on a digest of the full secret; this compares the
  // digests themselves so the final decision does not depend on string timing.
  const presented = Buffer.from(hash, 'hex')
  const stored = Buffer.from(key.keyHash, 'hex')
  if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) return undefined
  return key
}

/**
 * Resolves the `Authorization: Bearer` key on a request into the workspace and
 * permissions it carries. Throws 401 when the key is missing, unknown, expired,
 * or no longer backed by a membership in the team it was issued for.
 */
export async function authenticateApiKey(event: H3Event): Promise<ApiKeyContext> {
  const token = readBearerToken(event)
  const unauthorized = () => createError({ statusCode: 401, message: 'Invalid or missing API key' })
  if (!token) throw unauthorized()

  const key = await findKey(token)
  if (!key) throw unauthorized()

  const now = Date.now()
  if (key.expiresAt && key.expiresAt <= now) {
    throw createError({ statusCode: 401, message: 'API key has expired' })
  }

  // A key pinned to a team dies with the owner's membership in it.
  if (key.teamId && !(await isTeamMember(key.userId, key.teamId))) {
    throw createError({ statusCode: 403, message: 'API key owner is no longer a member of this team' })
  }

  touchLastUsed(key.id, key.lastUsedAt, now)

  return {
    keyId: key.id,
    keyName: key.name,
    userId: key.userId,
    teamId: key.teamId,
    scopes: key.scopes.filter(isApiKeyScope)
  }
}

export function hasScope(context: ApiKeyContext, scope: ApiKeyScope): boolean {
  return context.scopes.includes(scope)
}
