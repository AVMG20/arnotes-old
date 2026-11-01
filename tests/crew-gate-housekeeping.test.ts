// Shutdown flush deadline, background prune, and counting of failed closing-row writes. Offline:
// the database writers are stubs, and the timers are injected where a test needs to see them.
//   node --import tsx --test tests/crew-gate-housekeeping.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { closingWriter } from '../server/utils/auditRouting'
import { flushWithDeadline, SHUTDOWN_FLUSH_MS, type DeadlineTimers } from '../server/utils/shutdownFlush'
import { throttledTask } from '../server/utils/periodicTask'

const never = () => new Promise<void>(() => {})
const tick = () => new Promise(resolve => setImmediate(resolve))

// Timers that record what was set and cleared, so a test can see the deadline was cleared.
function spyTimers() {
  const set: Array<{ ms: number, fire: () => void, handle: object }> = []
  const cleared: unknown[] = []
  const timers: DeadlineTimers = {
    set: (run, ms) => {
      const handle = {}
      set.push({ ms, fire: run, handle })
      return handle
    },
    clear: (handle) => {
      cleared.push(handle)
    }
  }
  return { timers, set, cleared }
}

test('a flush that never resolves is given up at the deadline, with one line saying so', async () => {
  const lines: string[] = []
  const spy = spyTimers()
  const pending = flushWithDeadline(never, 2_000, line => lines.push(line), spy.timers)
  // The deadline fires; nothing else is needed to end the wait.
  assert.equal(spy.set.length, 1)
  assert.equal(spy.set[0]?.ms, 2_000)
  spy.set[0]?.fire()
  assert.equal(await pending, 'timeout')
  assert.equal(lines.length, 1)
  assert.match(lines[0] ?? '', /timed out after 2000 ms/)
  assert.equal(spy.cleared.length, 1, 'the deadline timer is cleared after it fired')
})

test('the shutdown deadline is two seconds', () => {
  assert.equal(SHUTDOWN_FLUSH_MS, 2_000)
})

test('a real never-resolving flush returns within about two seconds and reports the timeout', async () => {
  const lines: string[] = []
  const started = Date.now()
  const outcome = await flushWithDeadline(never, SHUTDOWN_FLUSH_MS, line => lines.push(line))
  const took = Date.now() - started
  assert.equal(outcome, 'timeout')
  assert.ok(took >= SHUTDOWN_FLUSH_MS - 50 && took < SHUTDOWN_FLUSH_MS + 500, `took ${took} ms`)
  assert.equal(lines.length, 1)
})

test('a flush that finishes in time reports done, logs nothing, and clears its timer', async () => {
  const lines: string[] = []
  const spy = spyTimers()
  const outcome = await flushWithDeadline(async () => {}, 2_000, line => lines.push(line), spy.timers)
  assert.equal(outcome, 'done')
  assert.equal(lines.length, 0)
  assert.equal(spy.cleared.length, 1, 'the deadline timer is cleared, so it cannot keep the process alive')
})

test('a flush that fails reports failed and logs one line', async () => {
  const lines: string[] = []
  const outcome = await flushWithDeadline(async () => {
    throw new Error('database down')
  }, 2_000, line => lines.push(line))
  assert.equal(outcome, 'failed')
  assert.equal(lines.length, 1)
  assert.doesNotMatch(lines[0] ?? '', /database down/, 'the log line does not repeat the driver error')
})

test('a background task never holds the caller: a never-finishing prune returns at once', () => {
  let started = 0
  const prune = throttledTask(3_600_000, async () => {
    started++
    await never()
  })
  prune.trigger(1_000)
  assert.equal(started, 1)
  assert.equal(prune.runs, 1)
})

test('the background task runs at most once per interval, and not again while running', async () => {
  let started = 0
  const prune = throttledTask(1_000, async () => {
    started++
    await tick()
  })
  prune.trigger(0)
  prune.trigger(10)
  prune.trigger(500)
  assert.equal(started, 1, 'no second run while the first is still going or inside the interval')
  await tick()
  await tick()
  prune.trigger(1_500)
  assert.equal(started, 2, 'a run starts again once the interval has passed and the last one is done')
})

test('a failing background task is counted and never thrown', async () => {
  const prune = throttledTask(1_000, async () => {
    throw new Error('delete failed')
  })
  prune.trigger(0)
  await tick()
  await tick()
  assert.equal(prune.failures, 1)
  assert.equal(prune.runs, 1)
})

test('a failed closing-row write is counted and does not throw, so the refusal is still answered', async () => {
  let counted = 0
  const writer = closingWriter(async () => {
    throw new Error('insert failed')
  }, () => {
    counted++
  })
  await writer({ outcome: 'bad key' })
  assert.equal(counted, 1)
})

test('a successful closing-row write is not counted', async () => {
  const written: unknown[] = []
  let counted = 0
  const writer = closingWriter(async (row: unknown) => {
    written.push(row)
  }, () => {
    counted++
  })
  await writer({ outcome: 'bad key' })
  assert.deepEqual(written, [{ outcome: 'bad key' }])
  assert.equal(counted, 0)
})
