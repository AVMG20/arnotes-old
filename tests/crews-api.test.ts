/* eslint-disable @typescript-eslint/no-explicit-any -- replies are read loosely: each test checks the fields it names */
// The crew API (POST/GET/DELETE /api/crews) and the rules around it, run against a dev
// server. The instance admin signs in with an account given in the environment, mints the
// keys the tests need, and deletes them again. Scratch crews carry the `scratch-` prefix
// and are purged at the end.
//   CREW_TEST_BASE (default http://localhost:3000)
//   CREW_TEST_ADMIN_EMAIL, CREW_TEST_ADMIN_PASSWORD  an instance admin (scratch account)
//   node --env-file-if-exists=.env --import tsx --test --test-force-exit tests/crews-api.test.ts
// Without the admin variables the file is skipped. A request that reads as remote to the
// gate in front of /api/crews gets 404; run it where the request is local.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { deliverableRecipients, sendMail } from '../server/lib/mailer'

const BASE = process.env.CREW_TEST_BASE ?? 'http://localhost:3000'
const ADMIN_EMAIL = process.env.CREW_TEST_ADMIN_EMAIL
const ADMIN_PASSWORD = process.env.CREW_TEST_ADMIN_PASSWORD
const skip = ADMIN_EMAIL && ADMIN_PASSWORD ? false : 'set CREW_TEST_ADMIN_EMAIL and CREW_TEST_ADMIN_PASSWORD to run'

const stamp = Date.now().toString(36)
const slug = `scratch-${stamp}`
const other = `scratch-${stamp}b`
let adminCookie = ''
let adminKey = ''
let scratchTeamId = ''
let boardsKeyId = ''
let boardsKey = ''
let created: any = null
let purged = false

interface Reply { status: number, text: string, json: any, headers: Headers }

async function call(method: string, path: string, key: string | undefined, body?: unknown, cookie?: string): Promise<Reply> {
  const headers: Record<string, string> = { origin: BASE }
  if (key) headers.authorization = `Bearer ${key}`
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
  return { status: res.status, text, json, headers: res.headers }
}

/** Signs in and returns the session cookie header, or null when refused. */
async function signIn(email: string, password: string): Promise<{ status: number, cookie: string }> {
  const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'origin': BASE },
    body: JSON.stringify({ email, password })
  })
  const cookie = res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
  await res.text()
  return { status: res.status, cookie }
}

async function mcp(key: string, name: string, args: Record<string, unknown>) {
  return call('POST', '/api/mcp', key, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
}

function toolJson(reply: Reply): any {
  const text = reply.json?.result?.content?.[0]?.text
  return text ? JSON.parse(text) : null
}

let loginPromise: Promise<void> | null = null

/** Signs the admin in and mints a boards key of its own, once per run. */
function login(): Promise<void> {
  if (!loginPromise) {
    loginPromise = (async () => {
      const admin = await signIn(ADMIN_EMAIL!, ADMIN_PASSWORD!)
      assert.equal(admin.status, 200, 'the admin signs in')
      adminCookie = admin.cookie
      const board = await call('POST', '/api/settings/api-keys', undefined, { name: `scratch ${stamp} boards`, scopes: ['boards:read', 'boards:write'] }, adminCookie)
      boardsKey = board.json.token
      boardsKeyId = board.json.key.id
    })()
  }
  return loginPromise
}

/**
 * Opens the crew API window (BRIEF-crew-feature 2b) and takes its temporary crews:manage
 * key. Calls from this machine read as remote through the dev proxy, so the window is what
 * lets them through. A refused call closes the window, so each test opens it again.
 */
async function ready() {
  await login()
  const opened = await call('POST', '/api/settings/crew-api-window', undefined, undefined, adminCookie)
  assert.equal(opened.status, 200, opened.text.slice(0, 200))
  adminKey = opened.json.token
}

after(async () => {
  if (!adminCookie) return
  if (!purged) {
    await ready().catch(() => {})
    await call('DELETE', `/api/crews/${slug}?purge=1`, adminKey).catch(() => {})
    await call('DELETE', `/api/crews/${other}?purge=1`, adminKey).catch(() => {})
  }
  if (scratchTeamId) await call('POST', '/api/auth/organization/delete', undefined, { organizationId: scratchTeamId }, adminCookie).catch(() => {})
  if (boardsKeyId) await call('DELETE', `/api/settings/api-keys/${boardsKeyId}`, undefined, undefined, adminCookie).catch(() => {})
  await call('DELETE', '/api/settings/crew-api-window', undefined, undefined, adminCookie).catch(() => {})
})

test('a call without a key is refused', { skip }, async () => {
  await ready()
  const reply = await call('POST', '/api/crews', undefined, { slug, name: 'x', product: { name: 'x' } })
  assert.ok([401, 404].includes(reply.status), `got ${reply.status}`)
})

test('a boards key cannot manage crews', { skip }, async () => {
  await ready()
  const reply = await call('POST', '/api/crews', boardsKey, { slug, name: 'x', product: { name: 'x' } })
  assert.ok([401, 403].includes(reply.status), `got ${reply.status}`)
  assert.ok(!reply.text.includes('arn_'), 'no key text in the refusal')
})

test('a member cannot mint a crews:manage key', { skip }, async () => {
  await ready()
  const member = await signIn(`${slug}-w1@crew.invalid`, 'not-the-password')
  assert.notEqual(member.status, 200, 'a wrong password is refused')
})

test('a malformed slug is refused by name', { skip }, async () => {
  await ready()
  const reply = await call('POST', '/api/crews', adminKey, { slug: 'A!', name: 'x', product: { name: 'x' } })
  assert.equal(reply.status, 400)
  assert.match(reply.json.message, /slug/)
})

test('create makes the crew and returns its people once', { skip }, async () => {
  await ready()
  created = await call('POST', '/api/crews', adminKey, { slug, name: 'Scratch crew', product: { name: 'Scratch product' } })
  assert.equal(created.status, 201, created.text.slice(0, 300))
  for (const key of ['boss', 'pm', 'w1', 'w2', 'w3', 'w4', 'pietje', 'nitpicker', 'customer', 'contact']) {
    const person = created.json.people[key]
    assert.ok(person, `person ${key} is in the response`)
    assert.match(person.email, new RegExp(`^${slug}-${key}@crew\\.invalid$`))
    assert.ok(person.password?.length >= 30, `${key} has a password`)
    assert.match(person.apiKey, /^arn_/)
  }
  assert.ok(created.json.crew.boardUrl.endsWith(`/projects/${created.json.crew.boardId}`))
})

test('the same slug again is a 409 with no secrets', { skip }, async () => {
  await ready()
  const reply = await call('POST', '/api/crews', adminKey, { slug, name: 'Scratch crew', product: { name: 'Scratch product' } })
  assert.equal(reply.status, 409)
  assert.ok(!reply.text.includes('"password"'))
  assert.ok(!reply.text.includes('arn_'))
})

test('two creates of one new slug at once end 409, not 500', { skip }, async () => {
  await ready()
  const racing = `${slug}r`
  const body = { slug: racing, name: 'Race', product: { name: 'Race product' } }
  const [a, b] = await Promise.all([call('POST', '/api/crews', adminKey, body), call('POST', '/api/crews', adminKey, body)])
  assert.deepEqual([a.status, b.status].sort(), [201, 409])
  await call('DELETE', `/api/crews/${racing}?purge=1`, adminKey)
})

test('GET returns the crew without secrets', { skip }, async () => {
  await ready()
  const reply = await call('GET', `/api/crews/${slug}`, adminKey)
  assert.equal(reply.status, 200)
  assert.equal(reply.json.people.length, 10)
  assert.ok(!reply.text.includes('"password"'))
  assert.ok(!reply.text.includes('arn_'))
})

test('a crew key cannot manage crews, and a crew member cannot mint one', { skip }, async () => {
  await ready()
  const w1 = created.json.people.w1
  const asKey = await call('GET', `/api/crews/${slug}`, w1.apiKey)
  assert.ok([401, 403, 404].includes(asKey.status), `got ${asKey.status}`)
  const session = await signIn(w1.email, w1.password)
  assert.equal(session.status, 200, 'the crew account signs in')
  const mint = await call('POST', '/api/settings/api-keys', undefined, { name: 'nope', scopes: ['crews:manage'] }, session.cookie)
  assert.equal(mint.status, 403)
})

test('a crew staff key works on the agent API', { skip }, async () => {
  await ready()
  const list = await call('POST', '/api/mcp', created.json.people.w1.apiKey, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
  assert.equal(list.status, 200)
})

test('a crew account joins no other team by code', { skip }, async () => {
  await ready()
  const w2 = created.json.people.w2
  const session = await signIn(w2.email, w2.password)
  const mine = await call('GET', '/api/auth/organization/list', undefined, undefined, session.cookie)
  assert.equal(mine.status, 200)
  // A team of the admin's, with a join code the crew account must not use.
  // A scratch team of the admin's, with a join code the crew account must not use.
  const made = await call('POST', '/api/auth/organization/create', undefined, { name: `Scratch ${stamp} team`, slug: `scratch-${stamp}-team` }, adminCookie)
  assert.equal(made.status, 200, made.text.slice(0, 200))
  scratchTeamId = made.json.id
  const foreign = { id: made.json.id }
  const code = await call('POST', `/api/teams/${foreign.id}/rotate-code`, undefined, undefined, adminCookie)
  const reply = await call('POST', '/api/teams/join', undefined, { code: code.json.joinCode }, session.cookie)
  assert.equal(reply.status, 403, reply.text.slice(0, 200))
  assert.ok(!reply.text.includes(code.json.joinCode), 'the code is not echoed back')
})

test('a crew account accepts no invitation to a team or a customer', { skip }, async () => {
  await ready()
  const w3 = created.json.people.w3
  const session = await signIn(w3.email, w3.password)
  // A customer invitation, made by the admin for the crew's own customer.
  // The crew's own customer is the one the admin invites to; the admin works in the crew team.
  await call('POST', '/api/auth/organization/set-active', undefined, { organizationId: created.json.team.id }, adminCookie)
  const invite = await call('POST', `/api/customers/${created.json.crew.customerId}/invitations`, undefined, { label: 'scratch' }, adminCookie)
  assert.equal(invite.status, 200, invite.text.slice(0, 200))
  const token = String(invite.json.url).split('/invite/')[1]
  const accept = await call('POST', `/api/invitations/${token}/accept`, undefined, undefined, session.cookie)
  assert.equal(accept.status, 403, accept.text.slice(0, 200))
  // A team invitation made by the admin, addressed to the crew account.
  const home = { id: scratchTeamId }
  const teamInvite = await call('POST', '/api/auth/organization/invite-member', undefined, { email: w3.email, role: 'member', organizationId: home.id }, adminCookie)
  if (teamInvite.status === 200) {
    const accepted = await call('POST', '/api/auth/organization/accept-invitation', undefined, { invitationId: teamInvite.json.id }, session.cookie)
    assert.equal(accepted.status, 403, accepted.text.slice(0, 200))
  }
  const started = await call('POST', '/api/auth/organization/create', undefined, { name: 'nope', slug: `nope-${stamp}` }, session.cookie)
  assert.equal(started.status, 403, started.text.slice(0, 200))
})

test('no mail goes to a .invalid address; a real one is still handed on', { skip: false }, async () => {
  assert.deepEqual(deliverableRecipients(`${slug}-w1@crew.invalid`), [])
  assert.deepEqual(deliverableRecipients(`a@example.com, ${slug}-w1@crew.invalid`), ['a@example.com'])
  // Nothing to deliver: no transport is touched, so no error and no log.
  await sendMail({ to: `${slug}-w1@crew.invalid`, subject: 'x', text: 'secret body', html: '<p>secret body</p>' })
})

test('log_time works with a crew key on a task and on a subtask', { skip }, async () => {
  await ready()
  const w1Key = created.json.people.w1.apiKey
  const board = created.json.crew.boardId
  const made = await mcp(w1Key, 'create_task', { board, column: 'To do', title: 'scratch task' })
  assert.equal(made.json?.result?.isError, undefined, made.text.slice(0, 300))
  const task = toolJson(made).task ?? toolJson(made)
  const taskId = task.id
  const sub = await mcp(w1Key, 'create_task', { board, column: 'To do', title: 'scratch subtask', parent: taskId })
  assert.equal(sub.json?.result?.isError, undefined, sub.text.slice(0, 300))
  const subId = (toolJson(sub).task ?? toolJson(sub)).id
  const onTask = await mcp(w1Key, 'log_time', { task: taskId, duration: '30m', note: 'scratch' })
  assert.equal(onTask.json?.result?.isError, undefined, onTask.text.slice(0, 300))
  const onSub = await mcp(w1Key, 'log_time', { task: subId, duration: '15m', note: 'scratch sub' })
  assert.equal(onSub.json?.result?.isError, undefined, onSub.text.slice(0, 300))
})

test('rotate gives new keys and passwords and kills the old ones', { skip }, async () => {
  await ready()
  const old = created.json.people.w1
  const rotated = await call('POST', '/api/crews', adminKey, { slug, name: 'Scratch crew', product: { name: 'Scratch product' }, rotate: true })
  assert.equal(rotated.status, 200, rotated.text.slice(0, 300))
  const fresh = rotated.json.people.w1
  assert.notEqual(fresh.apiKey, old.apiKey)
  assert.equal((await call('POST', '/api/mcp', old.apiKey, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 401)
  assert.equal((await call('POST', '/api/mcp', fresh.apiKey, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 200)
  assert.equal((await signIn(old.email, old.password)).status, 401)
  created = rotated
})

test('disable cuts the crew off at once', { skip }, async () => {
  await ready()
  const reply = await call('DELETE', `/api/crews/${slug}`, adminKey)
  assert.equal(reply.status, 200)
  const view = await call('GET', `/api/crews/${slug}`, adminKey)
  assert.ok(view.json.disabledAt, 'disabledAt is set')
  assert.equal((await call('POST', '/api/mcp', created.json.people.w1.apiKey, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 401)
  assert.notEqual((await signIn(created.json.people.w1.email, created.json.people.w1.password)).status, 200)
})

test('a disabled crew is 409 without rotate and live again with it', { skip }, async () => {
  await ready()
  assert.equal((await call('POST', '/api/crews', adminKey, { slug, name: 'Scratch crew', product: { name: 'Scratch product' } })).status, 409)
  const back = await call('POST', '/api/crews', adminKey, { slug, name: 'Scratch crew', product: { name: 'Scratch product' }, rotate: true })
  assert.equal(back.status, 200)
  created = back
})

test('purge removes the crew; a second purge finds nothing', { skip }, async () => {
  await ready()
  const reply = await call('DELETE', `/api/crews/${slug}?purge=1`, adminKey)
  assert.equal(reply.status, 200)
  purged = true
  assert.equal((await call('GET', `/api/crews/${slug}`, adminKey)).status, 404)
  assert.equal((await signIn(created.json.people.w1.email, created.json.people.w1.password)).status, 401)
})
