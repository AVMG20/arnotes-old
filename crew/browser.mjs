#!/usr/bin/env node
// The crew's shared browser as commands: `crew <who> browser goto|shot|eval|console|tabs|close-tab|done`
// and `crew browser status|shutdown`. The driver (browser-driver.mjs) keeps the one Chromium, the
// contexts and the tabs; this file is the command and the login.
//
// Nothing to start: the first command starts the browser. Each person's context signs in as that
// person, with their own email and password from creds.json, the same sign-in tm.mjs does, then the
// team set-active step. The login is not stored: no cookies, no password on disk. Errors and status
// never print a password, a token, a cookie or page text.
//
// The daemon loads prepare() from this file by its own path (no environment setting can change it).
// This module has no side effects on import: config.mjs is loaded only when a command runs.
// The team step is part of the login on purpose: a crew person who is not on the crew team is a setup
// error, so a failed set-active fails the sign-in and the person gets no browser session.
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BrowserError, parseCli, request } from './browser-driver.mjs'

const USAGE = [
  'usage: crew <who> browser goto URL [--tab T] [--width W] [--height H]',
  '       crew <who> browser shot FILE [--full] [--overwrite] [--tab T] [--width W] [--height H]',
  '       crew <who> browser eval JS [--tab T] [--accept-dialogs]',
  '       crew <who> browser console | tabs | close-tab T | done',
  '       crew browser status | shutdown'
].join('\n')

// The state folder: under the crew's work folder, which is never shipped or committed.
async function stateDir() {
  const { here } = await import('./config.mjs')
  return process.env.CREW_BROWSER_DIR || join(here, 'work', 'browser')
}

async function readCreds() {
  const { here } = await import('./config.mjs')
  try {
    return JSON.parse(readFileSync(join(here, 'creds.json'), 'utf8'))
  } catch {
    throw new BrowserError('no creds.json in the crew folder: the crew has not been provisioned here')
  }
}

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]']

/**
 * The board's address from creds.json, as an origin. https always; plain http only to this machine,
 * because a password must not travel in the clear to another host. The message names the rule only.
 */
export function boardOrigin(base) {
  let url
  try {
    url = new URL(String(base))
  } catch {
    throw new BrowserError('creds.json base is not a URL')
  }
  if (url.protocol === 'https:') return url.origin
  if (url.protocol === 'http:' && LOCAL_HOSTS.includes(url.hostname)) return url.origin
  throw new BrowserError('creds.json base must be https, or http on localhost, 127.0.0.1 or [::1]')
}

/**
 * Reads one Set-Cookie line as the cookie the driver sets. The board's origin is the URL, so Chromium
 * keeps the host and the scheme rules; a Domain attribute is ignored. A __Host- cookie is dropped unless it is
 * Secure, has Path=/ and no Domain: Chromium would drop it silently, so the driver is not asked to set it.
 */
export function parseSetCookie(line, origin, now = Date.now()) {
  const [pair, ...attributes] = String(line).split(';')
  const eq = pair.indexOf('=')
  if (eq <= 0) return null
  const cookie = { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), url: origin, path: '/', httpOnly: false, secure: false, sameSite: 'Lax', expires: -1 }
  let hasDomain = false
  for (const attribute of attributes) {
    const eqAt = attribute.indexOf('=')
    const key = (eqAt < 0 ? attribute : attribute.slice(0, eqAt)).trim().toLowerCase()
    const value = eqAt < 0 ? '' : attribute.slice(eqAt + 1).trim()
    if (key === 'domain') hasDomain = true
    else if (key === 'path' && value.startsWith('/')) cookie.path = value
    else if (key === 'httponly') cookie.httpOnly = true
    else if (key === 'secure') cookie.secure = true
    else if (key === 'samesite') cookie.sameSite = { strict: 'Strict', lax: 'Lax', none: 'None' }[value.toLowerCase()] ?? cookie.sameSite
    else if (key === 'max-age' && Number.isFinite(Number(value))) cookie.expires = now / 1000 + Number(value)
    else if (key === 'expires' && cookie.expires === -1 && !Number.isNaN(Date.parse(value))) cookie.expires = Date.parse(value) / 1000
  }
  if (!cookie.name) return null
  if (cookie.name.startsWith('__Host-') && (!cookie.secure || cookie.path !== '/' || hasDomain)) return null
  return cookie
}

/** Adds the cookies of one answer to the jar, by name: a later cookie with the same name replaces it. */
function addCookies(jar, lines, origin) {
  for (const line of lines) {
    const cookie = parseSetCookie(line, origin)
    if (cookie) jar.set(cookie.name, cookie)
  }
  return jar
}

const CALL_MS = 30000

/**
 * One POST from Node to the board. A redirect is refused, not followed. Only the status and the
 * Set-Cookie lines come back: the body is never read, logged or kept. Network errors name their code only.
 */
async function post(origin, path, payload, jar) {
  const headers = { 'content-type': 'application/json', origin }
  if (jar.size) headers.cookie = [...jar.values()].map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
  let response
  try {
    response = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      redirect: 'manual',
      signal: AbortSignal.timeout(CALL_MS)
    })
  } catch (e) {
    throw new BrowserError(`could not reach the board (${e.cause?.code ?? e.name})`)
  }
  await response.body?.cancel().catch(() => {})
  if (response.status >= 300 && response.status < 400) {
    throw new BrowserError(`the board answered with a redirect (HTTP ${response.status}), so the sign-in was refused`)
  }
  return { status: response.status, setCookie: response.headers.getSetCookie() }
}

/**
 * Signs `who` in from Node, as tm.mjs does, then the team set-active step, and hands the board's
 * session cookies to `session.setCookies`, which sets them on that person's context only. No page runs
 * the request, so a script on the page cannot see the password. Nothing is printed but the status.
 */
export async function signIn(who, session, creds) {
  const me = creds.people?.[who]
  if (!me?.email || !me?.password) throw new BrowserError(`${who} has no login in creds.json`)
  const origin = boardOrigin(creds.base)
  const signed = await post(origin, '/api/auth/sign-in/email', { email: me.email, password: me.password }, new Map())
  if (signed.status !== 200) throw new BrowserError(`could not sign in as ${who} (HTTP ${signed.status})`)
  const jar = addCookies(new Map(), signed.setCookie, origin)
  const team = typeof creds.team?.id === 'string' ? creds.team.id : ''
  if (team) {
    const active = await post(origin, '/api/auth/organization/set-active', { organizationId: team }, jar)
    if (active.status !== 200) throw new BrowserError(`could not set the team for ${who} (HTTP ${active.status})`)
    addCookies(jar, active.setCookie, origin)
  }
  if (jar.size === 0) throw new BrowserError(`could not sign in as ${who}: the board sent no session`)
  await session.setCookies([...jar.values()])
}

/** The driver runs this once per new context, before the person's first command. */
export async function prepare(who, _call, session) {
  return signIn(who, session, await readCreds())
}
/** Runs one browser command from the arguments after `browser`. Prints the result, or the note. */
export async function main(argv) {
  const parsed = parseCli(argv)
  if (parsed.help) {
    console.log(USAGE)
    return
  }
  const { config } = await import('./config.mjs')
  const start = parsed.cmd !== 'status' && parsed.cmd !== 'shutdown'
  const reply = await request({
    dir: await stateDir(),
    who: parsed.who,
    cmd: parsed.cmd,
    args: parsed.args,
    start,
    chromium: config.chromium || ''
  })
  if (reply === null) {
    console.log(parsed.cmd === 'status' ? '[]' : 'not running')
    return
  }
  if (reply.note) console.error(`note: ${reply.note}`)
  console.log(typeof reply.result === 'string' ? reply.result : JSON.stringify(reply.result, null, 1))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(String(e.message).replace(/^BrowserError: /, ''))
    process.exitCode = 1
  })
}
