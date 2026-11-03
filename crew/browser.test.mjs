// Tests for the crew's sign-in (browser.mjs): the board's origin rule, the Set-Cookie reader, and,
// with Chromium, that the password stays out of the page and the cookies stay in one person's context.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, test } from 'node:test'
import { BrowserError, findChromium, request, serve } from './browser-driver.mjs'
import { boardOrigin, parseSetCookie, signIn } from './browser.mjs'

const CHROMIUM = findChromium()
const SKIP = CHROMIUM ? false : 'no Chromium found (set CREW_BROWSER_CHROMIUM or CHROMIUM, or chromium in crew.json)'
const SCRATCH = resolve(process.env.CREW_BROWSER_TEST_TMP || tmpdir())

const SECRET = 'pw-w1-secret'
const SESSION = 'tok-w1'
const made = []

function freshDir() {
  mkdirSync(SCRATCH, { recursive: true })
  const dir = mkdtempSync(join(SCRATCH, 'bsi-'))
  made.push(dir)
  return dir
}

async function waitUntil(check, ms, what) {
  const until = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}

// The page is a hostile one: it replaces fetch and XHR before anything else runs, and records every
// body it is asked to send. The sign-in must not show up in that record.
const HOSTILE = `<!doctype html><meta name="viewport" content="width=device-width"><title>hostile</title><script>
window.__seen = []
const realFetch = window.fetch
window.fetch = function (...args) { window.__seen.push(JSON.stringify(args)); return realFetch.apply(this, args) }
const realSend = XMLHttpRequest.prototype.send
XMLHttpRequest.prototype.send = function (body) { window.__seen.push(String(body)); return realSend.call(this, body) }
</script>`

// A stand-in for the board: sign-in, set-active and one page that reports whether the session arrived.
function startBoard() {
  const seen = { signIn: [], setActive: [] }
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      const cookie = req.headers.cookie ?? ''
      if (req.method === 'POST' && req.url === '/api/auth/sign-in/email') {
        const { email, password } = JSON.parse(body || '{}')
        seen.signIn.push({ origin: req.headers.origin, email })
        if (password === 'pw-redirect') {
          res.writeHead(302, { Location: '/check' })
          return res.end()
        }
        if (email === 'w1@x.test' && password === SECRET) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `better-auth.session_token=${SESSION}; Path=/; HttpOnly; SameSite=Lax` })
          return res.end('{"redirect":false}')
        }
        res.writeHead(401, { 'Content-Type': 'application/json' })
        return res.end('{"message":"Invalid email or password"}')
      }
      if (req.method === 'POST' && req.url === '/api/auth/organization/set-active') {
        seen.setActive.push(cookie)
        res.writeHead(cookie.includes(SESSION) ? 200 : 401, { 'Content-Type': 'application/json' })
        return res.end('{}')
      }
      if (req.url === '/hostile') {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        return res.end(HOSTILE)
      }
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(`<meta name="viewport" content="width=device-width"><title>${cookie.includes(SESSION) ? 'session' : 'no session'}</title><p>check</p>`)
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        seen,
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => {
          server.closeAllConnections()
          return new Promise(done => server.close(done))
        }
      })
    })
  })
}

function creds(board, password = SECRET) {
  return {
    base: board.url,
    team: { id: 'org-1' },
    people: {
      w1: { email: 'w1@x.test', password },
      w2: { email: 'w2@x.test', password: 'pw-w2-secret' }
    }
  }
}

// Runs one in-process driver with the given prepare seam, then stops it. The driver's log lines go to
// the console in this mode; they are collected in logs so a test can check that nothing secret is in them.
async function withDriver(prepare, job) {
  const dir = freshDir()
  const logs = []
  const write = console.log
  console.log = (...parts) => logs.push(parts.join(' '))
  try {
    const running = serve({ dir, chromium: CHROMIUM, signals: false, prepare })
    await waitUntil(async () => (await request({ dir, cmd: 'status', start: false })) !== null, 20000, 'the in-process driver')
    const ask = (who, cmd, args = {}) => request({ dir, who, cmd, args, start: true, seam: false })
    try {
      return await job({ dir, ask, logs })
    } finally {
      await request({ dir, cmd: 'shutdown', start: false }).catch(() => null)
      await running.catch(() => null)
    }
  } finally {
    console.log = write
  }
}

// ---------- unit tests: no Chromium needed ----------

describe('the board origin', () => {
  test('https is accepted, and so is plain http to this machine only', () => {
    assert.equal(boardOrigin('https://board.example.org/some/path'), 'https://board.example.org')
    assert.equal(boardOrigin('http://localhost:3000'), 'http://localhost:3000')
    assert.equal(boardOrigin('http://127.0.0.1:3000/'), 'http://127.0.0.1:3000')
    assert.equal(boardOrigin('http://[::1]:3000'), 'http://[::1]:3000')
  })

  test('plain http to another host, other schemes and non-URLs are refused', () => {
    assert.throws(() => boardOrigin('http://board.example.org'), BrowserError)
    assert.throws(() => boardOrigin('ftp://localhost/'), BrowserError)
    assert.throws(() => boardOrigin('not a url'), BrowserError)
  })
})

describe('reading a Set-Cookie line', () => {
  test('name, value and attributes come out as the cookie the driver sets', () => {
    const cookie = parseSetCookie('better-auth.session_token=a=b.c; Path=/app; HttpOnly; Secure; SameSite=Strict; Max-Age=60', 'https://board.example.org', 1000000)
    assert.deepEqual(cookie, {
      name: 'better-auth.session_token',
      value: 'a=b.c',
      url: 'https://board.example.org',
      path: '/app',
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
      expires: 1000 + 60
    })
  })

  test('a __Host- cookie is kept only when Secure, Path=/ and no Domain: otherwise it is dropped', () => {
    assert.notEqual(parseSetCookie('__Host-sid=1; Path=/; Secure', 'https://board.example.org'), null)
    assert.equal(parseSetCookie('__Host-sid=1; Path=/app; Secure', 'https://board.example.org'), null)
    assert.equal(parseSetCookie('__Host-sid=1; Path=/', 'https://board.example.org'), null)
    assert.equal(parseSetCookie('__Host-sid=1; Path=/; Secure; Domain=board.example.org', 'https://board.example.org'), null)
  })

  test('a Domain attribute is ignored, a line with no name is dropped', () => {
    const cookie = parseSetCookie('sid=1; Domain=evil.example', 'http://localhost:3000')
    assert.equal(cookie.url, 'http://localhost:3000')
    assert.equal(cookie.expires, -1)
    assert.equal(parseSetCookie('=orphan', 'http://localhost:3000'), null)
  })
})

// ---------- with Chromium ----------

describe('the sign-in (real Chromium)', { skip: SKIP }, () => {
  let board
  test('setup: a stand-in board', async () => {
    board = await startBoard()
  })

  test('the password never reaches a page that overrides fetch; the session reaches the person, the team step carries it', async () => {
    await withDriver(async (who, call, session) => {
      if (who !== 'w1') return
      await call('goto', { url: `${board.url}/hostile` })
      await signIn(who, session, creds(board))
    }, async ({ ask, logs }) => {
      assert.equal((await ask('w1', 'eval', { js: 'JSON.stringify(window.__seen)' })).result, '[]')
      assert.equal(board.seen.signIn.at(-1).origin, board.url, 'the sign-in came from the board origin')
      assert.ok(board.seen.setActive.at(-1).includes(`better-auth.session_token=${SESSION}`), 'the team step carried the session')
      const log = logs.join('\n')
      assert.equal(log.includes(SECRET), false, 'the password is not logged')
      assert.equal(log.includes(SESSION), false, 'the session is not logged')
    })
  })

  test('the cookies land on that person\'s context only', async () => {
    await withDriver(async (who, call, session) => {
      if (who === 'w1') await signIn(who, session, creds(board))
    }, async ({ ask }) => {
      await ask('w1', 'goto', { url: `${board.url}/check` })
      assert.equal((await ask('w1', 'eval', { js: 'document.title' })).result, 'session')
      assert.equal((await ask('w1', 'eval', { js: 'document.cookie.includes(\'tok-w1\')' })).result, false, 'the cookie is HttpOnly')
      await ask('w2', 'goto', { url: `${board.url}/check` })
      assert.equal((await ask('w2', 'eval', { js: 'document.title' })).result, 'no session')
    })
  })

  test('a refused sign-in says the status only, never the password or the answer', async () => {
    await withDriver(async (who, call, session) => {
      if (who === 'w1') await signIn(who, session, creds(board, 'wrong-secret'))
    }, async ({ ask }) => {
      await assert.rejects(ask('w1', 'goto', { url: `${board.url}/check` }), (e) => {
        assert.match(e.message, /could not sign in as w1 \(HTTP 401\)$/)
        assert.equal(e.message.includes('wrong-secret'), false)
        assert.equal(e.message.includes('Invalid email'), false)
        return true
      })
    })
  })

  test('a redirect on the sign-in is refused, not followed', async () => {
    await withDriver(async (who, call, session) => {
      if (who === 'w1') await signIn(who, session, creds(board, 'pw-redirect'))
    }, async ({ ask }) => {
      await assert.rejects(ask('w1', 'goto', { url: `${board.url}/check` }), (e) => {
        assert.match(e.message, /redirect \(HTTP 302\), so the sign-in was refused/)
        return true
      })
    })
  })

  test('teardown: stop the stand-in board', async () => {
    await board.close()
  })
})

// Removes the scratch folders this file made.
process.on('exit', () => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})
