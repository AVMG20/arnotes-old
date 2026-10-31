// Shared shape and argument parsing for the board MCP tools in mcpBoardTools.ts.
import type { ApiKeyScope } from '../db/schema'
import type { ApiKeyContext } from './api-keys'
import type { ProjectResource, WorkspaceCollection } from './realtime'

export interface McpToolDefinition {
  name: string
  title: string
  description: string
  scope: ApiKeyScope
  /** Advertised to clients so they can surface which tools change data. */
  readOnly: boolean
  /**
   * Recorded in the agent audit for the key's owner. Defaults to every write
   * (`!readOnly`); a read that touches secrets sets it.
   */
  audit?: boolean
  /** The staff-only collection a write tool changes, so the views showing it update live. */
  resource?: ProjectResource
  /** The workspace-wide list a write tool changes (goals, portfolios), so the pages showing it update live. */
  collection?: WorkspaceCollection
  /**
   * Advertised for the writes that cannot be undone, so a client can warn
   * first. Nothing sets it today: every delete an agent can reach goes to a
   * trash the user can empty or undo, and boards cannot be deleted over MCP
   * at all.
   */
  destructive?: boolean
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
  handler: (args: Record<string, unknown>, context: ApiKeyContext) => Promise<unknown>
}

/** A failure the model should read and retry, rather than a transport-level error. */
export class McpToolError extends Error {}

export function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || !value.trim()) {
    throw new McpToolError(`"${key}" is required and must be a non-empty string.`)
  }
  return value
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new McpToolError(`"${key}" must be a string.`)
  return value
}

export function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new McpToolError(`"${key}" must be true or false.`)
  return value
}

/**
 * Runs one of the shared field checks, which reject with an HTTP error, and
 * hands its message back as a failure the model can read and retry.
 */
export function asToolError<T>(check: () => T): T {
  try {
    return check()
  } catch (error) {
    throw toToolError(error)
  }
}

/** The same for a check that has to read the database first. */
export async function asToolErrorAsync<T>(check: () => Promise<T>): Promise<T> {
  try {
    return await check()
  } catch (error) {
    throw toToolError(error)
  }
}

function toToolError(error: unknown): unknown {
  const failure = error as { statusCode?: number, message?: string, statusMessage?: string }
  return failure.statusCode
    ? new McpToolError(failure.message ?? failure.statusMessage ?? 'That value is not valid.')
    : error
}

export function optionalStringArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new McpToolError(`"${key}" must be an array of strings.`)
  }
  return value as string[]
}

export function optionalLimit(args: Record<string, unknown>, key: string, fallback: number, max: number): number {
  const value = args[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    throw new McpToolError(`"${key}" must be a positive number.`)
  }
  return Math.min(Math.floor(value), max)
}

export function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2)
}

/**
 * The id inside a reference someone pasted.
 *
 * Taskmanager already addresses everything by a URL the user can copy straight out
 * of the address bar — /projects/<id>, /projects/<id>?task=<id> and their
 * /public/ equivalents — so a pasted link is the easiest way to point an
 * agent at one exact thing, with no title to describe and no id to retype.
 *
 * `prefer: 'task'` reads the task a board link has open; 'page' reads the
 * board the link is for. Anything that is not a link comes back untouched
 * and goes on being used as an id or a name, so a board actually named
 * "Q1/Q2 roadmap" is still found by its name.
 */
export function idFromReference(ref: string, prefer: 'task' | 'page' = 'page'): string {
  const trimmed = ref.trim()
  if (!/^(https?:\/\/|\/)/i.test(trimmed)) return trimmed

  let path: string
  let taskId: string | null
  try {
    // A bare path needs a base to parse against; the origin is discarded anyway.
    const url = new URL(trimmed, 'https://arnotes.invalid')
    path = url.pathname
    taskId = url.searchParams.get('task')
  } catch {
    return trimmed
  }

  if (prefer === 'task' && taskId) return taskId
  return decodeURIComponent(path.split('/').filter(Boolean).at(-1) ?? '') || trimmed
}

/**
 * A short excerpt of plain text, for the list-shaped results that show what a
 * task is about without spending the whole body on it.
 *
 * With search terms it centres on the first one that hits, keeping `lead`
 * characters of run-up; with none it takes the opening of the text, which is
 * what a card shows. Either end that was cut is marked with an ellipsis so the
 * model can tell an excerpt from a complete body and fetch the rest.
 */
export function excerpt(text: string, terms: string[] = [], length = 200, lead = 60): string {
  if (!text) return ''
  const lowered = text.toLowerCase()
  const firstHit = terms.map(term => lowered.indexOf(term)).filter(index => index >= 0).sort((a, b) => a - b)[0] ?? 0
  const start = Math.max(0, firstHit - lead)
  const snippet = text.slice(start, start + length).trim()
  return (start > 0 ? '…' : '') + snippet + (start + length < text.length ? '…' : '')
}
