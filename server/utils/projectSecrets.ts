// A project's secrets: environment variables kept encrypted in the database. The
// API routes and the agent tools share this module, so the rules live in one place:
// managers read and change every secret, members read only the ones shared with
// members, and nobody else sees any. Every change and every reveal is recorded in
// the trail, which never holds a value.
import type { H3Event } from 'h3'
import { and, asc, count, desc, eq } from 'drizzle-orm'
import { db } from '../db'
import { projectSecretEvents, projectSecrets, SECRET_ACCESS, user } from '../db/schema'
import type { ProjectSecret, SecretAccess, SecretEventAction } from '../db/schema'
import { genId } from './projects'
import { routeProject } from './projectResources'
import { vaultRoleOf } from './projectMembers'
import type { VaultRole } from './projectMembers'
import { decryptSecret, encryptSecret, secretsUnavailableReason } from './secretCrypto'

export const SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
export const MAX_SECRET_NAME = 100
export const MAX_SECRET_VALUE = 16384
export const MAX_SECRETS_PER_PROJECT = 200
export const MAX_SECRET_DESCRIPTION = 200

// Values in these characters need no quotes in a .env file.
const BARE_VALUE = /^[A-Za-z0-9_@%+=:,./-]+$/

export type VaultProject = { id: string, userId: string, teamId: string | null, archivedAt: number | null }

export interface SecretView {
  name: string
  description: string
  access: SecretAccess
  createdAt: number
  updatedAt: number
  updatedBy: { id: string, name: string } | null
}

export interface SecretInput {
  name: string
  value?: string
  description?: string
  access?: SecretAccess
}

export interface VaultEventView {
  action: SecretEventAction
  subject: string
  via: 'ui' | 'mcp'
  createdAt: number
  user: { id: string, name: string } | null
}

/** Throws a 400 unless the name is a valid variable name. */
export function assertSecretName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || name.length > MAX_SECRET_NAME || !SECRET_NAME_PATTERN.test(name)) {
    throw createError({
      statusCode: 400,
      message: `A name uses only letters, digits and underscores, does not start with a digit, and is at most ${MAX_SECRET_NAME} characters.`
    })
  }
}

// Managers see and change everything; members only what is shared with members.
function canRead(role: VaultRole | null, access: SecretAccess): boolean {
  if (role === 'manager') return true
  return role === 'member' && access === 'members'
}

function requireManager(role: VaultRole | null) {
  if (role !== 'manager') throw createError({ statusCode: 403, message: 'Only a project manager can change the secrets' })
}

function requireWritable(project: VaultProject) {
  if (project.archivedAt) {
    throw createError({ statusCode: 409, message: 'This project is archived. Unarchive it to change its secrets.' })
  }
}

// Reads that must decrypt, and writes that must encrypt, say why they cannot run.
function requireEncryption() {
  const reason = secretsUnavailableReason()
  if (reason) throw createError({ statusCode: 503, message: reason })
}

function secretQuery() {
  return db
    .select({ secret: projectSecrets, updaterName: user.name })
    .from(projectSecrets)
    .leftJoin(user, eq(user.id, projectSecrets.updatedBy))
}

async function findSecret(projectId: string, name: string) {
  const [row] = await secretQuery().where(and(eq(projectSecrets.projectId, projectId), eq(projectSecrets.name, name)))
  return row
}

// The ciphertext is bound to its project and name, so it cannot be moved onto another secret.
function contextOf(projectId: string, name: string): string {
  return `${projectId}:${name}`
}

function viewOf(row: { secret: ProjectSecret, updaterName: string | null }): SecretView {
  const { secret } = row
  return {
    name: secret.name,
    description: secret.description,
    access: secret.access,
    createdAt: secret.createdAt,
    updatedAt: secret.updatedAt,
    updatedBy: secret.updatedBy ? { id: secret.updatedBy, name: row.updaterName ?? 'Unknown' } : null
  }
}

/** Appends one row to the trail. Callers pass a name or a member's name, never a value. */
export async function recordVaultEvent(
  projectId: string,
  userId: string,
  via: 'ui' | 'mcp',
  action: SecretEventAction,
  subject: string
): Promise<void> {
  await db.insert(projectSecretEvents).values({
    id: genId(),
    projectId,
    action,
    subject,
    userId,
    via,
    createdAt: Date.now()
  })
}

/** The secrets this role may see, without values, by name. */
export async function listSecrets(project: VaultProject, role: VaultRole | null): Promise<SecretView[]> {
  if (!role) return []
  const rows = await secretQuery()
    .where(eq(projectSecrets.projectId, project.id))
    .orderBy(asc(projectSecrets.name))
  return rows.filter(row => canRead(role, row.secret.access)).map(viewOf)
}

/** One secret's value. A secret this role may not read is "not found", as if it did not exist. */
export async function revealSecret(
  project: VaultProject,
  role: VaultRole | null,
  userId: string,
  via: 'ui' | 'mcp',
  name: string
): Promise<{ name: string, value: string }> {
  const row = await findSecret(project.id, name)
  if (!row || !canRead(role, row.secret.access)) {
    throw createError({ statusCode: 404, message: 'Secret not found' })
  }
  requireEncryption()
  const value = decryptSecret(row.secret.ciphertext, contextOf(project.id, name))
  await recordVaultEvent(project.id, userId, via, 'reveal', name)
  return { name, value }
}

/** The fields of a request body as they were sent. saveSecret checks each one, so a wrong type is a 400. */
export function secretInputOf(body: unknown): SecretInput {
  const fields = (body ?? {}) as Record<string, unknown>
  return {
    name: fields.name as string,
    value: fields.value as string | undefined,
    description: fields.description as string | undefined,
    access: fields.access as SecretAccess | undefined
  }
}

function assertValue(value: unknown): asserts value is string {
  if (typeof value !== 'string') throw createError({ statusCode: 400, message: 'The value must be text.' })
  if (value.length > MAX_SECRET_VALUE) {
    throw createError({ statusCode: 400, message: `A value is at most ${MAX_SECRET_VALUE} characters.` })
  }
}

function assertDescription(description: unknown): void {
  if (description === undefined) return
  if (typeof description !== 'string' || description.length > MAX_SECRET_DESCRIPTION) {
    throw createError({ statusCode: 400, message: `A description is text of at most ${MAX_SECRET_DESCRIPTION} characters.` })
  }
}

function assertAccess(access: unknown): void {
  if (access === undefined) return
  if (!(SECRET_ACCESS as readonly unknown[]).includes(access)) {
    throw createError({ statusCode: 400, message: 'Access is either managers or members.' })
  }
}

/**
 * Adds a secret (`create`), changes one (`update`) or does either by name
 * (`upsert`). Without a value, an update keeps the stored value.
 */
export async function saveSecret(
  project: VaultProject,
  role: VaultRole | null,
  userId: string,
  via: 'ui' | 'mcp',
  input: SecretInput,
  mode: 'create' | 'update' | 'upsert'
): Promise<{ created: boolean, secret: SecretView }> {
  requireManager(role)
  requireWritable(project)
  assertSecretName(input.name)
  if (input.value !== undefined) assertValue(input.value)
  assertDescription(input.description)
  assertAccess(input.access)

  const name = input.name
  const existing = await findSecret(project.id, name)
  if (mode === 'create' && existing) throw createError({ statusCode: 409, message: `${name} already exists` })
  if (mode === 'update' && !existing) throw createError({ statusCode: 404, message: 'Secret not found' })
  if (!existing && input.value === undefined) throw createError({ statusCode: 400, message: 'Give the secret a value.' })
  if (input.value !== undefined) requireEncryption()

  const now = Date.now()
  if (!existing) {
    const [counted] = await db.select({ total: count() }).from(projectSecrets).where(eq(projectSecrets.projectId, project.id))
    if ((counted?.total ?? 0) >= MAX_SECRETS_PER_PROJECT) {
      throw createError({ statusCode: 400, message: `A project can hold at most ${MAX_SECRETS_PER_PROJECT} secrets. Delete one before adding another.` })
    }

    await db.insert(projectSecrets).values({
      id: genId(),
      projectId: project.id,
      name,
      description: input.description ?? '',
      ciphertext: encryptSecret(input.value!, contextOf(project.id, name)),
      access: input.access ?? 'managers',
      createdBy: userId,
      updatedBy: userId,
      createdAt: now,
      updatedAt: now
    })
    await recordVaultEvent(project.id, userId, via, 'create', name)
  } else {
    const changes: Partial<typeof projectSecrets.$inferInsert> = { updatedBy: userId, updatedAt: now }
    if (input.value !== undefined) changes.ciphertext = encryptSecret(input.value, contextOf(project.id, name))
    if (input.description !== undefined) changes.description = input.description
    if (input.access !== undefined) changes.access = input.access

    await db.update(projectSecrets).set(changes).where(eq(projectSecrets.id, existing.secret.id))
    await recordVaultEvent(project.id, userId, via, 'update', name)
  }

  const saved = await findSecret(project.id, name)
  return { created: !existing, secret: viewOf(saved!) }
}

export async function removeSecret(
  project: VaultProject,
  role: VaultRole | null,
  userId: string,
  via: 'ui' | 'mcp',
  name: string
): Promise<void> {
  requireManager(role)
  requireWritable(project)
  const row = await findSecret(project.id, name)
  if (!row) throw createError({ statusCode: 404, message: 'Secret not found' })

  await db.delete(projectSecrets).where(eq(projectSecrets.id, row.secret.id))
  await recordVaultEvent(project.id, userId, via, 'delete', name)
}

/**
 * The .env text of the secrets this role may read, or only `names` when given.
 * Asking for a name this role may not read is "not found", as above.
 */
export async function exportEnv(
  project: VaultProject,
  role: VaultRole | null,
  userId: string,
  via: 'ui' | 'mcp',
  names?: string[]
): Promise<{ env: string, names: string[] }> {
  const rows = await secretQuery()
    .where(eq(projectSecrets.projectId, project.id))
    .orderBy(asc(projectSecrets.name))
  const readable = rows.filter(row => canRead(role, row.secret.access))

  let chosen = readable
  if (names) {
    chosen = [...new Set(names)].map((wanted) => {
      const row = readable.find(candidate => candidate.secret.name === wanted)
      if (!row) throw createError({ statusCode: 404, message: 'Secret not found' })
      return row
    })
  }

  if (chosen.length > 0) requireEncryption()
  const entries = chosen.map(row => ({
    name: row.secret.name,
    value: decryptSecret(row.secret.ciphertext, contextOf(project.id, row.secret.name))
  }))

  const subject = names ? chosen.map(row => row.secret.name).join(', ') : `all readable (${chosen.length})`
  await recordVaultEvent(project.id, userId, via, 'export', subject)
  return { env: formatEnv(entries), names: entries.map(entry => entry.name) }
}

// One line per value, the way a .env file reads. Quotes only when the value needs them.
function quoteEnvValue(value: string): string {
  if (value === '') return ''
  if (BARE_VALUE.test(value)) return value
  if (!value.includes('\'') && !value.includes('\n')) return `'${value}'`
  const escaped = value
    .replace(/[\\"$]/g, '\\$&')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
  return `"${escaped}"`
}

export function formatEnv(entries: { name: string, value: string }[]): string {
  return [...entries]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(({ name, value }) => `${name}=${quoteEnvValue(value)}\n`)
    .join('')
}

/** The trail of who did what to the vault. Managers only. */
export async function listVaultEvents(project: VaultProject, role: VaultRole | null, limit = 100): Promise<VaultEventView[]> {
  if (role !== 'manager') throw createError({ statusCode: 403, message: 'Only a project manager can see the secrets trail' })
  const rows = await db
    .select({
      action: projectSecretEvents.action,
      subject: projectSecretEvents.subject,
      via: projectSecretEvents.via,
      createdAt: projectSecretEvents.createdAt,
      userId: projectSecretEvents.userId,
      userName: user.name
    })
    .from(projectSecretEvents)
    .leftJoin(user, eq(user.id, projectSecretEvents.userId))
    .where(eq(projectSecretEvents.projectId, project.id))
    .orderBy(desc(projectSecretEvents.createdAt))
    .limit(Math.min(limit, 500))

  return rows.map(row => ({
    action: row.action,
    subject: row.subject,
    via: row.via,
    createdAt: row.createdAt,
    user: row.userId ? { id: row.userId, name: row.userName ?? 'Unknown' } : null
  }))
}

/**
 * The project a vault route works on and the caller's vault role there. Customers'
 * contacts get a 404, never a hint that secrets exist.
 */
export async function routeVault(event: H3Event) {
  const project = await routeProject(event)
  if (project.audience !== 'staff') throw createError({ statusCode: 404, message: 'Project not found' })
  const userId = event.context.session.user.id
  const role = await vaultRoleOf(project, userId)
  return { project, userId, role }
}
