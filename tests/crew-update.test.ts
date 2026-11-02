// `crew <key> update <taskId> <file|->` and the attach guard, run through crew.mjs against a fake board on
// localhost: no real board is touched and no browser starts. Run:
//   node --import tsx --test tests/crew-update.test.ts
// The child process is spawned asynchronously: the fake board lives in this process and must keep answering.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const CREW = join(process.cwd(), 'crew', 'crew.mjs')
const LIMIT = 200 * 1024

type Call = { name: string, auth: string | undefined, args: { id: string, body: string, visibility?: string } }
const calls: Call[] = []
let server: Server
let base = ''
const dirs: string[] = []

// The fake board answers every tool call with a success, or with an error when the task id starts with "bad".
before(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      raw += chunk
    })
    req.on('end', () => {
      const msg = JSON.parse(raw)
      const args = msg.params.arguments
      calls.push({ name: msg.params.name, auth: req.headers.authorization, args })
      if (String(args.id).startsWith('html')) {
        res.statusCode = 500
        res.setHeader('content-type', 'text/html')
        res.end('<html>oops</html>')
        return
      }
      if (String(args.id).startsWith('text')) {
        res.setHeader('content-type', 'text/plain')
        res.end('not json')
        return
      }
      const failed = String(args.id).startsWith('bad')
      // The board decides visibility: a customer contact's task is always customer-visible.
      const stored = String(args.id).startsWith('contact') ? 'customer' : args.visibility
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          isError: failed,
          content: [{ type: 'text', text: failed ? 'task not found' : JSON.stringify({ posted: true, update: { visibility: stored } }) }]
        }
      }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(() => {
  server.close()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

// A throwaway CREW_HOME with a crew.json and a creds.json that point at the fake board.
function home() {
  const dir = mkdtempSync(join(tmpdir(), 'crew-update-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'crew.json'), JSON.stringify({ board: { url: base } }))
  writeFileSync(join(dir, 'creds.json'), JSON.stringify({ base, team: { id: 't1' }, people: { w2: { apiKey: 'arn_fake_key_for_tests', email: 'w2@example.test', password: 'unused' } } }))
  return dir
}

// A file with the given bytes, in the test's own folder.
function file(dir: string, name: string, bytes: string | Buffer) {
  const path = join(dir, name)
  writeFileSync(path, bytes)
  return path
}

type Run = { status: number | null, stdout: string, stderr: string }

// Runs `crew w2 <args>` with the given stdin and CREW_HOME, and resolves with its exit code and output.
function crew(args: string[], options: { input?: string, dir?: string } = {}): Promise<Run> {
  const dir = options.dir ?? home()
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CREW, 'w2', ...args], { env: { ...process.env, CREW_HOME: dir } })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.stdin.on('error', () => {}) // a command that reads no stdin closes it early
    child.on('close', status => resolve({ status, stdout, stderr }))
    child.stdin.end(options.input ?? '')
  })
}

// The markdown that used to break the shell: quotes, backticks, a fence, a dollar, a backslash, unicode, CRLF.
const TRICKY = [
  '# Done: "quoted" and \'single\' ',
  '',
  'Ran `npm test` and got $HOME, \\ and a fence:',
  '',
  '```ts',
  'const a = "it\'s" // ünïcode ✓ 漢字 🤖',
  '```',
  '',
  'line with CRLF ending',
  ''
].join('\r\n')

test('a body file is posted byte-exact as one internal update by default', async () => {
  calls.length = 0
  const dir = home()
  const path = file(dir, 'body.md', TRICKY)
  const run = await crew(['update', 'task1', path], { dir })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'post_task_update')
  assert.equal(calls[0].auth, 'Bearer arn_fake_key_for_tests')
  assert.equal(calls[0].args.id, 'task1')
  assert.equal(calls[0].args.body, TRICKY)
  assert.equal(calls[0].args.visibility, 'internal')
  assert.equal(run.stdout, 'posted as internal\n')
})

test('a dash reads the body from stdin, byte-exact', async () => {
  calls.length = 0
  const run = await crew(['update', 'task1', '-'], { input: TRICKY })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].args.body, TRICKY)
  assert.equal(calls[0].args.visibility, 'internal')
})

test('the visibility flags: --customer posts for the customer, --internal says so explicitly', async () => {
  calls.length = 0
  const dir = home()
  const path = file(dir, 'note.md', 'For the customer.\n')
  assert.equal((await crew(['update', 'task1', path, '--customer'], { dir })).status, 0)
  assert.equal((await crew(['update', 'task1', path, '--internal'], { dir })).status, 0)
  assert.deepEqual(calls.map(call => call.args.visibility), ['customer', 'internal'])
})

test('the visibility flags cannot be combined, and an unknown flag is a usage error', async () => {
  calls.length = 0
  const dir = home()
  const path = file(dir, 'note.md', 'text\n')
  for (const flags of [['--internal', '--customer'], ['--public']]) {
    const run = await crew(['update', 'task1', path, ...flags], { dir })
    assert.equal(run.status, 64, `${flags.join(' ')} exited ${run.status}`)
    assert.match(run.stderr, /usage: crew <who> update/)
  }
  assert.equal(calls.length, 0)
})

test('a missing task id or file is a usage error', async () => {
  calls.length = 0
  assert.equal((await crew(['update'])).status, 64)
  assert.equal((await crew(['update', 'task1'])).status, 64)
  assert.equal(calls.length, 0)
})

test('an empty body is refused and nothing is posted', async () => {
  calls.length = 0
  const dir = home()
  const run = await crew(['update', 'task1', file(dir, 'empty.md', '  \n\t\n')], { dir })
  assert.equal(run.status, 65)
  assert.match(run.stderr, /empty/)
  const fromStdin = await crew(['update', 'task1', '-'], { input: '' })
  assert.equal(fromStdin.status, 65)
  assert.match(fromStdin.stderr, /empty/)
  assert.equal(calls.length, 0)
})

test('a body over 200 KB is refused with a clear message, and exactly 200 KB is still posted', async () => {
  calls.length = 0
  const dir = home()
  const over = await crew(['update', 'task1', file(dir, 'big.md', 'x'.repeat(LIMIT + 1))], { dir })
  assert.equal(over.status, 65)
  assert.match(over.stderr, /over 200 KB/)
  const overStdin = await crew(['update', 'task1', '-'], { input: 'x'.repeat(LIMIT + 1) })
  assert.equal(overStdin.status, 65)
  assert.match(overStdin.stderr, /over 200 KB/)
  assert.equal(calls.length, 0)

  const exact = await crew(['update', 'task1', file(dir, 'edge.md', 'x'.repeat(LIMIT))], { dir })
  assert.equal(exact.status, 0, exact.stderr)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].args.body.length, LIMIT)
})

test('a missing file gives a plain error and exit code 66, not a stack trace', async () => {
  calls.length = 0
  const run = await crew(['update', 'task1', join(tmpdir(), 'no-such-body-file-for-tests.md')])
  assert.equal(run.status, 66)
  assert.match(run.stderr, /cannot read .*no such file/)
  assert.doesNotMatch(run.stderr, /\n\s+at /)
  assert.equal(calls.length, 0)
})

test('a board refusal is reported and exits 1', async () => {
  calls.length = 0
  const dir = home()
  const run = await crew(['update', 'bad-task', file(dir, 'note.md', 'hello\n')], { dir })
  assert.equal(run.status, 1)
  assert.match(run.stdout + run.stderr, /task not found/)
})

test('attach refuses a missing image before a browser starts, with exit code 66', async () => {
  const run = await crew(['attach', 'task1', join(tmpdir(), 'no-such-image-for-tests.png')])
  assert.equal(run.status, 66)
  assert.match(run.stderr, /no such image/)
})

test('unknown flags, extra arguments and a repeated flag are usage errors, not silently dropped', async () => {
  calls.length = 0
  const dir = home()
  const path = file(dir, 'note.md', 'text\n')
  const cases = [['-customer'], ['--custmer'], ['extra'], ['--customer', '--customer']]
  for (const extra of cases) {
    const run = await crew(['update', 'task1', path, ...extra], { dir })
    assert.equal(run.status, 64, `${extra.join(' ')} exited ${run.status}`)
    assert.match(run.stderr, /usage: crew <who> update/)
  }
  const both = await crew(['update', 'task1', path, '--internal', '--customer'], { dir })
  assert.equal(both.status, 64)
  assert.equal(calls.length, 0)
})

test('the board prints the visibility it stored: staff internal, a customer contact always customer-visible', async () => {
  const dir = home()
  const path = file(dir, 'note.md', 'hello\n')
  assert.match((await crew(['update', 'task1', path], { dir })).stdout, /^posted as internal$/m)
  assert.match((await crew(['update', 'task1', path, '--customer'], { dir })).stdout, /^posted as customer$/m)
  assert.match((await crew(['update', 'contact-task', path], { dir })).stdout, /^posted as customer$/m)
})

test('a directory, a device and a FIFO are refused as not regular files, without hanging', async () => {
  const dir = home()
  for (const target of [dir, '/dev/zero']) {
    const run = await crew(['update', 'task1', target], { dir })
    assert.equal(run.status, 66, `${target} exited ${run.status}`)
    assert.match(run.stderr, /not a regular file/)
  }
  const fifo = join(dir, 'pipe.md')
  if (spawnSync('mkfifo', [fifo]).status !== 0) return // no mkfifo here: the device case above still covers the rule
  const run = await crew(['update', 'task1', fifo], { dir })
  assert.equal(run.status, 66)
  assert.match(run.stderr, /not a regular file/)
})

test('a symlink is refused, even one to a regular file', async () => {
  const dir = home()
  const target = file(dir, 'real.md', 'secret\n')
  const link = join(dir, 'link.md')
  symlinkSync(target, link)
  const run = await crew(['update', 'task1', link], { dir })
  assert.equal(run.status, 66)
  assert.match(run.stderr, /refusing to follow a symlink/)
})

test('invalid UTF-8 and NUL bytes are refused; a leading BOM is dropped and CRLF is kept', async () => {
  const dir = home()
  const bad = await crew(['update', 'task1', file(dir, 'bad.md', Buffer.from([0x61, 0xff, 0x62]))], { dir })
  assert.equal(bad.status, 65)
  assert.match(bad.stderr, /not valid UTF-8/)
  const nul = await crew(['update', 'task1', file(dir, 'nul.md', Buffer.from('a\u0000b'))], { dir })
  assert.equal(nul.status, 65)
  assert.match(nul.stderr, /NUL bytes/)
  calls.length = 0
  const bom = await crew(['update', 'task1', file(dir, 'bom.md', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hi\r\nthere\r\n')]))], { dir })
  assert.equal(bom.status, 0, bom.stderr)
  assert.equal(calls[0].args.body, 'hi\r\nthere\r\n')
})

test('stdin on a terminal is refused with exit 64 instead of waiting', async () => {
  if (spawnSync('script', ['--version']).error) return // no script(1) here: the rule is still in tm.mjs
  const dir = home()
  const run = spawnSync('script', ['-qec', `${process.execPath} ${CREW} w2 update task1 -`, '/dev/null'], {
    encoding: 'utf8',
    env: { ...process.env, CREW_HOME: dir },
    timeout: 30000
  })
  assert.notEqual(run.signal, 'SIGTERM', 'the command waited on the terminal')
  assert.match(run.stdout + run.stderr, /give the text on stdin/)
})

test('an unreachable board exits 69 with one plain line: no stack, no key, no address', async () => {
  const closed = await new Promise<number>((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as AddressInfo).port
      probe.close(() => resolve(port))
    })
  })
  const dir = mkdtempSync(join(tmpdir(), 'crew-update-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'crew.json'), JSON.stringify({}))
  writeFileSync(join(dir, 'creds.json'), JSON.stringify({ base: `http://127.0.0.1:${closed}`, team: { id: 't1' }, people: { w2: { apiKey: 'arn_fake_key_for_tests', email: 'w2@example.test', password: 'unused' } } }))
  const run = await crew(['update', 'task1', file(dir, 'note.md', 'hello\n')], { dir })
  assert.equal(run.status, 69)
  assert.match(run.stderr, /is unreachable: try again/)
  assert.doesNotMatch(run.stderr, /arn_fake|127\.0\.0\.1|\n\s+at /)
})

test('an HTTP error or a non-JSON reply exits 69 with a hint to try again, and no key', async () => {
  const dir = home()
  const path = file(dir, 'note.md', 'hello\n')
  const http = await crew(['update', 'html-task', path], { dir })
  assert.equal(http.status, 69)
  assert.match(http.stderr, /answered HTTP 500: try again/)
  assert.doesNotMatch(http.stderr, /arn_fake|\n\s+at /)
  const text = await crew(['update', 'text-task', path], { dir })
  assert.equal(text.status, 69)
  assert.match(text.stderr, /not JSON: try again/)
  assert.doesNotMatch(text.stderr, /arn_fake|\n\s+at /)
})

// The documents show the file form for a long update and never an inline JSON update as the example.
test('the kit documents show the body-file update as the default', () => {
  const docs: [string, RegExp][] = [
    ['CREW.md.tmpl', /node \{\{kit_dir\}\}\/crew\.mjs <you> update <taskId> /],
    ['PROMPTS.md.tmpl', /crew\.mjs W update <taskId> \{\{crew_dir\}\}\/work\/W\/update\.md/],
    ['README.md', /crew <who> update <taskId> /]
  ]
  for (const [name, form] of docs) {
    const text = readFileSync(join(process.cwd(), 'crew', name), 'utf8')
    assert.match(text, form, `${name} does not show the update file form`)
    assert.match(text, /longer than one line|from a file, not inline JSON/, `${name} does not say the file form is the default`)
    assert.doesNotMatch(text, /post_task_update '\{/, `${name} shows an inline JSON update as the example`)
  }
})
