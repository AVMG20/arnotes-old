// Stand-in for the playwright module in the crew tm.mjs tests: the browser is a child process that
// exits when its stdin pipe closes, unless FAKE_IGNORE_PIPE=1 (then only close() stops it). Each
// launch, close and exit is written to FAKE_LOG as "<event> <pid>".
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'

const log = (event, pid = '') => appendFileSync(process.env.FAKE_LOG, `${event} ${pid}\n`)

const CHILD = `
  if (!process.env.FAKE_IGNORE_PIPE) process.stdin.on('end', () => process.exit(0))
  process.stdin.resume()
  setInterval(() => {}, 1000)
`

export const chromium = {
  async launchPersistentContext() {
    log('launch-start')
    await new Promise(resolve => setTimeout(resolve, Number(process.env.FAKE_LAUNCH_MS || 0)))
    const child = spawn(process.execPath, ['-e', CHILD], { stdio: ['pipe', 'ignore', 'ignore'] })
    log('launched', child.pid)
    let closed = false
    const exited = new Promise(resolve => child.on('exit', resolve))
    return {
      request: {
        get: async () => ({ json: async () => ({ user: { id: 'scratch' } }) }),
        post: async () => ({ status: () => 200 })
      },
      pages: () => [],
      on() {},
      newPage: async () => ({}),
      async close() {
        if (closed) return
        closed = true
        log('close-called', child.pid)
        if (process.env.FAKE_CLOSE_HANG) return new Promise(() => {})
        child.kill('SIGTERM')
        await exited
        log('closed', child.pid)
      }
    }
  }
}
