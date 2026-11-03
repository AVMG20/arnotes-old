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
 * Signs `who` in on the page the driver is showing, as tm.mjs does. The sign-in is sent only while the
 * page is on the board's origin: the page is checked in the same script that sends the password, and
 * the request does not follow a redirect. Nothing is printed but the status.
 */
export async function signIn(who, call, creds) {
  const me = creds.people?.[who]
  if (!me?.email || !me?.password) throw new BrowserError(`${who} has no login in creds.json`)
  const origin = boardOrigin(creds.base)
  await call('goto', { url: `${origin}/api/auth/get-session` })
  const body = JSON.stringify({ email: me.email, password: me.password })
  const team = typeof creds.team?.id === 'string' ? creds.team.id : ''
  const script = `(async () => {
    if (location.origin !== ${JSON.stringify(origin)}) return 'off the board'
    const headers = { 'content-type': 'application/json' }
    const signIn = await fetch(${JSON.stringify(`${origin}/api/auth/sign-in/email`)}, { method: 'POST', headers, body: ${JSON.stringify(body)}, redirect: 'error' })
    if (signIn.status !== 200) return 'refused ' + signIn.status
    if (${JSON.stringify(team)}) {
      await fetch(${JSON.stringify(`${origin}/api/auth/organization/set-active`)}, { method: 'POST', headers, body: JSON.stringify({ organizationId: ${JSON.stringify(team)} }), redirect: 'error' })
    }
    return 'ok'
  })()`
  const answer = await call('eval', { js: script })
  if (answer === 'ok') return
  if (answer === 'off the board') {
    throw new BrowserError(`could not sign in as ${who}: the page is not on the board, so nothing was sent`)
  }
  const code = typeof answer === 'string' ? answer.replace(/^refused /, '') : ''
  throw new BrowserError(`could not sign in as ${who}${code ? ` (HTTP ${code})` : ''}`)
}

/** The driver runs this once per new context, before the person's first command. */
export async function prepare(who, call) {
  return signIn(who, call, await readCreds())
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
