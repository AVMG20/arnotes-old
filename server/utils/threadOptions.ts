// The options get_task takes for its thread of updates, and the rules they follow.
// Kept apart from mcpBoardTools.ts so the rules can be tested without the database.
import type { Audience } from './auth-helpers'
import { commentVisibleTo } from './commentVisibility'
import { McpToolError } from './mcpToolKit'

const THREAD_ORDERS = ['oldest', 'newest'] as const

/** The most updates one get_task call reads; a longer thread is read in pieces with since. */
export const THREAD_CAP = 5000
export const THREAD_CAP_NOTE = `thread longer than ${THREAD_CAP}, use since: only the first ${THREAD_CAP} updates after the since mark were read`

export const SINCE_REFUSAL = '"since" must be a full ISO 8601 time with a zone, such as 2026-11-02T10:00:00Z or 2026-11-02T10:00:00.250+01:00, or the id of an update on this task that you can see.'
const SINCE_HINT = 'a full ISO 8601 time with a zone, such as 2026-11-02T10:00:00Z, or the id of an update on this task'
const PREFIX_HINT = 'the text an update starts with, such as "NITPICKER:" or "QUESTION"'

export interface ThreadOptions {
  limit?: number
  order: (typeof THREAD_ORDERS)[number]
  /** A zoned ISO time or an update id, as written; taskDetail resolves it. */
  since?: string
  prefix?: string
}

/** The fields the thread selection reads from an update. */
export interface ThreadUpdate {
  body: string
  visibility: string
}

const ZONED_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/

/**
 * The instant a full ISO 8601 time with a zone names, in epoch milliseconds, or undefined
 * when the text is anything else. Checked by round trip, so 2026-02-30 is refused, not rolled over.
 */
export function parseSinceTime(since: string): number | undefined {
  const match = ZONED_TIME.exec(since)
  if (!match) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const zone = match[8] ?? ''
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return undefined
  if (day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return undefined
  let offset = 0
  if (zone !== 'Z') {
    const zoneHours = Number(zone.slice(1, 3))
    const zoneMinutes = Number(zone.slice(4, 6))
    if (zoneHours > 23 || zoneMinutes > 59) return undefined
    offset = (zoneHours * 60 + zoneMinutes) * (zone.startsWith('-') ? -1 : 1)
  }
  const millis = Number((match[7] ?? '').padEnd(3, '0').slice(0, 3))
  return Date.UTC(year, month - 1, day, hour, minute, second, millis) - offset * 60_000
}

/**
 * Text for prefix matching on both sides: compatibility form (NFKC), lower case, and one
 * form of final sigma, so ΟΔΟΣ and ΟΔΟΣΑ meet and so do odos and ODOS.
 */
export function foldCase(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/ς/g, 'σ')
}

function threadText(args: Record<string, unknown>, key: string, hint: string): string | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !value.trim()) throw new McpToolError(`"${key}" must be ${hint}.`)
  return value.trim()
}

/** Reads get_task's thread options, refusing what it cannot use and naming what it can. */
export function readThreadOptions(args: Record<string, unknown>): ThreadOptions {
  const limit = args.limit as number | null | undefined
  if (limit !== undefined && limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 200)) {
    throw new McpToolError('"limit" must be a whole number from 1 to 200, or left out to get the last 5 updates.')
  }
  const order = args.order ?? 'newest'
  if (typeof order !== 'string' || !(THREAD_ORDERS as readonly string[]).includes(order)) {
    throw new McpToolError('"order" must be "oldest" or "newest".')
  }
  const since = threadText(args, 'since', SINCE_HINT)
  // Something that starts like a date but is not a zoned time is refused here, not read as an id.
  if (since !== undefined && /^\d{4}-/.test(since) && parseSinceTime(since) === undefined) {
    throw new McpToolError(SINCE_REFUSAL)
  }
  return {
    limit: limit ?? 5,
    order: order as ThreadOptions['order'],
    since,
    prefix: threadText(args, 'prefix', PREFIX_HINT)
  }
}

/** Keeps at most THREAD_CAP updates, reporting whether the thread was longer. */
export function capThread<T>(rows: T[]): { rows: T[], truncated: boolean } {
  return rows.length > THREAD_CAP ? { rows: rows.slice(0, THREAD_CAP), truncated: true } : { rows, truncated: false }
}

/**
 * The updates get_task returns, from the thread (oldest first, already cut to the window
 * the database read): those the caller may see that start with `prefix`, in the order
 * asked for, cut to `limit`. `matched` counts every update that passed before the cut.
 */
export function selectUpdates<T extends ThreadUpdate>(rows: T[], options: ThreadOptions, audience: Audience): { shown: T[], matched: number } {
  const prefix = options.prefix === undefined ? undefined : foldCase(options.prefix)
  const matching = rows.filter(row =>
    commentVisibleTo(audience, row.visibility)
    && (prefix === undefined || foldCase(row.body.trimStart()).startsWith(prefix)))
  const ordered = options.order === 'newest' ? [...matching].reverse() : matching
  return { shown: ordered.slice(0, options.limit), matched: matching.length }
}
