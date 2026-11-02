#!/usr/bin/env node
// The crew's one tool. Each person has their own login, their own API key and their
// own browser profile (profiles/<who>) that keeps its session between calls.
//
//   node tm.mjs <who> mcp <tool> ['<json args>']   call a board agent tool ('@file.json' reads long JSON from a file)
//   node tm.mjs <who> tools                        list the agent tool names
//   node tm.mjs <who> shot <path-or-url> <out.png> screenshot a page, logged in as you
//   node tm.mjs <who> attach <taskId> <image>      upload a png/jpg to a task; prints the url
//   node tm.mjs <who> update <taskId> <body.md|-> [--internal|--customer]   post an update from a Markdown file (or stdin)
//   node tm.mjs <who> api  <METHOD> <path> ['<json>']  call the board app's API with your session; prints "<status> <body>"
//   node tm.mjs <who> apij <METHOD> <path> ['<json>']  the same, but the body only (for JSON.parse); status is the exit code
//   node tm.mjs <who> run <script.mjs>             run your Playwright script in your profile;
//                                                  it default-exports async ({ page, ctx, BASE, APP }) => {}
//                                                  BASE = the board app, APP = the product under test
//
// <who> is a key from creds.json: boss pm w1 w2 w3 w4 pietje customer contact. Use your own.
import { chromium } from 'playwright'
import { readFileSync, mkdirSync, existsSync, lstatSync, openSync, fstatSync, readSync, closeSync, constants } from 'node:fs'
import { isatty } from 'node:tty'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { config, here, loadCreds } from './config.mjs'

const creds = loadCreds()
const BASE = creds.base
const APP = config.product.appUrl
// A long body pasted into a shell argument loses quotes. `@path` reads the JSON from a file instead.
const parseJson = arg => JSON.parse(arg.startsWith('@') ? readFileSync(arg.slice(1), 'utf8') : arg)
// An update's body comes from a file (or stdin for `-`), so no JSON escaping. The limit keeps a runaway log out of a thread.
const UPDATE_LIMIT = 200 * 1024
function refuse(message, code) {
  console.error(message)
  process.exit(code)
}
const [who, command, ...rest] = process.argv.slice(2)
const me = creds.people[who]
if (!me || !command) {
  console.error(`usage: node tm.mjs <${Object.keys(creds.people).join('|')}> <mcp|tools|update|shot|attach|api|apij|run> ...`)
  process.exit(64)
}

async function mcp(method, params) {
  const res = await fetch(`${BASE}/api/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', 'authorization': `Bearer ${me.apiKey}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params })
  })
  return res.json()
}

if (command === 'tools') {
  const body = await mcp('tools/list', {})
  for (const tool of body.result?.tools ?? []) console.log(`${tool.name}: ${tool.description.split('. ')[0]}`)
  process.exit(0)
}

if (command === 'mcp') {
  const [tool, json] = rest
  const body = await mcp('tools/call', { name: tool, arguments: json ? parseJson(json) : {} })
  if (body.error) {
    console.error('ERROR', JSON.stringify(body.error))
    process.exit(1)
  }
  console.log(body.result?.content?.[0]?.text ?? '')
  process.exit(body.result?.isError ? 1 : 0)
}

// Post an update from a Markdown file: `update <taskId> <body.md|-> [--internal|--customer]`. Staff updates are
// internal unless --customer says otherwise; a customer contact's update is customer-visible whatever the flag says,
// because the server decides. Runs before the browser starts, so a refusal costs nothing.
if (command === 'update') {
  const isFlag = arg => arg.startsWith('-') && arg !== '-'
  const flags = rest.filter(isFlag)
  const positional = rest.filter(arg => !isFlag(arg))
  const known = ['--internal', '--customer']
  if (flags.some(flag => !known.includes(flag)) || flags.length > 1 || positional.length !== 2) {
    refuse(`usage: crew <who> update <taskId> <body.md | -> [--internal | --customer]\nnot understood: ${rest.join(' ')}`, 64)
  }
  const [taskId, file] = positional
  const visibility = flags[0] === '--customer' ? 'customer' : 'internal'
  const body = decodeBody(file === '-' ? readStdin() : readRegularFile(file))
  if (!body.trim()) refuse('the update is empty: nothing to post', 65)

  let answer
  try {
    const response = await fetch(`${BASE}/api/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', 'authorization': `Bearer ${me.apiKey}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name: 'post_task_update', arguments: { id: taskId, body, visibility } } })
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    answer = await response.json()
  } catch (error) {
    // Only the status or the kind of failure is shown: never the URL, the key or a stack.
    const why = error.message.startsWith('HTTP') ? `answered ${error.message}` : error instanceof SyntaxError ? 'sent a reply that is not JSON' : 'is unreachable'
    refuse(`the board ${why}: try again`, 69)
  }
  if (answer.error) refuse(`the board refused the update: ${answer.error.message ?? 'unknown error'}`, 1)
  const text = answer.result?.content?.[0]?.text ?? ''
  if (answer.result?.isError) refuse(`the board refused the update: ${text}`, 1)
  let shown
  try {
    shown = JSON.parse(text).update?.visibility
  } catch {
    shown = undefined
  }
  console.log(`posted as ${shown ?? 'unknown (the board did not say which)'}`)
  process.exit(0)
}
// Reads a regular file in chunks, refusing a symlink, a FIFO, a device or a directory before it opens anything.
function readRegularFile(file) {
  let link
  try {
    link = lstatSync(file)
  } catch (error) {
    refuse(`cannot read ${file}: ${error.code === 'ENOENT' ? 'no such file' : (error.code ?? 'unreadable')}`, 66)
  }
  if (link.isSymbolicLink()) refuse(`${file}: refusing to follow a symlink`, 66)
  if (!link.isFile()) refuse(`${file} is not a regular file (a directory, FIFO or device): give a file`, 66)
  let fd
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    refuse(`cannot read ${file}: ${error.code ?? 'unreadable'}`, 66)
  }
  try {
    if (!fstatSync(fd).isFile()) refuse(`${file} is not a regular file: give a file`, 66)
    return readChunks(fd)
  } finally {
    closeSync(fd)
  }
}
// Stdin for `-`. A terminal is refused, so the command never waits on a keyboard.
function readStdin() {
  if (isatty(0)) refuse('give the text on stdin, e.g. with a pipe, or name a file', 64)
  return readChunks(0)
}
// Stops at the limit, so a huge input (a FIFO, /dev/zero, a log) never grows memory past 200 KB.
function readChunks(fd) {
  const chunks = []
  const chunk = Buffer.alloc(64 * 1024)
  let total = 0
  for (;;) {
    let count
    try {
      count = readSync(fd, chunk, 0, chunk.length, null)
    } catch (error) {
      if (error.code === 'EAGAIN') {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
        continue
      }
      refuse(`cannot read the body: ${error.code ?? 'read failed'}`, 66)
    }
    if (count === 0) break
    total += count
    if (total > UPDATE_LIMIT) refuse('the update is over 200 KB: split it into several updates, or attach the file', 65)
    chunks.push(Buffer.from(chunk.subarray(0, count)))
  }
  return Buffer.concat(chunks, total)
}
// Strict UTF-8, no NUL bytes; a leading byte-order mark is dropped, and CRLF line endings are kept as they are.
function decodeBody(bytes) {
  if (bytes.includes(0)) refuse('the update contains NUL bytes: it is not text', 65)
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    refuse('the update is not valid UTF-8 text', 65)
  }
  return text.startsWith('﻿') ? text.slice(1) : text
}
// An image is read before the browser starts, so a missing file is a plain error.
if (command === 'attach' && !existsSync(rest[1] ?? '')) refuse(`no such image: ${rest[1] ?? '(none given)'}`, 66)

// Everything below drives a browser that is yours alone.
const profile = `${here}profiles/${who}`
mkdirSync(profile, { recursive: true })
const fonts = `${here}fonts.conf`
const ctx = await chromium.launchPersistentContext(profile, {
  ...(config.chromium || process.env.CHROMIUM ? { executablePath: config.chromium || process.env.CHROMIUM } : {}),
  headless: true,
  // On a machine without system fonts Chromium exits on some pages; init.mjs writes fonts.conf when "fontDir" is set.
  env: { ...process.env, ...(existsSync(fonts) ? { FONTCONFIG_FILE: fonts } : {}) },
  viewport: { width: 1440, height: 900 },
  args: ['--disable-gpu', '--disable-dev-shm-usage', ...(process.env.CREW_CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])]
})
const h = { origin: BASE }
let code = 0
try {
  const session = await (await ctx.request.get(`${BASE}/api/auth/get-session`)).json().catch(() => null)
  if (!session?.user) {
    const res = await ctx.request.post(`${BASE}/api/auth/sign-in/email`, { data: { email: me.email, password: me.password }, headers: h })
    if (res.status() !== 200) throw new Error(`could not sign in: ${res.status()}`)
    // Work in the crew's team, not a personal space.
    await ctx.request.post(`${BASE}/api/auth/organization/set-active`, { data: { organizationId: creds.team.id }, headers: h })
  }

  const url = path => path.startsWith('http') ? path : `${BASE}${path.startsWith('/') ? '' : '/'}${path}`

  if (command === 'shot') {
    const [path, out] = rest
    // A dev server reloads the page whenever someone saves a file, so a picture taken straight
    // after load is often of a blank page. Wait for real content and retry (up to 4 tries).
    const page = await ctx.newPage()
    let size = 0
    for (let attempt = 1; attempt <= 4 && size < 15000; attempt++) {
      await page.goto(url(path), { waitUntil: 'domcontentloaded' }).catch(() => {})
      await page.waitForFunction(() => document.body.innerText.trim().length > 200, null, { timeout: 30000 }).catch(() => {})
      await page.waitForTimeout(2500)
      if (await page.evaluate(() => document.body.innerText.trim().length).catch(() => 0) < 200) continue
      await page.screenshot({ path: resolve(out), fullPage: false })
      size = readFileSync(resolve(out)).length
    }
    if (size < 15000) {
      console.error('the page stayed blank (a dev reload loop, or the page is empty): try again in a minute')
      code = 1
    } else {
      console.log(`saved ${resolve(out)} (${size} bytes)`)
    }
  } else if (command === 'attach') {
    const [taskId, file] = rest
    const res = await ctx.request.post(`${BASE}/api/tasks/${taskId}/attachments`, {
      headers: h,
      multipart: { file: { name: basename(file), mimeType: file.endsWith('.jpg') || file.endsWith('.jpeg') ? 'image/jpeg' : 'image/png', buffer: readFileSync(file) } }
    })
    console.log(res.status(), await res.text())
    code = res.status() < 400 ? 0 : 1
  } else if (command === 'api' || command === 'apij') {
    const [method, path, json] = rest
    const res = await ctx.request.fetch(url(path), { method, data: json ? parseJson(json) : undefined, headers: h })
    const text = (await res.text()).slice(0, 200000)
    if (command === 'apij') console.log(text)
    else console.log(res.status(), text.slice(0, 8000))
    code = res.status() < 400 ? 0 : 1
  } else if (command === 'run') {
    const mod = await import(pathToFileURL(resolve(rest[0])).href)
    const page = ctx.pages()[0] ?? await ctx.newPage()
    await mod.default({ page, ctx, BASE, APP, h })
  } else {
    console.error(`unknown command ${command}`)
    code = 64
  }
} catch (error) {
  console.error('ERROR', error.message)
  code = 1
} finally {
  await ctx.close()
}
process.exit(code)
