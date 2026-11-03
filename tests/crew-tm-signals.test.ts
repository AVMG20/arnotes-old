// `crew/tm.mjs` stops cleanly: a call stopped by SIGTERM, SIGINT or SIGHUP, by an uncaught error, or by a
// second signal while the browser close hangs, closes its browser and exits with the code for that stop.
// The signal cases run against a stand-in browser (tests/fixtures/crew-tm), so no Chromium is needed. The
// real-browser cases run only when CHROMIUM names a binary. Everything skips when crew/node_modules is missing.
// Run:
//   node --import tsx --test tests/crew-tm-signals.test.ts
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, type ChildProcess } from 'node:child_process'

const TM = join(process.cwd(), 'crew', 'tm.mjs')
const FIXTURES = fileURLToPath(new URL('./fixtures/crew-tm/', import.meta.url))
const KIT_READY = existsSync(join(process.cwd(), 'crew', 'node_modules'))
const CHROMIUM = process.env.CHROMIUM && existsSync(process.env.CHROMIUM) ? process.env.CHROMIUM : ''
const stand = KIT_READY ? test : test.skip
const real = KIT_READY && CHROMIUM ? test : test.skip

// The run scripts tm.mjs is asked to run. "hold" and "wait" keep the browser open until a signal arrives.
const SCRIPTS: Record<string, string> = {
  wait: 'export default async () => { await new Promise(resolve => setTimeout(resolve, 60000)) }\n',
  quick: 'export default async () => {}\n',
  boom: 'export default async () => { setTimeout(() => { throw new Error(\'boom\') }, 300); await new Promise(resolve => setTimeout(resolve, 60000)) }\n',
  // A page whose confirm() answer is written to the title: the title shows what the dialog handler did.
  dialog: 'export default async ({ page }) => { const html = \'<title>waiting</title><script>document.title = "done:" + confirm("ok?")</script>\'; await page.goto(\'data:text/html,\' + encodeURIComponent(html)); await page.waitForFunction(() => document.title.startsWith(\'done:\'), null, { timeout: 15000 }); console.log(\'TITLE \' + await page.title()) }\n'
}

let board: Server
let base = ''
const homes: string[] = []

// Answers the session check tm.mjs makes before a call, so no sign-in is needed.
before(async () => {
  board = createServer((req, res) => {
    if (req.url?.startsWith('/api/auth/get-session')) {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ user: { id: 'scratch' } }))
      return
    }
    res.statusCode = 404
    res.end('not found')
  })
  await new Promise<void>(resolve => board.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(board.address() as AddressInfo).port}`
})

after(() => {
  board.close()
  for (const dir of homes) rmSync(dir, { recursive: true, force: true })
})

// A throwaway CREW_HOME: its own crew.json and creds.json (pointing at the session answer above) and scripts.
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crew-tm-'))
  homes.push(dir)
  writeFileSync(join(dir, 'crew.json'), JSON.stringify({ product: { name: 'Scratch' } }))
  writeFileSync(join(dir, 'creds.json'), JSON.stringify({ base, team: { id: 't1' }, people: { w2: { apiKey: 'arn_fake_key_for_tests', email: 'w2@example.test', password: 'unused' } } }))
  mkdirSync(join(dir, 'scripts'))
  for (const [name, body] of Object.entries(SCRIPTS)) writeFileSync(join(dir, 'scripts', `${name}.mjs`), body)
  return dir
}

// The stand-in browser's environment: the hook is loaded into tm.mjs, and its events go to a log in the home.
function standEnv(dir: string, options: { launchMs?: number, closeHang?: boolean } = {}): Record<string, string> {
  return {
    NODE_OPTIONS: `--import ${join(FIXTURES, 'preload.mjs')}`,
    FAKE_LOG: join(dir, 'fake.log'),
    FAKE_LAUNCH_MS: String(options.launchMs ?? 0),
    FAKE_IGNORE_PIPE: '1',
    ...(options.closeHang ? { FAKE_CLOSE_HANG: '1' } : {})
  }
}

// The real-browser environment: no test hook, the Chromium named by CHROMIUM.
function realEnv(): Record<string, string> {
  return { NODE_OPTIONS: '', CHROMIUM }
}

type Result = { code: number | null, signal: string | null, stdout: string, stderr: string }

// Starts `tm.mjs w2 run <script>` in the home, with the given environment added.
function start(dir: string, script: string, env: Record<string, string>): { child: ChildProcess, exited: Promise<Result> } {
  const child = spawn(process.execPath, [TM, 'w2', 'run', join(dir, 'scripts', `${script}.mjs`)], {
    env: { ...process.env, CREW_HOME: dir, CREW_ACCEPT_DIALOGS: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk
  })
  const exited = new Promise<Result>(resolve => child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr })))
  return { child, exited }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function until(check: () => boolean, ms = 10000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    await sleep(50)
  }
  return check()
}

// A process is gone when it has no /proc entry or is a zombie.
function alive(pid: number): boolean {
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1][0] !== 'Z'
  } catch {
    return false
  }
}

// The live processes whose command line contains the text (the real browser's profile directory).
function processesWith(text: string): number[] {
  return readdirSync('/proc')
    .filter(name => /^\d+$/.test(name))
    .map(Number)
    .filter((pid) => {
      try {
        return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(text) && alive(pid)
      } catch {
        return false
      }
    })
}

function events(log: string): string[][] {
  try {
    return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => line.split(' '))
  } catch {
    return []
  }
}

const launched = (log: string) => events(log).filter(([event]) => event === 'launched').map(([, pid]) => Number(pid))
const count = (log: string, name: string) => events(log).filter(([event]) => event === name).length

for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]] as const) {
  stand(`${signal} during a run script closes the browser and exits ${code}`, async () => {
    const dir = home()
    const log = join(dir, 'fake.log')
    const run = start(dir, 'wait', standEnv(dir))
    assert.ok(await until(() => launched(log).length > 0), 'the stand-in browser launched')
    const [pid] = launched(log)
    await sleep(200)
    run.child.kill(signal)
    const result = await run.exited
    assert.equal(result.code, code)
    assert.equal(result.stderr, `stopping on ${signal}\n`)
    assert.ok(await until(() => !alive(pid)), 'the browser is gone')
    assert.equal(count(log, 'closed'), 1, 'closed exactly once')
  })
}

stand('a normal exit closes the browser once and prints no error', async () => {
  const dir = home()
  const log = join(dir, 'fake.log')
  const result = await start(dir, 'quick', standEnv(dir)).exited
  assert.equal(result.code, 0)
  assert.equal(result.stderr, '')
  assert.equal(count(log, 'close-called'), 1)
  assert.equal(count(log, 'closed'), 1)
})

stand('an uncaught error closes the browser and exits 1', async () => {
  const dir = home()
  const log = join(dir, 'fake.log')
  const run = start(dir, 'boom', standEnv(dir))
  assert.ok(await until(() => launched(log).length > 0))
  const [pid] = launched(log)
  const result = await run.exited
  assert.equal(result.code, 1)
  assert.match(result.stderr, /ERROR boom/)
  assert.ok(await until(() => !alive(pid)), 'the browser is gone')
})

stand('a stop during the browser launch closes the browser as soon as it starts', async () => {
  const dir = home()
  const log = join(dir, 'fake.log')
  const run = start(dir, 'wait', standEnv(dir, { launchMs: 1500 }))
  assert.ok(await until(() => count(log, 'launch-start') > 0))
  await sleep(300)
  run.child.kill('SIGTERM')
  const result = await run.exited
  assert.equal(result.code, 143)
  const [pid] = launched(log)
  assert.ok(pid, 'the browser did start')
  assert.ok(await until(() => !alive(pid)), 'the browser is gone')
  assert.equal(count(log, 'closed'), 1)
})

stand('a browser that will not close does not hold the stop past 5 s', async () => {
  const dir = home()
  const log = join(dir, 'fake.log')
  const run = start(dir, 'wait', standEnv(dir, { closeHang: true }))
  assert.ok(await until(() => launched(log).length > 0))
  await sleep(200)
  const began = Date.now()
  run.child.kill('SIGTERM')
  const result = await run.exited
  assert.equal(result.code, 143)
  assert.ok(Date.now() - began < 8000, 'exits within the limit')
})

stand('a second stop exits at once while the close is hung', async () => {
  const dir = home()
  const log = join(dir, 'fake.log')
  const run = start(dir, 'wait', standEnv(dir, { closeHang: true }))
  assert.ok(await until(() => launched(log).length > 0))
  await sleep(200)
  run.child.kill('SIGTERM')
  await sleep(300)
  const began = Date.now()
  run.child.kill('SIGINT')
  const result = await run.exited
  assert.equal(result.code, 130, 'the second signal sets the exit code')
  assert.ok(Date.now() - began < 2000, 'no wait for the 5 s limit')
})

stand('the call after a stopped call starts normally', async () => {
  const dir = home()
  const first = start(dir, 'wait', standEnv(dir))
  const log = join(dir, 'fake.log')
  assert.ok(await until(() => launched(log).length > 0))
  first.child.kill('SIGTERM')
  assert.equal((await first.exited).code, 143)
  const next = await start(dir, 'quick', standEnv(dir)).exited
  assert.equal(next.code, 0)
  assert.equal(next.stderr, '')
})

real('SIGTERM on a real run leaves no Chromium with the profile', async () => {
  const dir = home()
  const profile = join(dir, 'profiles', 'w2')
  const run = start(dir, 'wait', realEnv())
  assert.ok(await until(() => processesWith(profile).length > 0, 30000), 'Chromium started')
  await sleep(500)
  run.child.kill('SIGTERM')
  const result = await run.exited
  assert.equal(result.code, 143, result.stderr)
  assert.ok(await until(() => processesWith(profile).length === 0, 10000), 'no Chromium left')
})

real('a confirm() is dismissed by default and accepted only with CREW_ACCEPT_DIALOGS=1', async () => {
  const dir = home()
  const dismissed = await start(dir, 'dialog', realEnv()).exited
  assert.equal(dismissed.code, 0, dismissed.stderr)
  assert.match(dismissed.stdout, /TITLE done:false/)
  assert.match(dismissed.stderr, /dialog confirm dismissed/)
  const accepted = await start(dir, 'dialog', { ...realEnv(), CREW_ACCEPT_DIALOGS: '1' }).exited
  assert.equal(accepted.code, 0, accepted.stderr)
  assert.match(accepted.stdout, /TITLE done:true/)
  assert.match(accepted.stderr, /dialog confirm accepted/)
})
