#!/usr/bin/env node
// The crew's one tool. Each person has their own login, their own API key and their
// own browser profile (profiles/<who>) that keeps its session between calls.
//
//   node tm.mjs <who> mcp <tool> ['<json args>']   call a board agent tool ('@file.json' reads long JSON from a file)
//   node tm.mjs <who> tools                        list the agent tool names
//   node tm.mjs <who> shot <path-or-url> <out.png> screenshot a page, logged in as you
//   node tm.mjs <who> attach <taskId> <image>      upload a png/jpg to a task; prints the url
//   node tm.mjs <who> api  <METHOD> <path> ['<json>']  call the board app's API with your session; prints "<status> <body>"
//   node tm.mjs <who> apij <METHOD> <path> ['<json>']  the same, but the body only (for JSON.parse); status is the exit code
//   node tm.mjs <who> run <script.mjs>             run your Playwright script in your profile;
//                                                  it default-exports async ({ page, ctx, BASE, APP }) => {}
//                                                  BASE = the board app, APP = the product under test
//
// <who> is a key from creds.json: boss pm w1 w2 w3 w4 pietje customer contact. Use your own.
import { chromium } from 'playwright'
import { readFileSync, mkdirSync, existsSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { config, here, loadCreds } from './config.mjs'

const creds = loadCreds()
const BASE = creds.base
const APP = config.product.appUrl
// A long body pasted into a shell argument loses quotes. `@path` reads the JSON from a file instead.
const parseJson = arg => JSON.parse(arg.startsWith('@') ? readFileSync(arg.slice(1), 'utf8') : arg)
const [who, command, ...rest] = process.argv.slice(2)
const me = creds.people[who]
if (!me || !command) {
  console.error(`usage: node tm.mjs <${Object.keys(creds.people).join('|')}> <mcp|tools|shot|attach|api|apij|run> ...`)
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
