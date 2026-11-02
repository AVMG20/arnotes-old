// The rules for a linked repository's issue sync settings. The server refuses a
// bad value with these words, and the settings form shows the same words beside
// the field before anything is sent.

export const MAX_ACCEPTED_LOGINS = 20
export const MAX_LOGIN_LENGTH = 39
export const MAX_BRANCHES = 10
export const MAX_BRANCH_LENGTH = 100
export const MAX_COLUMN_NAME = 100

export type Outcome<T> = { ok: true, value: T } | { ok: false, message: string }

// A GitHub login: letters and digits, with single hyphens between them. No hyphen
// at the start or the end, and never two in a row. GitHub refuses the rest, so a
// login that breaks these can never match an issue.
const LOGIN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * The accepted logins from a text box (commas or spaces between them) or a list.
 * Lower-cased and de-duplicated. At least one is needed: an empty list would
 * ignore every issue, which is never what someone meant by saving.
 */
export function parseLogins(input: unknown): Outcome<string[]> {
  let parts: unknown[]
  if (typeof input === 'string') parts = input.split(/[\s,]+/)
  else if (Array.isArray(input)) parts = input
  else return { ok: false, message: 'Write the GitHub logins separated by commas' }

  const logins: string[] = []
  for (const part of parts) {
    if (typeof part !== 'string') return { ok: false, message: 'Write each GitHub login as text' }
    const login = part.trim().toLowerCase()
    if (!login) continue
    if (login.length > MAX_LOGIN_LENGTH) {
      return { ok: false, message: `"${login.slice(0, 20)}…" is longer than ${MAX_LOGIN_LENGTH} characters, so it is not a GitHub login` }
    }
    if (!LOGIN.test(login)) {
      return {
        ok: false,
        message: `"${login.slice(0, 40)}" is not a GitHub login: use letters and digits, with single hyphens between them, and no hyphen at the start or the end`
      }
    }
    if (!logins.includes(login)) logins.push(login)
  }
  if (logins.length === 0) return { ok: false, message: 'Keep at least one login: the repository owner\'s login is the usual choice' }
  if (logins.length > MAX_ACCEPTED_LOGINS) {
    return { ok: false, message: `At most ${MAX_ACCEPTED_LOGINS} logins; this has ${logins.length}` }
  }
  return { ok: true, value: logins }
}

// Letters, digits and the usual branch punctuation. Git accepts more, but these
// are the names a team writes; anything else is refused rather than guessed at.
const BRANCH = /^[A-Za-z0-9._/-]+$/

function branchProblem(branch: string): string | null {
  if (branch.length > MAX_BRANCH_LENGTH) return `"${branch.slice(0, 20)}…" is longer than ${MAX_BRANCH_LENGTH} characters`
  if (!BRANCH.test(branch)) return `"${branch}" has a character a branch name does not use here: use letters, digits, dots, hyphens, underscores and slashes`
  if (branch.startsWith('-') || branch.startsWith('/') || branch.endsWith('/') || branch.endsWith('.')) {
    return `"${branch}" cannot start or end with that character`
  }
  if (branch.includes('..') || branch.includes('//') || branch.endsWith('.lock')) return `"${branch}" is not a branch name Git accepts`
  return null
}

/**
 * Staging or production branch names, comma separated. Returns them as a list.
 * Empty is allowed: staging empty means there is none yet, production empty means
 * the repository's default branch.
 */
export function parseBranches(input: unknown, label: 'Staging' | 'Production'): Outcome<string[]> {
  if (typeof input !== 'string') return { ok: false, message: `Write the ${label.toLowerCase()} branches as comma separated names` }
  const branches: string[] = []
  for (const part of input.split(',')) {
    const branch = part.trim()
    if (!branch) continue
    const problem = branchProblem(branch)
    if (problem) return { ok: false, message: `${label} branch: ${problem}` }
    if (!branches.includes(branch)) branches.push(branch)
  }
  if (branches.length > MAX_BRANCHES) return { ok: false, message: `${label} branches: at most ${MAX_BRANCHES} names` }
  return { ok: true, value: branches }
}

/**
 * A branch named in both staging and production is refused. The comparison ignores
 * case here, although Git does not: `Main` and `main` count as the same branch, so
 * the one list cannot hold both. The message says so.
 */
export function sharedBranch(staging: string[], production: string[]): string | null {
  const productionLower = new Set(production.map(b => b.toLowerCase()))
  return staging.find(b => productionLower.has(b.toLowerCase())) ?? null
}

export function sharedBranchMessage(branch: string): string {
  return `"${branch}" is named as both staging and production. A branch is one or the other (names are compared without case here)`
}

/** The column name a new card goes to: any text, but it must name one of the board's columns. */
export function parseColumnName(input: unknown, columns: string[]): Outcome<string> {
  const name = typeof input === 'string' ? input.trim() : ''
  if (!name || name.length > MAX_COLUMN_NAME) return { ok: false, message: 'Pick one of the board\'s columns for new cards' }
  if (!columns.includes(name)) {
    return { ok: false, message: `There is no column called "${name}" on this board. Pick one of its columns` }
  }
  return { ok: true, value: name }
}

/** The fields the settings form edits, as the API sends and receives them. */
export interface RepoSyncSettings {
  enabled: boolean
  column: string
  visibility: 'internal' | 'customer'
  acceptedLogins: string[]
  ignoredCount: number
  lastIgnored: { login: string, number: number, title: string, at: number } | null
  stagingBranches: string
  productionBranches: string
  completeOnClose: boolean
}

const MANAGER_ROLES = ['owner', 'admin']

/**
 * Who may change issue sync and branch settings. The project's owner may, and so
 * may the team's owners and admins. On a team project the person must still be on
 * the team: someone who left it keeps no rights, even as the project's owner.
 * A personal project has only its owner. `teamRoles` is null when the person is not
 * on the team.
 */
export function managesRepoSync(input: { personal: boolean, isProjectOwner: boolean, teamRoles: string[] | null }): boolean {
  if (input.personal) return input.isProjectOwner
  if (input.teamRoles === null) return false
  if (input.isProjectOwner) return true
  return input.teamRoles.some(role => MANAGER_ROLES.includes(role))
}

/**
 * The words under the sync checkbox, from the box's own value (saved or edited).
 * With the box on and no login listed, every issue would be ignored, so that is said.
 */
export function syncStatusWords(enabled: boolean, logins: string): string {
  if (!enabled) return 'Off: no card is made from its issues.'
  const listed = logins.split(/[\s,]+/).some(part => part.trim() !== '')
  if (!listed) return 'On, but no login is listed: every issue is ignored until one is added.'
  return 'On: cards are made from issues by the accepted logins below.'
}
