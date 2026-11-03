// Tests for the crew kit: the shipped file list, and the `crew <who> browser` command end to end.
// Run from the repo root: node --test crew/kit.test.mjs
//
// The list tests need nothing. The command tests start the driver and a real Chromium when one is
// found (CREW_BROWSER_CHROMIUM, CHROMIUM, or chromium in crew.json); otherwise they skip and say why.
// They use a throwaway CREW_HOME with its own crew.json and creds.json, a fake board on 127.0.0.1
// (sign-in, the team step, one page) and a scratch state folder. They never touch the real crew folder.
//
// Not shipped, so kit-files.txt must not list them: tests (*.test.mjs), dotfiles, kit-files.txt itself,
// and anything that holds a login or a run (creds.json, crew.json, crew.config.json, logs, profiles).

import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { findChromium, request, serve } from './browser-driver.mjs'
import { boardOrigin, signIn } from './browser.mjs'

const KIT = dirname(fileURLToPath(import.meta.url))
const CREW = join(KIT, 'crew.mjs')
const DRIVER = join(KIT, 'browser-driver.mjs')
const NOT_SHIPPED = /\.test\.mjs$|^\.|^kit-files\.txt$/
const SECRET_OR_RUN = /^(creds|crew|crew\.config)\.json$|\.log$/

describe('the kit file list', () => {
  const listed = readFileSync(join(KIT, 'kit-files.txt'), 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))

  test('every listed file exists, once, and the list is sorted', () => {
    assert.deepEqual(listed, [...new Set(listed)], 'no duplicates')
    assert.deepEqual(listed, [...listed].sort(), 'keep it sorted')
    for (const name of listed) assert.ok(existsSync(join(KIT, name)), `${name} is listed but missing`)
  })

  test('no excluded file is listed: tests, dotfiles, the list itself, logins and runs', () => {
    for (const name of listed) {
      assert.ok(!NOT_SHIPPED.test(name), `${name} must not ship`)
      assert.ok(!SECRET_OR_RUN.test(name), `${name} must not ship`)
    }
  })

  test('every shipped-shape file in the kit folder is listed', () => {
    const shape = /\.(mjs|md|tmpl|json|sh)$|^fonts\.conf/
    const present = readdirSync(KIT).filter((name) => {
      const path = join(KIT, name)
      return statSync(path).isFile() && shape.test(name) && !NOT_SHIPPED.test(name) && !SECRET_OR_RUN.test(name)
    })
    assert.deepEqual(present.filter(name => !listed.includes(name)), [], 'add these to kit-files.txt, or name why they do not ship')
  })
})

// ---------- the command, against a fake board and a real Chromium ----------

const CHROMIUM = findChromium()
const SKIP = CHROMIUM ? false : 'no Chromium found (set CREW_BROWSER_CHROMIUM or CHROMIUM, or chromium in crew.json)'
if (SKIP) console.log(`# command tests skipped: ${SKIP}`)

const SCRATCH = resolve(process.env.CREW_BROWSER_TEST_TMP || tmpdir())
const made = []
const PASSWORDS = { w1: `pw-${randomBytes(6).toString('hex')}`, w2: `pw-${randomBytes(6).toString('hex')}` }
const WRONG = `wrong-${randomBytes(6).toString('hex')}`
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitUntil(check, ms, what) {
  const until = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await sleep(200)
  }
}

// A fake board: sign-in checks the password, sets a session cookie, and serves one page.
function startBoard() {
  const sessions = new Set()
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://board.test')
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      if (url.pathname === '/api/auth/get-session') {
        res.setHeader('content-type', 'application/json')
        return res.end('null')
      }
      if (url.pathname === '/api/auth/sign-in/email' && req.method === 'POST') {
        server.signIns = (server.signIns ?? 0) + 1
        const { email, password } = JSON.parse(raw || '{}')
        const who = Object.keys(PASSWORDS).find(name => email === `${name}@crew.test`)
        if (!who || password !== PASSWORDS[who]) {
          res.statusCode = 401
          return res.end('{}')
        }
        const sid = randomBytes(12).toString('hex')
        sessions.add(sid)
        res.setHeader('set-cookie', `sid=${sid}; Path=/; SameSite=Lax`)
        res.setHeader('content-type', 'application/json')
        return res.end('{"ok":true}')
      }
      if (url.pathname === '/api/auth/organization/set-active') return res.end('{}')
      if (url.pathname === '/check') {
        // The board's own check: the title says whether this request carries a session it issued.
        const sid = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]
        res.setHeader('content-type', 'text/html')
        return res.end(`<!doctype html><title>${sessions.has(sid) ? 'session' : 'no session'}</title><p>check</p>`)
      }
      if (url.pathname === '/page') {
        res.setHeader('content-type', 'text/html')
        return res.end('<!doctype html><title>Kit page</title><p>hello from the fake board</p>')
      }
      res.statusCode = 404
      res.end('')
    })
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)))
}

/** Runs `crew ...` with this test's home and state folder. Resolves { code, stdout, stderr }. */
function crew(env, args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CREW, ...args], { env, timeout: 150000 }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code ?? 1 : 0, stdout: stdout.trim(), stderr: stderr.trim() })
    })
  })
}

describe('crew <who> browser, end to end (real Chromium, fake board)', { skip: SKIP }, () => {
  let board
  let base
  let home
  let env
  let dir

  test('setup: a fake board, a crew folder with a login for w1 and w2 and a wrong one for w3', async () => {
    board = await startBoard()
    base = `http://127.0.0.1:${board.address().port}`
    home = mkdtempSync(join(SCRATCH, 'kit-'))
    made.push(home)
    dir = join(home, 'work', 'browser')
    mkdirSync(join(home, 'work'), { recursive: true })
    writeFileSync(join(home, 'crew.json'), JSON.stringify({ team: 'Test Crew', chromium: CHROMIUM }))
    writeFileSync(join(home, 'creds.json'), JSON.stringify({
      base,
      team: { id: 'team-1' },
      people: {
        w1: { email: 'w1@crew.test', password: PASSWORDS.w1, apiKey: 'not-used-here' },
        w2: { email: 'w2@crew.test', password: PASSWORDS.w2, apiKey: 'not-used-here' },
        w3: { email: 'w3@crew.test', password: WRONG, apiKey: 'not-used-here' }
      }
    }))
    env = { ...process.env, CREW_HOME: home, CREW_BROWSER_DIR: dir, CREW_BROWSER_CHROMIUM: CHROMIUM }
    delete env.CREW_BROWSER_SHOT_DIRS
    if (process.env.CREW_CHROMIUM_NO_SANDBOX === '1') env.CREW_CHROMIUM_NO_SANDBOX = '1'
  })

  test('the first command starts the browser, logs the person in, and prints the page', async () => {
    const out = await crew(env, ['w1', 'browser', 'goto', `${base}/page`])
    assert.equal(out.code, 0, out.stderr)
    assert.equal(out.stdout, `${base}/page - Kit page`)
    const check = await crew(env, ['w1', 'browser', 'goto', `${base}/check`])
    assert.equal(check.code, 0, check.stderr)
    const title = await crew(env, ['w1', 'browser', 'eval', 'document.title'])
    assert.equal(title.stdout, 'session', 'w1 is signed in, as the board sees it')
    assert.equal(check.stdout, `${base}/check - session`)
    const tabs = await crew(env, ['w1', 'browser', 'tabs'])
    assert.equal(JSON.parse(tabs.stdout).includes('main'), true)
  })

  test('another person on the same origin has a login of their own', async () => {
    const w1 = await crew(env, ['w1', 'browser', 'eval', 'document.title'])
    const w2 = await crew(env, ['w2', 'browser', 'goto', `${base}/check`])
    assert.equal(w2.code, 0, w2.stderr)
    const w2title = await crew(env, ['w2', 'browser', 'eval', 'document.title'])
    assert.equal(w2title.stdout, 'session', 'w2 is signed in, as the board sees it')
    assert.equal(w1.stdout, 'session', 'w1 keeps her own login')
  })

  test('a failed sign-in is one line, and no password appears in it', async () => {
    const out = await crew(env, ['w3', 'browser', 'goto', `${base}/page`])
    assert.equal(out.code, 1)
    assert.equal(out.stderr, 'could not sign in as w3 (HTTP 401)')
    assert.ok(!out.stderr.includes(WRONG) && !out.stdout.includes(WRONG))
  })

  test('a person with no login in creds.json is refused in plain words', async () => {
    const out = await crew(env, ['w9', 'browser', 'goto', `${base}/page`])
    assert.equal(out.code, 1)
    assert.equal(out.stderr, 'w9 has no login in creds.json')
  })

  test('status shows people, tabs and idle seconds, and never a cookie', async () => {
    const out = await crew(env, ['browser', 'status'])
    assert.equal(out.code, 0, out.stderr)
    const people = JSON.parse(out.stdout)
    const w1 = people.find(person => person.who === 'w1')
    assert.ok(w1, 'w1 is listed')
    assert.ok(w1.tabs.includes('main'))
    assert.equal(typeof w1.idle_seconds, 'number')
    assert.ok(!out.stdout.includes('sid='), 'no cookie in status')
    assert.ok(!out.stdout.includes(PASSWORDS.w1), 'no password in status')
  })

  test('shot writes a PNG under the work folder, and refuses a file outside it', async () => {
    const inside = join(home, 'work', 'kit-check.png')
    const out = await crew(env, ['w1', 'browser', 'shot', inside])
    assert.equal(out.code, 0, out.stderr)
    const head = readFileSync(inside).subarray(0, 8)
    assert.deepEqual([...head], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const outside = await crew(env, ['w1', 'browser', 'shot', join(home, '..', 'elsewhere.png')])
    assert.equal(outside.code, 1)
    assert.match(outside.stderr, /outside the allowed folders/)
  })

  test('after a browser crash the next command starts a new browser, logs the person in again, and says so', async () => {
    const log = readFileSync(join(dir, 'pool.log'), 'utf8')
    const pids = [...log.matchAll(/chromium pid (\d+)/g)].map(match => Number(match[1]))
    const pid = pids[pids.length - 1]
    assert.ok(pid, 'the driver logged its Chromium pid')
    process.kill(pid, 'SIGKILL')
    const until = Date.now() + 20000
    while (!readFileSync(join(dir, 'pool.log'), 'utf8').includes('browser stopped')) {
      if (Date.now() > until) assert.fail('the driver noticed the crash')
      await sleep(200)
    }
    const out = await crew(env, ['w1', 'browser', 'goto', `${base}/check`])
    assert.equal(out.code, 0, out.stderr)
    assert.equal(out.stdout, `${base}/check - session`, 'signed in again')
    assert.match(out.stderr, /note: the shared browser stopped and was started again/)
    assert.match(out.stderr, /login was set up again/)
  })

  test('done forgets the person, and shutdown stops the browser for everyone', async () => {
    const done = await crew(env, ['w2', 'browser', 'done'])
    assert.equal(done.stdout, 'done')
    const down = await crew(env, ['browser', 'shutdown'])
    assert.equal(down.code, 0, down.stderr)
    const until = Date.now() + 20000
    for (;;) {
      const status = await crew(env, ['browser', 'status'])
      if (status.stdout === '[]') break // nothing running: nobody listed
      if (Date.now() > until) assert.fail('the browser did not stop')
      await sleep(300)
    }
  })

  after(async () => {
    if (env) await crew(env, ['browser', 'shutdown']).catch(() => {})
    if (board) await new Promise(resolve => board.close(resolve))
  })
})

describe('the board address and where a password may go', () => {
  test('https is accepted; plain http only to this machine', () => {
    assert.equal(boardOrigin('https://board.example.com/'), 'https://board.example.com')
    assert.equal(boardOrigin('http://localhost:3000'), 'http://localhost:3000')
    assert.equal(boardOrigin('http://127.0.0.1:3000/'), 'http://127.0.0.1:3000')
    assert.equal(boardOrigin('http://[::1]:3000'), 'http://[::1]:3000')
    assert.throws(() => boardOrigin('http://board.example.com'), /must be https, or http on localhost, 127\.0\.0\.1 or \[::1\]$/)
    assert.throws(() => boardOrigin('ftp://localhost'), /must be https/)
    assert.throws(() => boardOrigin('not a url'), /not a URL/)
  })

  test('a CREW_BROWSER_PREPARE value in the environment is ignored: its module is never loaded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-env-'))
    made.push(dir)
    const marker = join(dir, 'imported')
    const module = join(dir, 'seam.mjs')
    writeFileSync(module, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'loaded')\nexport const prepare = async () => {}\n`)
    spawnSync(process.execPath, [DRIVER, '_daemon'], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        CREW_HOME: dir,
        CREW_BROWSER_DIR: dir,
        CREW_BROWSER_CHROMIUM: join(dir, 'no-such-chromium'),
        CREW_BROWSER_PREPARE: module
      },
      timeout: 30000
    })
    assert.equal(existsSync(marker), false, 'the environment cannot point the daemon at another seam')
  })
})

describe('a password goes only to the board', { skip: SKIP }, () => {
  test('the password goes only to the board, whatever page is open: the other site sees none', async () => {
    const board = await startBoard()
    const other = await startBoard()
    const dir = mkdtempSync(join(SCRATCH, 'kit-origin-'))
    made.push(dir)
    const boardBase = `http://127.0.0.1:${board.address().port}`
    const otherBase = `http://127.0.0.1:${other.address().port}`
    const creds = { base: boardBase, team: { id: 'team-1' }, people: { w1: { email: 'w1@crew.test', password: PASSWORDS.w1 } } }
    const running = serve({
      dir,
      chromium: CHROMIUM,
      signals: false,
      prepare: async (who, call, session) => {
        // The page is on another site when the sign-in runs: the password still goes only to the board.
        await call('goto', { url: `${otherBase}/page` })
        await signIn(who, session, creds)
      }
    })
    try {
      await waitUntil(async () => (await request({ dir, cmd: 'status', start: false, seam: false })) !== null, 20000, 'the in-process driver')
      const went = await request({ dir, who: 'w1', cmd: 'goto', args: { url: `${boardBase}/page` }, start: false, seam: false })
      assert.equal(went.result, `${boardBase}/page - Kit page`)
      assert.equal(board.signIns, 1, 'the board saw the one sign-in')
      assert.equal(other.signIns ?? 0, 0, 'the other site saw no sign-in')
    } finally {
      await request({ dir, cmd: 'shutdown', start: false, seam: false }).catch(() => null)
      await running.catch(() => {})
      await new Promise(resolve => board.close(resolve))
      await new Promise(resolve => other.close(resolve))
    }
  })
})

after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})
