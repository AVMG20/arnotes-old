/* eslint-disable @typescript-eslint/no-explicit-any -- replies are read loosely: each test checks the fields it names */
// The issue sync settings of a linked repository (Settings > Repositories): the rules
// for logins, branches and columns, who may change them, and the routes that hold them.
// The rules run on their own:
//   node --import tsx --test tests/github-repo-sync.test.ts
// The routes run against a dev server when these are set (otherwise those cases skip):
//   GH_SYNC_TEST_BASE (default http://localhost:3000)
//   GH_SYNC_TEST_OWNER_EMAIL, GH_SYNC_TEST_OWNER_PASSWORD  the owner of GH_SYNC_TEST_PROJECT (a personal project works)
//   GH_SYNC_TEST_PROJECT  a project that owner may change
//   GH_SYNC_TEST_REPO  an owner/repo the GitHub owner allowlist accepts and that is NOT yet linked to that project
//   GH_SYNC_TEST_MEMBER_EMAIL, GH_SYNC_TEST_MEMBER_PASSWORD  optional: a team member who is not an owner or admin
//     of the same team as the project. Without it the non-owner refusal case is skipped.
// The link, and a second scratch project made for the cross-project cases, are removed at the end.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { managesRepoSync, parseBranches, parseColumnName, parseLogins, sharedBranch, sharedBranchMessage, syncStatusWords } from '../shared/utils/githubRepoSync'

// ── Logins ───────────────────────────────────────────────────────────

test('logins are lower-cased, de-duplicated and split on commas or spaces', () => {
  assert.deepEqual(parseLogins('Alice, bob  ALICE,carol-1'), { ok: true, value: ['alice', 'bob', 'carol-1'] })
  assert.deepEqual(parseLogins(['Dave', ' dave ']), { ok: true, value: ['dave'] })
})

test('a login longer than 39 characters is refused by its rule', () => {
  const result = parseLogins('a'.repeat(40))
  assert.equal(result.ok, false)
  assert.match(result.ok ? '' : result.message, /longer than 39 characters/)
  assert.equal(parseLogins('a'.repeat(39)).ok, true)
})

test('a login with a character GitHub does not allow is refused in words', () => {
  const result = parseLogins('good, bad_name')
  assert.equal(result.ok, false)
  assert.match(result.ok ? '' : result.message, /"bad_name" is not a GitHub login: use letters and digits/)
})

test('a leading, trailing or doubled hyphen is refused: GitHub never matches such a login', () => {
  for (const bad of ['-a', 'a-', 'a--b', '-']) {
    const result = parseLogins(bad)
    assert.equal(result.ok, false, bad)
    assert.match(result.ok ? '' : result.message, /no hyphen at the start or the end/, bad)
  }
  assert.equal(parseLogins('a-b-c9').ok, true)
})

test('more than 20 logins is refused and says how many', () => {
  const names = Array.from({ length: 21 }, (_, i) => `user${i}`)
  const result = parseLogins(names.join(','))
  assert.equal(result.ok, false)
  assert.match(result.ok ? '' : result.message, /At most 20 logins; this has 21/)
  assert.equal(parseLogins(names.slice(0, 20).join(',')).ok, true)
})

test('an empty list is refused: it would ignore every issue', () => {
  const result = parseLogins('  , ')
  assert.equal(result.ok, false)
  assert.match(result.ok ? '' : result.message, /Keep at least one login/)
  assert.equal(parseLogins(42).ok, false)
  assert.equal(parseLogins([42]).ok, false)
})

// ── Branches ─────────────────────────────────────────────────────────

test('branch names are kept in order without repeats, and empty is allowed', () => {
  assert.deepEqual(parseBranches('staging, release/1.2 ,staging', 'Staging'), { ok: true, value: ['staging', 'release/1.2'] })
  assert.deepEqual(parseBranches('', 'Production'), { ok: true, value: [] })
})

test('branch names git would not take are refused with the label', () => {
  for (const bad of ['a..b', 'a//b', '/lead', 'trail/', '-dash', 'x.lock', 'has space', 'semi;colon']) {
    const result = parseBranches(bad, 'Staging')
    assert.equal(result.ok, false, bad)
    assert.match(result.ok ? '' : result.message, /^Staging branch: /, bad)
  }
})

test('too many branch names, or one too long, is refused', () => {
  const eleven = Array.from({ length: 11 }, (_, i) => `b${i}`).join(',')
  const many = parseBranches(eleven, 'Production')
  assert.equal(many.ok, false)
  assert.match(many.ok ? '' : many.message, /at most 10 names/)
  assert.equal(parseBranches('x'.repeat(101), 'Staging').ok, false)
})

test('a branch named as both staging and production is found, and the message says names are compared without case', () => {
  assert.equal(sharedBranch(['main', 'staging'], ['main']), 'main')
  assert.equal(sharedBranch(['Main'], ['main']), 'Main')
  assert.equal(sharedBranch(['staging'], ['production']), null)
  assert.match(sharedBranchMessage('main'), /names are compared without case/)
})

// ── Columns ──────────────────────────────────────────────────────────

test('a new card column must be one of the board\'s columns', () => {
  assert.deepEqual(parseColumnName(' To do ', ['Backlog', 'To do']), { ok: true, value: 'To do' })
  const result = parseColumnName('Nope', ['Backlog', 'To do'])
  assert.equal(result.ok, false)
  assert.match(result.ok ? '' : result.message, /There is no column called "Nope" on this board/)
  assert.equal(parseColumnName('', ['Backlog']).ok, false)
})

// ── Who may change the settings ──────────────────────────────────────

test('the project owner of a personal project may change; nobody else may', () => {
  assert.equal(managesRepoSync({ personal: true, isProjectOwner: true, teamRoles: null }), true)
  assert.equal(managesRepoSync({ personal: true, isProjectOwner: false, teamRoles: null }), false)
})

test('on a team project: owners and admins may, plain members may not', () => {
  assert.equal(managesRepoSync({ personal: false, isProjectOwner: false, teamRoles: ['owner'] }), true)
  assert.equal(managesRepoSync({ personal: false, isProjectOwner: false, teamRoles: ['admin'] }), true)
  assert.equal(managesRepoSync({ personal: false, isProjectOwner: false, teamRoles: ['member'] }), false)
  assert.equal(managesRepoSync({ personal: false, isProjectOwner: true, teamRoles: ['member'] }), true)
})

test('someone who has left the team keeps no rights, even as the project owner', () => {
  assert.equal(managesRepoSync({ personal: false, isProjectOwner: true, teamRoles: null }), false)
  assert.equal(managesRepoSync({ personal: false, isProjectOwner: false, teamRoles: null }), false)
})

// ── Routes, against a dev server ─────────────────────────────────────

const BASE = process.env.GH_SYNC_TEST_BASE ?? 'http://localhost:3000'
const OWNER = process.env.GH_SYNC_TEST_OWNER_EMAIL
const OWNER_PASSWORD = process.env.GH_SYNC_TEST_OWNER_PASSWORD
const MEMBER = process.env.GH_SYNC_TEST_MEMBER_EMAIL
const MEMBER_PASSWORD = process.env.GH_SYNC_TEST_MEMBER_PASSWORD
const PROJECT = process.env.GH_SYNC_TEST_PROJECT
const REPO = process.env.GH_SYNC_TEST_REPO
const skip = OWNER && OWNER_PASSWORD && PROJECT && REPO
  ? false
  : 'set the GH_SYNC_TEST_* variables to run the route cases'
const memberSkip = MEMBER && MEMBER_PASSWORD ? false : 'no second staff account set: GH_SYNC_TEST_MEMBER_EMAIL'

async function call(method: string, path: string, cookie?: string, body?: unknown): Promise<{ status: number, json: any }> {
  const headers: Record<string, string> = { origin: BASE }
  if (cookie) headers.cookie = cookie
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { status: res.status, json }
}

async function signIn(email: string, password: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'origin': BASE },
    body: JSON.stringify({ email, password })
  })
  const cookie = res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
  await res.text()
  assert.equal(res.status, 200, 'the test account signs in')
  return cookie
}

const reposPath = `/api/projects/${PROJECT}/github/repos`
let ownerCookie = ''
let memberCookie = ''
let linkedId = ''
let otherProjectId = ''
let otherRepoId = ''

after(async () => {
  if (linkedId && ownerCookie) await call('DELETE', `${reposPath}/${linkedId}`, ownerCookie)
  if (otherProjectId && ownerCookie) await call('DELETE', `/api/projects/${otherProjectId}`, ownerCookie)
})

test('a new link starts with sync off, Backlog, internal, and the owner login', { skip }, async () => {
  ownerCookie = await signIn(OWNER!, OWNER_PASSWORD!)
  if (MEMBER && MEMBER_PASSWORD) memberCookie = await signIn(MEMBER, MEMBER_PASSWORD)
  const owner = REPO!.split('/')[0]!.toLowerCase()

  const before = await call('GET', reposPath, ownerCookie)
  assert.equal(before.status, 200)
  assert.equal(before.json.canManage, true)
  assert.equal(before.json.repos.some((r: any) => r.fullName.toLowerCase() === REPO!.toLowerCase()), false, 'GH_SYNC_TEST_REPO is already linked; use another')

  const made = await call('POST', reposPath, ownerCookie, { repo: REPO })
  assert.equal(made.status, 200, `link ${REPO}: ${made.json?.message}`)
  linkedId = made.json.id

  const list = await call('GET', reposPath, ownerCookie)
  const row = list.json.repos.find((r: any) => r.id === linkedId)
  assert.equal(row.sync.enabled, false)
  assert.equal(row.sync.column, 'Backlog')
  assert.equal(row.sync.visibility, 'internal')
  assert.deepEqual(row.sync.acceptedLogins, [owner])
  assert.equal(row.sync.ignoredCount, 0)
  assert.equal(row.sync.lastIgnored, null)
  assert.equal(row.sync.completeOnClose, false)
})

test('a member who is not an owner or admin reads the settings but cannot change them', { skip: memberSkip }, async () => {
  const read = await call('GET', reposPath, memberCookie)
  assert.equal(read.status, 200)
  assert.equal(read.json.canManage, false)
  const logins = await call('PUT', `${reposPath}/${linkedId}`, memberCookie, { acceptedLogins: 'mallory' })
  assert.equal(logins.status, 403)
  const branches = await call('PUT', `${reposPath}/${linkedId}`, memberCookie, { stagingBranches: 'staging' })
  assert.equal(branches.status, 403)
  const after403 = await call('GET', reposPath, ownerCookie)
  const line = after403.json.audit.find((a: any) => a.detail['Refused: Accepted logins'])
  assert.ok(line, 'the refused change is in the audit')
  assert.equal(line.detail['Refused: Accepted logins'].from, '')
})

test('an invalid login is refused in words that name the rule, and the answer names the field', { skip }, async () => {
  const bad = await call('PUT', `${reposPath}/${linkedId}`, ownerCookie, { acceptedLogins: 'bad_name' })
  assert.equal(bad.status, 400)
  assert.match(bad.json.message, /use letters and digits/)
  assert.equal(bad.json.data.field, 'acceptedLogins')
  const hyphen = await call('PUT', `${reposPath}/${linkedId}`, ownerCookie, { acceptedLogins: 'a--b' })
  assert.equal(hyphen.status, 400)
  assert.match(hyphen.json.message, /no hyphen at the start or the end/)
  const long = await call('PUT', `${reposPath}/${linkedId}`, ownerCookie, { acceptedLogins: 'a'.repeat(40) })
  assert.equal(long.status, 400)
  assert.match(long.json.message, /longer than 39/)
  const many = await call('PUT', `${reposPath}/${linkedId}`, ownerCookie, {
    acceptedLogins: Array.from({ length: 21 }, (_, i) => `user${i}`).join(',')
  })
  assert.equal(many.status, 400)
  assert.match(many.json.message, /At most 20/)
})

test('a refused value is written to the audit with what was asked, and no more', { skip }, async () => {
  const list = await call('GET', reposPath, ownerCookie)
  const line = list.json.audit.find((a: any) => a.detail['Refused: Accepted logins'])
  assert.ok(line, 'the audit has the refusal')
  for (const [key, change] of Object.entries<any>(line.detail)) {
    assert.equal(typeof change.from, 'string', key)
    assert.equal(typeof change.to, 'string', key)
    assert.ok(!/password|token|secret|apikey/i.test(`${key} ${change.from} ${change.to}`), key)
  }
})

test('saving keeps every field and the audit names the change', { skip }, async () => {
  const saved = await call('PUT', `${reposPath}/${linkedId}`, ownerCookie, {
    syncEnabled: true,
    syncColumn: 'Backlog',
    syncVisibility: 'customer',
    acceptedLogins: 'Alice, bob',
    stagingBranches: 'staging',
    productionBranches: '',
    completeOnClose: true
  })
  assert.equal(saved.status, 200, saved.json?.message)
  assert.deepEqual(saved.json.sync.acceptedLogins, ['alice', 'bob'])

  const list = await call('GET', reposPath, ownerCookie)
  const row = list.json.repos.find((r: any) => r.id === linkedId)
  assert.equal(row.sync.enabled, true)
  assert.equal(row.sync.visibility, 'customer')
  assert.equal(row.sync.column, 'Backlog')
  assert.equal(row.sync.stagingBranches, 'staging')
  assert.equal(row.sync.productionBranches, '')
  assert.equal(row.sync.completeOnClose, true)

  const line = list.json.audit.find((a: any) => String(a.repo).toLowerCase() === REPO!.toLowerCase() && a.detail['Issue sync'])
  assert.ok(line, 'the audit has a line for the repository')
  assert.deepEqual(line.detail['Issue sync'], { from: 'off', to: 'on' })
  assert.deepEqual(line.detail['Accepted logins'].to, 'alice, bob')
})

test('the counts the sync keeps cannot be written through the PUT', { skip }, async () => {
  const forged = await call('PUT', `${reposPath}/${linkedId}`, ownerCookie, {
    ignoredCount: 99,
    lastIgnored: { login: 'mallory', number: 1, title: 'x', at: 1 }
  })
  assert.equal(forged.status, 200)
  assert.equal(forged.json.sync.ignoredCount, 0)
  assert.equal(forged.json.sync.lastIgnored, null)
})

test('a repository of another project is not found through this project', { skip }, async () => {
  const made = await call('POST', '/api/projects', ownerCookie, { name: 'scratch:gh1 other project' })
  assert.equal(made.status, 200)
  otherProjectId = made.json.id
  const link = await call('POST', `/api/projects/${otherProjectId}/github/repos`, ownerCookie, { repo: REPO })
  assert.equal(link.status, 200, link.json?.message)
  otherRepoId = link.json.id
  const crossed = await call('PUT', `${reposPath}/${otherRepoId}`, ownerCookie, { syncEnabled: true })
  assert.equal(crossed.status, 404)
})

test('a column that exists only on another board is refused', { skip }, async () => {
  const column = await call('POST', `/api/projects/${otherProjectId}/columns`, ownerCookie, { name: 'only-elsewhere-gh1' })
  assert.ok(column.status < 300, 'the other board gets the column')
  const refused = await call('PUT', `${reposPath}/${linkedId}`, ownerCookie, { syncColumn: 'only-elsewhere-gh1' })
  assert.equal(refused.status, 400)
  assert.match(refused.json.message, /no column called "only-elsewhere-gh1" on this board/)
  assert.equal(refused.json.data.field, 'syncColumn')
})

test('the audit line of a saved change holds only the setting words, never a token', { skip }, async () => {
  const list = await call('GET', reposPath, ownerCookie)
  for (const line of list.json.audit) {
    for (const [key, change] of Object.entries<any>(line.detail)) {
      assert.ok(typeof key === 'string' && typeof change.to === 'string')
      assert.ok(!/token|secret|password/i.test(`${key} ${change.from} ${change.to}`))
    }
  }
})

// ── The words under the sync checkbox ────────────────────────────────

test('the status text follows the box: off, on, and on with no login listed', () => {
  assert.equal(syncStatusWords(false, 'alice'), 'Off: no card is made from its issues.')
  assert.equal(syncStatusWords(false, ''), 'Off: no card is made from its issues.')
  assert.equal(syncStatusWords(true, 'alice, bob'), 'On: cards are made from issues by the accepted logins below.')
  assert.equal(syncStatusWords(true, ' , '), 'On, but no login is listed: every issue is ignored until one is added.')
  assert.equal(syncStatusWords(true, ''), 'On, but no login is listed: every issue is ignored until one is added.')
})
