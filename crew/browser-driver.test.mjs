// Tests for browser-driver.mjs. Run from the repo root: node --test crew/browser-driver.test.mjs
//
// The unit tests need nothing. The integration tests start the driver and a real Chromium when
// one is found (CREW_BROWSER_CHROMIUM, CHROMIUM, or chromium in crew.json); otherwise they skip
// and say why. Their pages come from a throwaway HTTP server on 127.0.0.1 in this test process:
// that is the test's page server, not the driver, which listens on a unix socket only.
// Scratch directories go under CREW_BROWSER_TEST_TMP (default: the system temp dir).

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, describe, test } from 'node:test'
import { once } from 'node:events'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  acquireLock, BrowserError, chromeArgs, encodeFrame, findChromium, formatDuration, idleNote, lockDecision, Mutex,
  checkDirectory, checkSendMethod, checkShotPath, keepLock, openDirectory, parseCli, parseRequest, pidAlive, request, releaseLock, sameFolder, serve, shotRoots,
  socketPathFits, splitFrames, validWho, withTimeout
} from './browser-driver.mjs'

const SELF = fileURLToPath(new URL('./browser-driver.mjs', import.meta.url))
const SCRATCH = resolve(process.env.CREW_BROWSER_TEST_TMP || tmpdir())
const CHROMIUM = findChromium()
const SKIP = CHROMIUM ? false : 'no Chromium found (set CREW_BROWSER_CHROMIUM or CHROMIUM, or chromium in crew.json)'
if (SKIP) console.log(`# integration tests skipped: ${SKIP}`)
else process.env.CREW_BROWSER_CHROMIUM = CHROMIUM
process.env.CREW_BROWSER_SHOT_DIRS = SCRATCH // the shot tests write under the scratch folder only

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const made = []

function freshDir() {
  mkdirSync(SCRATCH, { recursive: true })
  const dir = mkdtempSync(join(SCRATCH, 'bd-'))
  made.push(dir)
  return dir
}

async function waitUntil(check, ms, what) {
  const until = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await sleep(200)
  }
}

function deadPid() {
  return spawnSync(process.execPath, ['-e', '0']).pid
}

function withEnv(vars, job) {
  const saved = {}
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key]
    process.env[key] = value
  }
  return job().finally(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

const ask = (dir, who, cmd, args = {}) => request({ dir, who, cmd, args, start: true, seam: false })

// the driver's output goes to its pool.log, so the tests can read its Chromium pid
const daemonStdio = dir => ['ignore', openSync(join(dir, 'pool.log'), 'a'), openSync(join(dir, 'pool.log'), 'a')]

function chromiumPids(dir) {
  const text = existsSync(join(dir, 'pool.log')) ? readFileSync(join(dir, 'pool.log'), 'utf8') : ''
  return [...text.matchAll(/chromium pid (\d+)/g)].map(m => Number(m[1]))
}

async function stopDriver(dir) {
  await request({ dir, cmd: 'shutdown', start: false }).catch(() => null)
  await waitUntil(async () => (await request({ dir, cmd: 'status', start: false }).catch(() => null)) === null, 15000, 'the driver to stop')
}

// ---------- unit tests: no Chromium needed ----------

describe('names and durations', () => {
  test('WHO is a short lowercase name', () => {
    assert.equal(validWho('w1'), true)
    assert.equal(validWho('scrap_2-x'), true)
    for (const bad of ['', 'W1', 'a/b', '../x', 'x'.repeat(33), 'a b', undefined, 7]) {
      assert.equal(validWho(bad), false, `accepted ${String(bad)}`)
    }
  })

  test('durations and the expiry notice read naturally and name no page data', () => {
    assert.equal(formatDuration(1800), '30 minutes')
    assert.equal(formatDuration(1), '1 second')
    assert.equal(formatDuration(2), '2 seconds')
    assert.equal(idleNote('w1', 1800), 'w1: your browser session expired after 30 minutes idle, so tabs and logins are gone')
  })
})

describe('request validation', () => {
  const ok = text => parseRequest(JSON.stringify(text))

  test('accepts the protocol of the reference', () => {
    assert.deepEqual(ok({ cmd: 'goto', who: 'w1', args: { url: 'https://example.test/a', tab: 'docs', width: 390 } }).args.width, 390)
    assert.equal(ok({ cmd: 'status' }).cmd, 'status')
    assert.equal(ok({ cmd: 'shutdown', who: 'x' }).who, null)
    assert.equal(ok({ cmd: 'shot', who: 'w2', args: { file: '/tmp/a.png', full: true } }).cmd, 'shot')
    assert.equal(ok({ cmd: 'send', who: 'w2', args: { method: 'Page.reload' } }).cmd, 'send')
  })

  test('rejects a bad WHO, an unknown command and a request that is not an object', () => {
    assert.throws(() => ok({ cmd: 'tabs', who: '../w1' }), BrowserError)
    assert.throws(() => ok({ cmd: 'tabs' }), BrowserError)
    assert.throws(() => ok({ cmd: 'launch', who: 'w1' }), /unknown command/)
    assert.throws(() => parseRequest('not json'), /not JSON/)
    assert.throws(() => parseRequest('[1]'), /not an object/)
    assert.throws(() => ok({ cmd: 'tabs', who: 'w1', args: [] }), /args must be an object/)
  })

  test('rejects URLs that are not web pages, and a relative shot path', () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'chrome://settings', 'notaurl', '']) {
      assert.throws(() => ok({ cmd: 'goto', who: 'w1', args: { url } }), /goto takes/, url)
    }
    assert.throws(() => ok({ cmd: 'shot', who: 'w1', args: { file: 'out.png' } }), /absolute/)
  })

  test('rejects bad tab names, sizes, and CDP methods that reach past the tab', () => {
    assert.throws(() => ok({ cmd: 'tabs', who: 'w1', args: { tab: 'a b' } }), /tab names/)
    assert.throws(() => ok({ cmd: 'goto', who: 'w1', args: { url: 'about:blank', width: 9000 } }), /width/)
    assert.throws(() => ok({ cmd: 'goto', who: 'w1', args: { url: 'about:blank', width: 1.5 } }), /width/)
    for (const method of ['Target.createBrowserContext', 'Browser.close', 'Page.navigate', 'page', 'Page.a b']) {
      assert.throws(() => ok({ cmd: 'send', who: 'w1', args: { method } }), /not allowed|send takes/, method)
    }
    assert.throws(() => ok({ cmd: 'close-tab', who: 'w1', args: {} }), /close-tab takes/)
  })
})

describe('command line', () => {
  test('parses flags and positional arguments into the request shape', () => {
    assert.deepEqual(parseCli(['w1', 'goto', 'https://e.test', '--tab', 'docs', '--width', '390']), {
      who: 'w1', cmd: 'goto', args: { url: 'https://e.test', tab: 'docs', width: 390 }
    })
    const shot = parseCli(['w1', 'shot', 'out.png', '--full'])
    assert.equal(shot.args.full, true)
    assert.ok(shot.args.file.startsWith('/'), 'the shot path is made absolute')
    assert.deepEqual(parseCli(['w2', 'send', 'Page.reload', '{"ignoreCache":true}']).args.params, { ignoreCache: true })
    assert.deepEqual(parseCli(['status']), { who: null, cmd: 'status', args: {} })
  })

  test('refuses a missing argument, a bad number or bad JSON with a message', () => {
    assert.throws(() => parseCli(['w1', 'goto']), /needs an argument/)
    assert.throws(() => parseCli(['w1', 'goto', 'x', '--width']), /needs a value/)
    assert.throws(() => parseCli(['w1', 'goto', 'x', '--width', 'wide']), /whole number/)
    assert.throws(() => parseCli(['w1', 'send', 'Page.reload', '{bad']), /params must be JSON/)
    assert.throws(() => parseCli(['W1', 'tabs']), /WHO/)
    assert.equal(parseCli([]).help, true)
    assert.equal(parseCli(['w1', 'eval', '1', '--accept-dialogs']).args.accept_dialogs, true)
    assert.equal(parseCli(['w1', 'shot', 'a.png', '--overwrite']).args.overwrite, true)
  })
})

describe('the wire: frames and Chromium arguments', () => {
  test('splits NUL-terminated frames that arrive in pieces', () => {
    const a = encodeFrame({ id: 1, result: {} })
    const b = encodeFrame({ method: 'Page.loadEventFired' })
    const joined = Buffer.concat([a, b, Buffer.from('{"id":3')])
    const first = splitFrames(joined)
    assert.deepEqual(first.frames.map(f => JSON.parse(f).id ?? JSON.parse(f).method), [1, 'Page.loadEventFired'])
    const second = splitFrames(Buffer.concat([first.rest, Buffer.from(',"x":1}\0')]))
    assert.deepEqual(JSON.parse(second.frames[0]), { id: 3, x: 1 })
    assert.equal(second.rest.length, 0)
  })

  test('Chromium gets the debugging pipe and never a debugging port', () => {
    const args = chromeArgs({ profileDir: '/x/profile' })
    assert.ok(args.includes('--remote-debugging-pipe'))
    assert.ok(!args.some(arg => /remote-debugging-port|remote-debugging-address/.test(arg)))
    assert.ok(!args.includes('--no-sandbox'), 'the sandbox stays on unless asked')
    assert.ok(chromeArgs({ profileDir: '/x', sandbox: false }).includes('--no-sandbox'))
  })

  test('a socket path must fit the unix socket limit', () => {
    assert.equal(socketPathFits('/home/x/.local/share/crew-browser/pool.sock'), true)
    assert.equal(socketPathFits(`/${'d'.repeat(120)}/pool.sock`), false)
  })
})

describe('the lock', () => {
  test('a live owner always wins; only a dead owner with no socket is taken over', () => {
    assert.equal(lockDecision({ ownerAlive: true, socketAccepts: false }), 'busy')
    assert.equal(lockDecision({ ownerAlive: false, socketAccepts: true }), 'busy')
    assert.equal(lockDecision({ ownerAlive: true, socketAccepts: true }), 'busy')
    assert.equal(lockDecision({ ownerAlive: false, socketAccepts: false }), 'take')
  })

  test('pidAlive: this process is alive, a finished child is not', () => {
    assert.equal(pidAlive(process.pid), true)
    assert.equal(pidAlive(deadPid()), false)
    assert.equal(pidAlive(0), false)
  })

  test('a live lock blocks acquisition; a stale lock with no socket is taken over', async () => {
    const dir = freshDir()
    const sock = join(dir, 'pool.sock')
    writeFileSync(join(dir, 'pool.lock'), `${process.pid}\n`)
    assert.equal(await acquireLock(dir, sock), false, 'our own pid is alive, so the lock holds')
    writeFileSync(join(dir, 'pool.lock'), `${deadPid()}\n`)
    assert.equal(await acquireLock(dir, sock), true, 'a dead owner with no socket is taken over')
    assert.equal(readFileSync(join(dir, 'pool.lock'), 'utf8').trim(), String(process.pid))
    releaseLock(dir)
    assert.equal(existsSync(join(dir, 'pool.lock')), false)
  })

  test('a dead owner whose socket still answers keeps the lock', async () => {
    const dir = freshDir()
    const sock = join(dir, 'pool.sock')
    const listener = net.createServer(c => c.end())
    await new Promise(resolve => listener.listen(sock, resolve))
    try {
      writeFileSync(join(dir, 'pool.lock'), `${deadPid()}\n`)
      assert.equal(await acquireLock(dir, sock), false)
      assert.ok(existsSync(sock), 'the live socket was not removed')
    } finally {
      await new Promise(resolve => listener.close(resolve))
    }
  })

  test('a second driver start leaves a live driver and its socket alone', async () => {
    const dir = freshDir()
    writeFileSync(join(dir, 'pool.lock'), `${process.pid}\n`)
    const sock = join(dir, 'pool.sock')
    const listener = net.createServer(c => c.end())
    await new Promise(resolve => listener.listen(sock, resolve))
    try {
      assert.equal(await serve({ dir, signals: false }), 'busy')
      assert.ok(existsSync(sock))
      assert.equal(readFileSync(join(dir, 'pool.lock'), 'utf8').trim(), String(process.pid), 'the lock is not ours to remove')
    } finally {
      await new Promise(resolve => listener.close(resolve))
      rmSync(join(dir, 'pool.lock'), { force: true })
    }
  })
})

describe('send allowlist, shot paths and the state folder', () => {
  test('send allows the page-level domains the crew uses', () => {
    const allowed = ['Page.reload', 'Runtime.evaluate', 'DOM.getDocument', 'CSS.getComputedStyleForNode', 'Input.dispatchMouseEvent',
      'Emulation.setDeviceMetricsOverride', 'Accessibility.getFullAXTree', 'Log.enable', 'Network.getCookies', 'Network.enable', 'Network.disable']
    for (const method of allowed) assert.doesNotThrow(() => checkSendMethod(method), method)
  })

  test('send refuses the download, file chooser and CSP methods on Page, and navigate', () => {
    for (const method of ['Page.setDownloadBehavior', 'Page.setInterceptFileChooserDialog', 'Page.setBypassCSP', 'Page.navigate']) {
      assert.throws(() => checkSendMethod(method), /not allowed/, method)
    }
  })

  test('send refuses Network methods that are neither reads nor switches', () => {
    assert.throws(() => checkSendMethod('Network.setCookie'), /not allowed/)
    assert.throws(() => checkSendMethod('Network.setExtraHTTPHeaders'), /not allowed/)
  })

  test('send refuses each blocked domain and an unknown one', () => {
    const blocked = ['Browser.close', 'Target.createTarget', 'Fetch.enable', 'IO.read', 'Storage.getCookies', 'Security.disable',
      'SystemInfo.getInfo', 'Debugger.enable', 'Unknown.thing']
    for (const method of blocked) assert.throws(() => checkSendMethod(method), /not allowed/, method)
  })

  test('the refusal lists the allowed domains', () => {
    assert.throws(() => checkSendMethod('Browser.close'), /Allowed domains: Page, Runtime, DOM, CSS, Input, Emulation, Accessibility, Log, Network/)
  })

  test('shot takes only an absolute .png or .jpg name in an allowed folder', () => {
    const dir = freshDir()
    const roots = [realpathSync(dir)]
    const inside = join(dir, 'a.png')
    assert.equal(checkShotPath(inside, { roots }), inside)
    assert.equal(checkShotPath(join(dir, 'b.JPG'), { roots }), join(dir, 'b.JPG'))
    assert.throws(() => checkShotPath('a.png', { roots }), /absolute/)
    assert.throws(() => checkShotPath(join(dir, 'a.txt'), { roots }), /png or .jpg/)
    assert.throws(() => checkShotPath(join(dir, 'missing', 'a.png'), { roots }), /does not exist/)
    const other = freshDir()
    assert.throws(() => checkShotPath(join(other, 'a.png'), { roots }), /outside the allowed folders/)
  })

  test('shot refuses a link or a folder, and an existing file unless overwriting', () => {
    const dir = freshDir()
    const roots = [realpathSync(dir)]
    const target = join(dir, 'exists.png')
    writeFileSync(target, 'x')
    assert.throws(() => checkShotPath(target, { roots }), /--overwrite/)
    assert.equal(checkShotPath(target, { roots, overwrite: true }), target)
    const link = join(dir, 'link.png')
    symlinkSync(target, link)
    assert.throws(() => checkShotPath(link, { roots, overwrite: true }), /link or a folder/)
    mkdirSync(join(dir, 'folder.png'))
    assert.throws(() => checkShotPath(join(dir, 'folder.png'), { roots, overwrite: true }), /link or a folder/)
  })

  test('the state folder must be a real folder, not a link', () => {
    const dir = freshDir()
    const real = join(dir, 'real')
    mkdirSync(real, { mode: 0o700 })
    const link = join(dir, 'link')
    symlinkSync(real, link)
    assert.throws(() => checkDirectory(link), /not a link/)
    assert.doesNotThrow(() => checkDirectory(real))
  })

  test('the state folder is opened and checked in one step; a folder swapped in its place is refused', () => {
    const dir = freshDir()
    const real = join(dir, 'real')
    mkdirSync(real, { mode: 0o700 })
    const fd = openDirectory(real)
    try {
      assert.equal(sameFolder(real, fd), true)
      renameSync(real, join(dir, 'moved'))
      mkdirSync(real, { mode: 0o700 })
      assert.equal(sameFolder(real, fd), false, 'a folder put in the same place is not the one we opened')
    } finally {
      closeSync(fd)
    }
  })

  test('the system temp folder is a shot root only when CREW_BROWSER_SHOT_DIRS names it', () => {
    const saved = process.env.CREW_BROWSER_SHOT_DIRS
    const temp = realpathSync(tmpdir())
    try {
      delete process.env.CREW_BROWSER_SHOT_DIRS
      assert.ok(shotRoots().every(root => root !== temp && !root.startsWith(temp + '/')), 'the temp folder is not a default')
      process.env.CREW_BROWSER_SHOT_DIRS = temp
      assert.ok(shotRoots().includes(temp), 'named in CREW_BROWSER_SHOT_DIRS, it is a root')
    } finally {
      if (saved === undefined) delete process.env.CREW_BROWSER_SHOT_DIRS
      else process.env.CREW_BROWSER_SHOT_DIRS = saved
    }
  })
})

describe('a takeover never puts a lock back', () => {
  test('a live driver whose lock a takeover moved away takes it again; another driver lock is left alone', () => {
    const dir = freshDir()
    const file = join(dir, 'pool.lock')
    writeFileSync(file, `${process.pid}\n`)
    rmSync(file) // what a takeover that caught the live lock leaves behind
    keepLock(dir)
    assert.equal(readFileSync(file, 'utf8').trim(), String(process.pid), 'the live driver holds its lock again')
    writeFileSync(file, '4242\n')
    keepLock(dir)
    assert.equal(readFileSync(file, 'utf8').trim(), '4242', 'a lock someone else holds is not replaced')
    rmSync(file)
  })
})

describe('lock takeover under a race', () => {
  test('two drivers racing for one stale lock: exactly one takes it', async () => {
    const dir = freshDir()
    writeFileSync(join(dir, 'pool.lock'), `${deadPid()}\n`)
    const script = `import { acquireLock } from ${JSON.stringify(pathToFileURL(SELF).href)}
const won = await acquireLock(${JSON.stringify(dir)})
console.log(won ? 'won' : 'lost')
await new Promise(resolve => setTimeout(resolve, 1500))`
    const run = () => new Promise((resolve) => {
      let out = ''
      const child = spawn(process.execPath, ['--input-type=module', '-e', script])
      child.stdout.on('data', (chunk) => {
        out += chunk
      })
      child.on('exit', () => resolve(out.trim()))
    })
    const [a, b] = await Promise.all([run(), run()])
    assert.deepEqual([a, b].sort(), ['lost', 'won'])
  })
})

describe('small parts', () => {
  test('the mutex runs jobs one at a time, in order, and survives a failure', async () => {
    const m = new Mutex()
    const order = []
    const job = (name, ms) => m.run(async () => {
      order.push(`${name}:start`)
      await sleep(ms)
      order.push(`${name}:end`)
    })
    const failing = m.run(async () => {
      throw new Error('boom')
    })
    await Promise.all([job('a', 20), job('b', 1), failing.catch(() => {})])
    assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end'])
  })

  test('withTimeout gives up on a job that never answers', async () => {
    await assert.rejects(withTimeout(new Promise(() => {}), 20, 'stuck'), BrowserError)
    assert.equal(await withTimeout(Promise.resolve(7), 1000, 'quick'), 7)
  })
})

// ---------- integration tests: a real Chromium ----------

/** A page server for the tests: /set plants a cookie and a localStorage value, /read is plain. */
async function startSite() {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/set')) {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'sid=w1-secret; Path=/' })
      res.end('<meta name="viewport" content="width=device-width"><title>set</title><script>localStorage.setItem(\'k\', \'v\')</script>')
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<meta name="viewport" content="width=device-width"><title>read</title><p>read</p>')
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => {
      server.closeAllConnections()
      return new Promise(resolve => server.close(resolve))
    }
  }
}

describe('the shared browser (real Chromium)', { skip: SKIP }, () => {
  let site
  const dirs = []
  const newDir = () => {
    const dir = freshDir()
    dirs.push(dir)
    return dir
  }

  after(async () => {
    for (const dir of dirs) await stopDriver(dir).catch(() => {})
    if (site) await site.close()
    for (const dir of made) rmSync(dir, { recursive: true, force: true })
  })

  test('setup: a page server for the tests', async () => {
    site = await startSite()
  })

  test('two simultaneous first requests share one browser and one driver', async () => {
    const dir = newDir()
    const [a, b] = await Promise.all([ask(dir, 'w1', 'tabs'), ask(dir, 'w2', 'tabs')])
    assert.deepEqual(a.result, [])
    assert.deepEqual(b.result, [])
    assert.equal(chromiumPids(dir).length, 1, 'one Chromium')
    const log = readFileSync(join(dir, 'pool.log'), 'utf8')
    assert.equal((log.match(/^.* ready$/gm) ?? []).length, 1, 'one driver ready')
    const status = await request({ dir, cmd: 'status', start: false })
    assert.deepEqual(status.result.map(p => p.who).sort(), ['w1', 'w2'])
  })

  test('the socket is 0600 in a 0700 directory, and a second start does not take it', async () => {
    const dir = newDir()
    await ask(dir, 'w1', 'tabs')
    const sock = join(dir, 'pool.sock')
    assert.equal(statSync(dir).mode & 0o777, 0o700)
    assert.equal(statSync(sock).mode & 0o777, 0o600)
    const second = spawn(process.execPath, [SELF, '_daemon'], { env: { ...process.env, CREW_BROWSER_DIR: dir }, stdio: 'ignore' })
    const [code] = await once(second, 'exit')
    assert.equal(code, 0)
    assert.deepEqual((await ask(dir, 'w1', 'tabs')).result, [], 'the live driver still answers')
  })
  test('two people on one origin share no cookies or storage; two tabs of one person share them', async () => {
    const dir = newDir()
    await ask(dir, 'w1', 'goto', { url: `${site.url}/set` })
    await ask(dir, 'w2', 'goto', { url: `${site.url}/read` })
    const w2Cookie = (await ask(dir, 'w2', 'eval', { js: 'document.cookie' })).result
    assert.equal(w2Cookie.includes('sid='), false)
    assert.equal((await ask(dir, 'w2', 'eval', { js: 'localStorage.getItem(\'k\')' })).result, null)
    await ask(dir, 'w1', 'goto', { url: `${site.url}/read`, tab: 'other' })
    assert.equal((await ask(dir, 'w1', 'eval', { js: 'document.cookie', tab: 'other' })).result.includes('sid='), true)
    assert.equal((await ask(dir, 'w1', 'eval', { js: 'localStorage.getItem(\'k\')', tab: 'other' })).result, 'v')
  })

  test('a width stays on its tab across navigation and reaches no one else', async () => {
    const dir = newDir()
    await ask(dir, 'w1', 'goto', { url: `${site.url}/read`, width: 390 })
    assert.equal((await ask(dir, 'w1', 'eval', { js: 'innerWidth' })).result, 390)
    await ask(dir, 'w1', 'goto', { url: `${site.url}/set` })
    assert.equal((await ask(dir, 'w1', 'eval', { js: 'innerWidth' })).result, 390)
    await ask(dir, 'w2', 'goto', { url: `${site.url}/read` })
    assert.notEqual((await ask(dir, 'w2', 'eval', { js: 'innerWidth' })).result, 390)
  })

  test('alert and confirm are dismissed by default and noted in console', async () => {
    const dir = newDir()
    await ask(dir, 'w1', 'goto', { url: `${site.url}/read` })
    assert.equal((await ask(dir, 'w1', 'eval', { js: 'alert(\'hello\'); confirm(\'sure\')' })).result, false, 'confirm is dismissed')
    const { result } = await ask(dir, 'w1', 'console')
    assert.ok(result.includes('dialog alert dismissed') && result.includes('dialog confirm dismissed'), 'the types are noted')
    assert.ok(!result.some(line => line.includes('hello') || line.includes('sure')), 'the dialog text is not noted')
    assert.deepEqual((await ask(dir, 'w1', 'console')).result, [], 'console is cleared when read')
  })

  test('dialogs are accepted only when the command asks for it', async () => {
    const dir = newDir()
    await ask(dir, 'w1', 'goto', { url: `${site.url}/read` })
    assert.equal((await ask(dir, 'w1', 'eval', { js: 'confirm(\'sure\')', accept_dialogs: true })).result, true)
    assert.ok((await ask(dir, 'w1', 'console')).result.includes('dialog confirm accepted'))
  })

  test('shot writes a PNG, and eval returns values by value', async () => {
    const dir = newDir()
    await ask(dir, 'w1', 'goto', { url: `${site.url}/read` })
    const file = join(dir, 'shot.png')
    await ask(dir, 'w1', 'shot', { file })
    assert.deepEqual([...readFileSync(file).subarray(1, 4)], [0x50, 0x4e, 0x47])
    await assert.rejects(ask(dir, 'w1', 'shot', { file }), /--overwrite/)
    await ask(dir, 'w1', 'shot', { file, overwrite: true })
    await assert.rejects(ask(dir, 'w1', 'shot', { file: join(dir, '..', '..', 'outside.png') }), /outside the allowed folders/)
    await assert.rejects(ask(dir, 'w1', 'send', { method: 'Page.setDownloadBehavior', params: { behavior: 'allow', downloadPath: dir } }), /not allowed/)
    assert.deepEqual((await ask(dir, 'w1', 'eval', { js: '({ a: 1 })' })).result, { a: 1 })
    assert.equal((await ask(dir, 'w1', 'eval', { js: '1 + 1' })).result, 2)
  })

  test('at most 8 named tabs a person; the 9th is refused', async () => {
    const dir = newDir()
    await ask(dir, 'w1', 'goto', { url: `${site.url}/read` })
    for (let i = 1; i <= 7; i++) await ask(dir, 'w1', 'goto', { url: `${site.url}/read`, tab: `t${i}` })
    assert.equal((await ask(dir, 'w1', 'tabs')).result.length, 8)
    await assert.rejects(ask(dir, 'w1', 'goto', { url: `${site.url}/read`, tab: 't8' }), /already has 8 tabs/)
    await ask(dir, 'w1', 'close-tab', { tab: 't1' })
    assert.equal((await ask(dir, 'w1', 'tabs')).result.length, 7)
  })

  test('done forgets the person: their cookies are gone', async () => {
    const dir = newDir()
    await ask(dir, 'w1', 'goto', { url: `${site.url}/set` })
    assert.equal((await ask(dir, 'w1', 'done')).result, 'done')
    await ask(dir, 'w1', 'goto', { url: `${site.url}/read` })
    assert.equal((await ask(dir, 'w1', 'eval', { js: 'document.cookie' })).result.includes('sid='), false)
  })

  test('a killed client does not affect another person', async () => {
    const dir = newDir()
    await ask(dir, 'w2', 'goto', { url: `${site.url}/read` })
    const client = spawn(process.execPath, [SELF, 'w9', 'eval', 'new Promise(r => setTimeout(() => r(1), 1500))'], {
      env: { ...process.env, CREW_BROWSER_DIR: dir }, stdio: 'ignore'
    })
    await sleep(500)
    client.kill('SIGKILL')
    await once(client, 'exit')
    await sleep(2000)
    assert.deepEqual((await ask(dir, 'w2', 'tabs')).result, ['main'])
  })

  test('a stuck page times out and the driver still answers', async () => {
    await withEnv({ BROWSER_CALL_SECONDS: '3' }, async () => {
      const dir = newDir()
      await ask(dir, 'w1', 'goto', { url: `${site.url}/read` })
      const started = Date.now()
      await assert.rejects(ask(dir, 'w1', 'eval', { js: 'while (true) {}' }), /timed out/)
      assert.ok(Date.now() - started < 20000)
      assert.deepEqual((await ask(dir, 'w2', 'tabs')).result, [])
    })
  })

  test('idle people lose their context, and the next command says so', async () => {
    await withEnv({ BROWSER_IDLE_SECONDS: '2', BROWSER_EXIT_SECONDS: '600' }, async () => {
      const dir = newDir()
      await ask(dir, 'w1', 'goto', { url: `${site.url}/read` })
      await waitUntil(async () => (await request({ dir, cmd: 'status', start: false })).result.length === 0, 15000, 'w1 to expire')
      const reply = await ask(dir, 'w1', 'tabs')
      assert.deepEqual(reply.result, [])
      assert.match(reply.note, /expired after 2 seconds idle, so tabs and logins are gone/)
      assert.equal((await ask(dir, 'w1', 'tabs')).note, null, 'the note is said once')
    })
  })

  test('the browser exits once nobody has used it, and its Chromium with it', async () => {
    await withEnv({ BROWSER_IDLE_SECONDS: '2', BROWSER_EXIT_SECONDS: '2' }, async () => {
      const dir = newDir()
      await ask(dir, 'w1', 'goto', { url: `${site.url}/read` })
      const chromium = chromiumPids(dir).at(-1)
      await waitUntil(async () => (await request({ dir, cmd: 'status', start: false })) === null, 20000, 'the driver to exit')
      await waitUntil(() => !pidAlive(chromium), 15000, 'Chromium to exit')
    })
  })

  test('a browser crash is noticed, the next command starts a new one and says so', async () => {
    const dir = newDir()
    await ask(dir, 'w1', 'goto', { url: `${site.url}/read` })
    const before = chromiumPids(dir).at(-1)
    process.kill(before, 'SIGKILL')
    await waitUntil(() => /browser stopped/.test(readFileSync(join(dir, 'pool.log'), 'utf8')), 15000, 'the crash to be noticed')
    const started = Date.now()
    const reply = await ask(dir, 'w1', 'tabs')
    assert.ok(Date.now() - started < 30000, 'the command does not hang')
    assert.match(reply.note, /stopped and was started again/)
    assert.deepEqual(reply.result, [])
    assert.notEqual(chromiumPids(dir).at(-1), before)
    assert.equal((await ask(dir, 'w1', 'tabs')).note, null)
  })

  test('kill -9 on the driver ends its Chromium; the next start takes over the lock', async () => {
    const dir = newDir()
    const driver = spawn(process.execPath, [SELF, '_daemon', '--no-seam'], { env: { ...process.env, CREW_BROWSER_DIR: dir }, stdio: daemonStdio(dir) })
    await waitUntil(async () => (await request({ dir, cmd: 'status', start: false })) !== null, 20000, 'the driver to start')
    const chromium = chromiumPids(dir).at(-1)
    assert.ok(pidAlive(chromium))
    driver.kill('SIGKILL')
    await once(driver, 'exit')
    await waitUntil(() => !pidAlive(chromium), 15000, 'Chromium to exit after the driver was killed')
    const again = spawn(process.execPath, [SELF, '_daemon', '--no-seam'], { env: { ...process.env, CREW_BROWSER_DIR: dir }, stdio: daemonStdio(dir) })
    await waitUntil(async () => (await request({ dir, cmd: 'status', start: false })) !== null, 20000, 'the new driver to start')
    assert.deepEqual((await ask(dir, 'w1', 'tabs')).result, [])
    again.kill('SIGKILL')
    await once(again, 'exit')
    await waitUntil(() => !pidAlive(chromiumPids(dir).at(-1)), 15000, 'Chromium to exit')
  })

  test('people are capped: one more is refused in plain words', async () => {
    await withEnv({ CREW_BROWSER_MAX_PEOPLE: '2' }, async () => {
      const dir = newDir()
      await ask(dir, 'w1', 'tabs')
      await ask(dir, 'w2', 'tabs')
      await assert.rejects(ask(dir, 'w3', 'tabs'), /is full: 2 people/)
      await ask(dir, 'w1', 'done')
      assert.deepEqual((await ask(dir, 'w3', 'tabs')).result, [])
    })
  })

  test('the prepare seam runs once per new context, before its first command', async () => {
    const dir = newDir()
    const prepared = []
    const running = serve({
      dir,
      chromium: CHROMIUM,
      signals: false,
      prepare: async (who, call) => {
        prepared.push(who)
        await call('goto', { url: `${site.url}/set` })
      }
    })
    await waitUntil(async () => (await request({ dir, cmd: 'status', start: false })) !== null, 20000, 'the in-process driver')
    assert.equal((await ask(dir, 'w1', 'eval', { js: 'document.cookie.includes(\'sid=\')' })).result, true)
    await ask(dir, 'w1', 'tabs')
    assert.deepEqual(prepared, ['w1'])
    await request({ dir, cmd: 'shutdown', start: false })
    assert.equal(await running, 'stopped')
  })
})

test('the request with no Chromium anywhere fails with a plain message', async () => {
  const dir = freshDir()
  const saved = { ...process.env }
  delete process.env.CREW_BROWSER_CHROMIUM
  delete process.env.CHROMIUM
  process.env.CREW_HOME = dir // no crew.json here, so there is no path to find
  try {
    assert.equal(findChromium(), '')
    const running = serve({ dir, signals: false })
    await assert.rejects(running, /no Chromium/)
    assert.equal(existsSync(join(dir, 'pool.lock')), false, 'the lock is released')
  } finally {
    process.env = saved
  }
})

after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})
