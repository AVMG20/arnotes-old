// The delivery queue: one interface, two implementations. The contract runs against the in-memory queue always,
// and against RabbitMQ only when RABBITMQ_URL is set. The RabbitMQ run creates its own vhost through the
// management API, uses only that vhost, and deletes it at the end; it never touches the shared one. Without a
// reachable broker or management API the RabbitMQ part is skipped with a message.
// Also covered: the disposition rules, the size caps, the memory queue's clock and crash switches, the URL
// redaction, the reconnect logic against a fake connection, and which queue the factory gives out.
//   node --import tsx --test tests/github-delivery-queue.test.ts
//   RABBITMQ_URL=amqp://user:pw@127.0.0.1:5672/any node --import tsx --test tests/github-delivery-queue.test.ts
//   (the user needs the administrator tag: the test creates its vhost and its permissions)
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createAmqpDeliveryQueue } from '../server/utils/githubDeliveryQueueAmqp'
import type { AmqpDeliveryQueue, BrokerConnection } from '../server/utils/githubDeliveryQueueAmqp'
import { createMemoryDeliveryQueue } from '../server/utils/githubDeliveryQueueMemory'
import type { MemoryDeliveryQueue } from '../server/utils/githubDeliveryQueueMemory'
import {
  closeDeliveryQueue, cutReason, decide, deliveryQueueHealth, describeBrokerUrl, DeliveryQueueUnavailable, DeliveryTooLarge,
  DELIVERY_LIMIT, errorSummary, getDeliveryQueue, MAX_BODY_BYTES
} from '../server/utils/githubDeliveryQueue'
import type { ConsumeHandler, DeliveryQueue, Disposition, HandedMessage, QueueMessage } from '../server/utils/githubDeliveryQueue'

const BROKER_URL = (process.env.RABBITMQ_URL ?? '').trim()
const NO_BROKER = 'RABBITMQ_URL is not set: the RabbitMQ contract is skipped (set it to run against a broker)'

let counter = 0
function uid(prefix: string): string {
  counter += 1
  return `${prefix}-${process.pid}-${Date.now()}-${counter}`
}

function message(deliveryId: string, attempt = 0): QueueMessage {
  return { deliveryId, event: 'issues', attempt, body: Buffer.from(JSON.stringify({ id: deliveryId })) }
}

async function waitUntil(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

const never = (): Promise<Disposition> => new Promise<Disposition>(() => {})

/** Consumes; the handler for each delivery (n counts from 1) decides. Returns what it received and the stop function. */
// void is the handler that returns nothing: the adapter fails that delivery.
// eslint-disable-next-line @typescript-eslint/no-invalid-void-type
async function consumeWith(queue: DeliveryQueue, handler: (message: HandedMessage, n: number, context: { signal: AbortSignal }) => Disposition | void | Promise<Disposition | void>, handlerTimeoutMs?: number) {
  const received: HandedMessage[] = []
  const onMessage: ConsumeHandler = async (message, context) => {
    received.push(message)
    return handler(message, received.length, context)
  }
  const stop = await queue.consume(onMessage, { prefetch: 1, beforeFail: async () => {}, ...(handlerTimeoutMs ? { handlerTimeoutMs } : {}) })
  return { received, stop }
}

/** Acks everything in main, so a test starts from an empty main queue. */
async function drain(queue: DeliveryQueue): Promise<void> {
  const { stop } = await consumeWith(queue, () => 'ack')
  await waitUntil(async () => (await queue.depth()) === 0, 'the main queue to empty', 10_000)
  await new Promise(resolve => setTimeout(resolve, 50))
  await stop()
}

interface Suite {
  name: string
  make: () => Promise<DeliveryQueue>
  /** Set on the RabbitMQ suite: the crash tests run on real connections. */
  broker?: boolean
  skip?: string
}

function contract(suite: Suite, after_: () => Promise<void> = async () => {}): void {
  const register = suite.skip ? describe.skip : describe
  if (suite.skip) console.info(suite.skip)
  register(`delivery queue contract: ${suite.name}`, () => {
    const opened: DeliveryQueue[] = []
    after(async () => {
      for (const queue of opened) await queue.close()
      await after_()
    })

    async function fresh(): Promise<DeliveryQueue> {
      const queue = await suite.make()
      opened.push(queue)
      await drain(queue)
      return queue
    }

    test('a published message comes back with its fields and body; acked, it is gone', async () => {
      const queue = await fresh()
      const id = uid('round')
      await queue.publish('main', message(id, 2))
      const { received, stop } = await consumeWith(queue, () => 'ack')
      await waitUntil(() => received.length === 1, 'the message')
      await waitUntil(async () => (await queue.depth()) === 0, 'the acked message to leave')
      await stop()
      assert.equal(received[0]!.deliveryId, id)
      assert.equal(received[0]!.event, 'issues')
      assert.equal(received[0]!.attempt, 2)
      assert.equal(received[0]!.redelivered, false)
      assert.deepEqual(received[0]!.body, Buffer.from(JSON.stringify({ id })))
      await waitUntil(async () => (await queue.depth()) === 0, 'the acked message to leave')
    })

    test('a fail disposition moves the delivery to failed, not to main', async () => {
      const queue = await fresh()
      const failedBefore = await queue.failedDepth()
      await queue.publish('main', message(uid('fail')))
      const { received, stop } = await consumeWith(queue, () => ({ fail: 'body is not what we expect' }))
      await waitUntil(async () => (await queue.failedDepth()) === failedBefore + 1, 'the failed copy')
      await stop()
      assert.equal(received.length, 1)
      assert.equal(await queue.depth(), 0)
    })

    test('a retry disposition takes the delivery out of main for the retry wait', async () => {
      const queue = await fresh()
      await queue.publish('main', message(uid('retry')))
      const { received, stop } = await consumeWith(queue, () => ({ retry: 'retry30s', reason: 'queue busy' }))
      await waitUntil(() => received.length === 1, 'the delivery')
      await new Promise(resolve => setTimeout(resolve, 200))
      await stop()
      assert.equal(await queue.depth(), 0, 'it waits in the retry queue, not in main')
      assert.ok(await queue.failedDepth() >= 0)
    })

    test('a handler that returns nothing fails its delivery and does not stall the next one', async () => {
      const queue = await fresh()
      const first = uid('nothing-1')
      const second = uid('nothing-2')
      const failedBefore = await queue.failedDepth()
      await queue.publish('main', message(first, 2))
      await queue.publish('main', message(second))
      const { received, stop } = await consumeWith(queue, (m, n) => (n === 1 ? undefined : 'ack'))
      await waitUntil(() => received.length === 2, 'the second delivery')
      await stop()
      assert.equal(received[1]!.deliveryId, second)
      await waitUntil(async () => (await queue.failedDepth()) === failedBefore + 1, 'the first to fail')
    })

    test('a handler that throws fails its delivery: main ends empty, failed holds it', async () => {
      const queue = await fresh()
      const failedBefore = await queue.failedDepth()
      await queue.publish('main', message(uid('throws'), 2))
      const { received, stop } = await consumeWith(queue, () => {
        throw new Error('the handler broke')
      })
      await waitUntil(async () => (await queue.failedDepth()) === failedBefore + 1, 'the failed copy')
      await stop()
      assert.equal(received.length, 1, 'a thrown handler is not called again')
      assert.equal(await queue.depth(), 0)
    })

    test('a handler past its timeout fails its delivery, and the next one still runs', async () => {
      const queue = await fresh()
      const failedBefore = await queue.failedDepth()
      const second = uid('timeout-2')
      await queue.publish('main', message(uid('timeout-1'), 2))
      await queue.publish('main', message(second))
      const { received, stop } = await consumeWith(queue, (m, n) => (n === 1 ? never() : 'ack'), 100)
      await waitUntil(() => received.length === 2, 'the second delivery')
      await stop()
      assert.equal(received[1]!.deliveryId, second)
      await waitUntil(async () => (await queue.failedDepth()) === failedBefore + 1, 'the timed-out copy in failed')
    })

    test('a poison body (not JSON) is failed by the handler and never retried', async () => {
      const queue = await fresh()
      const failedBefore = await queue.failedDepth()
      await queue.publish('main', { deliveryId: uid('poison'), event: 'issues', attempt: 0, body: Buffer.from('{not json') })
      const { received, stop } = await consumeWith(queue, (m) => {
        try {
          JSON.parse(m.body.toString('utf8'))
          return 'ack'
        } catch {
          return { fail: 'body is not JSON' }
        }
      })
      await waitUntil(async () => (await queue.failedDepth()) === failedBefore + 1, 'the poison copy in failed')
      await stop()
      assert.equal(received.length, 1)
      assert.equal(await queue.depth(), 0)
    })

    test('prefetch 1: the second message waits until the first is settled', async () => {
      const queue = await fresh()
      const first = uid('pf1')
      const second = uid('pf2')
      await queue.publish('main', message(first))
      await queue.publish('main', message(second))
      let release!: (d: Disposition) => void
      const gate = new Promise<Disposition>((resolve) => {
        release = resolve
      })
      const { received, stop } = await consumeWith(queue, (m, n) => (n === 1 ? gate : 'ack'))
      await waitUntil(() => received.length >= 1, 'the first message')
      await new Promise(resolve => setTimeout(resolve, 150))
      assert.equal(received.length, 1, 'nothing else is handed out while one is in hand')
      release('ack')
      await waitUntil(() => received.length === 2, 'the second message')
      assert.equal(received[1]!.deliveryId, second)
      await stop()
    })

    test('stopping a consumer leaves the delivery in hand for redelivery', async () => {
      const queue = await fresh()
      const id = uid('stop')
      await queue.publish('main', message(id))
      const held = await consumeWith(queue, never)
      await waitUntil(() => held.received.length === 1, 'the message')
      await held.stop()
      const again = await consumeWith(queue, () => 'ack')
      await waitUntil(() => again.received.length === 1, 'the redelivery')
      await again.stop()
      assert.equal(again.received[0]!.deliveryId, id)
      assert.equal(again.received[0]!.redelivered, true)
    })

    test('a body over the cap is refused at publish, with its own error', async () => {
      const queue = await fresh()
      const big = { deliveryId: uid('big'), event: 'issues', attempt: 0, body: Buffer.alloc(MAX_BODY_BYTES + 1, 0x61) }
      await assert.rejects(queue.publish('main', big), DeliveryTooLarge)
      assert.equal(await queue.depth(), 0)
    })

    test('consume refuses any prefetch but 1', async () => {
      const queue = await fresh()
      await assert.rejects(queue.consume(async () => 'ack', { prefetch: 2 as 1 }), RangeError)
    })
  })
}

// The in-memory queue: always run.
contract({
  name: 'in-memory',
  make: async () => createMemoryDeliveryQueue({ manualClock: true })
})

// The RabbitMQ queue: its own vhost, created here and deleted at the end.
interface TestVhost { url: string, remove: () => Promise<void> }

async function probeBroker(): Promise<{ vhost: TestVhost } | { skip: string }> {
  if (!BROKER_URL) return { skip: NO_BROKER }
  const base = new URL(BROKER_URL)
  const user = decodeURIComponent(base.username)
  const password = decodeURIComponent(base.password)
  const management = process.env.RABBITMQ_MANAGEMENT_URL ?? `http://${base.hostname}:15672`
  const auth = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`
  const name = `arnotes-test-${process.pid}-${Date.now().toString(36)}`
  const api = (method: string, path: string, body?: unknown) => fetch(`${management}/api/${path}`, {
    method,
    headers: { 'authorization': auth, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  try {
    const created = await api('PUT', `vhosts/${name}`, {})
    if (!created.ok) return { skip: `the management API refused a test vhost (HTTP ${created.status}); the RabbitMQ contract is skipped` }
    const granted = await api('PUT', `permissions/${name}/${encodeURIComponent(user)}`, { configure: '.*', write: '.*', read: '.*' })
    if (!granted.ok) return { skip: `the management API refused the test permissions (HTTP ${granted.status}); the RabbitMQ contract is skipped` }
  } catch (error) {
    return { skip: `the management API is not reachable (${errorSummary(error)}); the RabbitMQ contract is skipped` }
  }
  const url = new URL(BROKER_URL)
  url.pathname = `/${name}`
  return {
    vhost: {
      url: url.toString(),
      remove: async () => {
        await api('DELETE', `vhosts/${name}`).catch(() => undefined)
      }
    }
  }
}

const probe = await probeBroker()
const testVhost = 'vhost' in probe ? probe.vhost : null
const brokerLabel = describeBrokerUrl(BROKER_URL || 'amqp://localhost')

contract({
  name: 'RabbitMQ',
  skip: testVhost ? undefined : ('skip' in probe ? probe.skip : NO_BROKER),
  broker: true,
  make: async () => createAmqpDeliveryQueue({ url: testVhost!.url, label: brokerLabel, log: line => console.info(line) })
}, async () => {
  // the test vhost is removed at the end of the file
})

if (testVhost) {
  describe('RabbitMQ: crashes on real connections', () => {
    const opened: AmqpDeliveryQueue[] = []
    after(async () => {
      for (const queue of opened) await queue.close()
      // the test vhost is removed at the end of the file
    })

    function connect(): AmqpDeliveryQueue {
      const queue = createAmqpDeliveryQueue({ url: testVhost.url, label: brokerLabel, log: line => console.info(line) })
      opened.push(queue)
      return queue
    }

    test('a process that dies with a delivery in hand: the broker redelivers it to the next consumer', async () => {
      const dying = connect()
      const id = uid('crash-real')
      await dying.publish('main', message(id))
      const seen: string[] = []
      await dying.consume((m) => {
        seen.push(m.deliveryId)
        return never()
      }, { prefetch: 1, beforeFail: async () => {} })
      await waitUntil(() => seen.length === 1, 'the delivery in hand')
      dying.crashForTest()
      await dying.close()
      const survivor = connect()
      const { received, stop } = await consumeWith(survivor, () => 'ack')
      await waitUntil(() => received.length === 1, 'the redelivery')
      await stop()
      assert.equal(received[0]!.deliveryId, id)
      assert.equal(received[0]!.redelivered, true)
    })
  })
}

// The memory queue's own behaviour: the clock, the crash switches, the dispositions, the limits.
describe('in-memory queue: clock, crashes, dispositions and limits', () => {
  const opened: MemoryDeliveryQueue[] = []
  const lines: string[] = []
  after(async () => {
    for (const queue of opened) await queue.close()
  })
  function fresh(): MemoryDeliveryQueue {
    const queue = createMemoryDeliveryQueue({ manualClock: true, log: line => lines.push(line) })
    opened.push(queue)
    return queue
  }

  test('a retry waits 30 s on the clock, then comes back to main with its attempt count and reason', async () => {
    const queue = fresh()
    await queue.publish('main', message('retry-30', 1))
    const { received, stop } = await consumeWith(queue, () => ({ retry: 'retry30s', reason: 'database busy' }))
    await waitUntil(() => queue.peek('retry30s').length === 1, 'the retry copy')
    await waitUntil(() => received.length === 1, 'the delivery')
    await stop()
    assert.equal(await queue.depth(), 0)
    const waiting = queue.peek('retry30s')
    assert.equal(waiting.length, 1)
    assert.equal(waiting[0]!.attempt, 2, 'a retry is published with one more attempt')
    assert.equal(waiting[0]!.reason, 'database busy')
    queue.advance(29_999)
    assert.equal(await queue.depth(), 0)
    queue.advance(1)
    assert.equal(await queue.depth(), 1)
  })

  test('the 2 minute retry waits 120 s', async () => {
    const queue = fresh()
    await queue.publish('retry2m', message('retry-2m'))
    queue.advance(119_999)
    assert.equal(await queue.depth(), 0)
    queue.advance(1)
    assert.equal(await queue.depth(), 1)
  })

  test('a fail disposition keeps the reason, cut to one line and never more than 200 characters', async () => {
    const queue = fresh()
    await queue.publish('main', message('reason-1'))
    const { received, stop } = await consumeWith(queue, () => ({ fail: `first line\nsecond ${'x'.repeat(500)}` }))
    await waitUntil(async () => (await queue.failedDepth()) === 1, 'the failed copy')
    await stop()
    assert.equal(received.length, 1)
    const [copy] = queue.peek('failed')
    assert.equal(copy!.reason!.includes('\n'), false)
    assert.equal(copy!.reason!.length, 200)
    assert.equal(copy!.body, JSON.stringify({ id: 'reason-1' }), 'the payload is kept for the record')
  })

  test('ordering: the handler\'s effects happen while the delivery is still unacked, the ack comes after', async () => {
    const queue = fresh()
    await queue.publish('main', message('order-1'))
    const steps: string[] = []
    const { received, stop } = await consumeWith(queue, async () => {
      steps.push(`unacked during effect: ${queue.unackedCount()}`)
      await new Promise(resolve => setTimeout(resolve, 20))
      steps.push('effect done')
      return 'ack'
    })
    await waitUntil(() => received.length === 1 && queue.unackedCount() === 0, 'the ack')
    await stop()
    assert.deepEqual(steps, ['unacked during effect: 1', 'effect done'])
  })

  test('a crash between the effect and the ack: the ack throws, and the next consume sees the delivery again', async () => {
    const queue = fresh()
    lines.length = 0
    await queue.publish('main', message('crash-ack'))
    queue.crashAfter('ack')
    const first = await consumeWith(queue, () => 'ack')
    await waitUntil(() => lines.some(line => line.includes('was not settled')), 'the settle error')
    assert.ok(lines.some(line => line.includes('crash-ack') && line.includes('DeliveryQueueUnavailable')), `the error is named by class: ${lines.join(' | ')}`)
    await first.stop()
    const again = await consumeWith(queue, () => 'ack')
    await waitUntil(() => again.received.length === 1, 'the redelivery')
    await again.stop()
    assert.equal(again.received[0]!.redelivered, true)
  })

  test('a delivery handed out past the delivery limit goes to failed, not back to a consumer', async () => {
    const queue = fresh()
    await queue.publish('main', message('limit-1'))
    for (let i = 0; i < DELIVERY_LIMIT; i++) {
      const held = await consumeWith(queue, never)
      await waitUntil(() => held.received.length === 1, `delivery ${i + 1}`)
      await held.stop()
    }
    const after_ = await consumeWith(queue, () => 'ack')
    await waitUntil(async () => (await queue.failedDepth()) === 1, 'the limit copy')
    await after_.stop()
    assert.equal(after_.received.length, 0)
    assert.equal(queue.peek('failed')[0]!.reason, 'delivery limit')
  })

  test('the size cap is checked on consume too: an oversize delivery is failed, not handed out', async () => {
    const queue = fresh()
    await queue.publish('main', message('size-1'))
    queue.setMaxBodyBytes(4)
    const { received, stop } = await consumeWith(queue, () => 'ack')
    await waitUntil(async () => (await queue.failedDepth()) === 1, 'the size copy')
    await stop()
    assert.equal(received.length, 0)
    assert.equal(queue.peek('failed')[0]!.reason, 'body over size cap')
  })

  test('a handler past its timeout is aborted, and its late answer is discarded with one line', async () => {
    const queue = fresh()
    await queue.publish('main', message('late-1', 2))
    let aborted = false
    const stop = await queue.consume(async (_m, context) => {
      context.signal.addEventListener('abort', () => {
        aborted = true
      })
      await new Promise(resolve => setTimeout(resolve, 150))
      return 'ack'
    }, { prefetch: 1, beforeFail: async () => {}, handlerTimeoutMs: 30 })
    await waitUntil(async () => (await queue.failedDepth()) === 1, 'the timed-out copy')
    await waitUntil(() => lines.some(line => line.includes('answered after its timeout')), 'the late answer line')
    await stop()
    assert.equal(aborted, true)
    assert.equal(await queue.depth(), 0)
    assert.equal(lines.filter(line => line.includes('late-1') && line.includes('answered after its timeout')).length, 1)
  })
  test('a drop without a consumer keeps the messages; the next consume sees them again', async () => {
    const queue = fresh()
    await queue.publish('main', message('after-drop'))
    queue.dropConnection()
    const { received, stop } = await consumeWith(queue, () => 'ack')
    await waitUntil(() => received.length === 1, 'the kept message')
    await stop()
    assert.equal(received[0]!.deliveryId, 'after-drop')
  })
})

describe('decide: every outcome becomes a disposition', () => {
  const quiet = (): void => {}
  const deliver = { deliveryId: 'decide-1', event: 'issues', attempt: 0, body: Buffer.from('{}'), redelivered: false, deliveries: 1 }
  const options = { timeoutMs: 1_000, maxBodyBytes: MAX_BODY_BYTES }
  test('ack, retry and fail pass through; a bad answer, a throw and a timeout fail', async () => {
    assert.equal(await decide(() => 'ack', deliver, options, quiet), 'ack')
    assert.deepEqual(await decide(() => ({ retry: 'retry2m', reason: 'x' }), deliver, options, quiet), { retry: 'retry2m', reason: 'x' })
    assert.deepEqual(await decide(() => ({ fail: 'y' }), deliver, options, quiet), { fail: 'y' })
    assert.deepEqual(await decide(() => undefined, deliver, options, quiet), { retry: 'retry30s', reason: 'handler error' })
    assert.deepEqual(await decide(() => ({ nonsense: true }) as unknown as Disposition, deliver, options, quiet), { retry: 'retry30s', reason: 'handler error' })
    const thrower = (): never => {
      throw new Error('boom')
    }
    assert.deepEqual(await decide(thrower, deliver, options, quiet), { retry: 'retry30s', reason: 'handler error' })
    assert.deepEqual(await decide(() => never(), deliver, { ...options, timeoutMs: 20 }, quiet), { retry: 'retry30s', reason: 'handler timeout' })
    // On the last attempt the same timeout is recorded and failed.
    assert.deepEqual(await decide(() => never(), { ...deliver, attempt: 2 }, { ...options, timeoutMs: 20 }, quiet), { fail: 'handler timeout' })
  })

  test('the log names the delivery and the class only, never the message', async () => {
    const logged: string[] = []
    const thrower = (): never => {
      throw new TypeError('secret detail amqp://u:pw@h')
    }
    await decide(thrower, deliver, options, line => logged.push(line))
    assert.equal(logged.length, 1)
    assert.ok(logged[0]!.includes('decide-1') && logged[0]!.includes('TypeError'))
    assert.ok(!logged[0]!.includes('secret detail') && !logged[0]!.includes('pw@'))
  })
})

describe('the broker URL is never printed', () => {
  const SECRET = 'pw-s3cret-value'

  test('describeBrokerUrl keeps the host, port and vhost and drops the user and password', () => {
    assert.equal(describeBrokerUrl(`amqp://arnotes:${SECRET}@127.0.0.1:5672/vhost`), 'amqp://***@127.0.0.1:5672/vhost')
    assert.equal(describeBrokerUrl(`amqp://arnotes:${SECRET}@broker.internal`), 'amqp://***@broker.internal:5672/')
    assert.equal(describeBrokerUrl(`amqps://arnotes:${SECRET}@broker.internal/prod`), 'amqps://***@broker.internal:5671/prod')
    assert.ok(!describeBrokerUrl(`amqp://arnotes:${SECRET}@127.0.0.1`).includes(SECRET))
  })

  test('input that does not parse is not echoed', () => {
    assert.equal(describeBrokerUrl(`not a url ${SECRET}`), 'amqp://***')
    assert.equal(describeBrokerUrl(`http://arnotes:${SECRET}@host`), 'amqp://***')
  })

  test('errors are summarised by class and code, never by message', () => {
    const error = Object.assign(new Error(`connect failed for amqp://arnotes:${SECRET}@127.0.0.1`), { code: 'ECONNREFUSED' })
    assert.equal(errorSummary(error), 'Error ECONNREFUSED')
    assert.equal(errorSummary(new TypeError(`amqp://arnotes:${SECRET}@h`)), 'TypeError')
    assert.equal(errorSummary(Object.assign(new Error('x'), { code: `amqp://${SECRET}` })), 'Error')
    assert.equal(errorSummary('a string'), 'non-Error')
  })

  test('a reason is one line, cut', () => {
    assert.equal(cutReason('a\nb\tc'), 'a b c')
    assert.equal(cutReason('z'.repeat(999)).length, 200)
  })
})

describe('reconnect logic against a fake connection', () => {
  const SECRET = 'fake-pw-123'
  const URL_WITH_SECRET = `amqp://arnotes:${SECRET}@127.0.0.1:5672/arnotes`

  /** Emits the events of the real client and records what the adapter declares. */
  class FakeConnection {
    readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    readonly declared: string[] = []
    reachable = false
    on(name: string, listener: (...args: unknown[]) => void): this {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener])
      return this
    }

    emit(name: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(name) ?? []) listener(...args)
    }

    async exchangeDeclare(params: { exchange: string }): Promise<void> {
      this.refuseIfDown()
      this.declared.push(params.exchange)
    }

    async queueDeclare(params: { queue: string }): Promise<{ messageCount: number }> {
      this.refuseIfDown()
      this.declared.push(params.queue)
      return { messageCount: 0 }
    }

    async queueBind(): Promise<void> {
      this.refuseIfDown()
      this.declared.push('binding')
    }

    createPublisher(): { send: () => Promise<void>, close: () => Promise<void> } {
      return { send: async () => {}, close: async () => {} }
    }

    createConsumer(): { on: () => void, close: () => Promise<void> } {
      return { on: () => {}, close: async () => {} }
    }

    async close(): Promise<void> {}

    private refuseIfDown(): void {
      if (!this.reachable) throw Object.assign(new Error(`connect ${URL_WITH_SECRET}`), { code: 'ECONNREFUSED' })
    }
  }

  test('unreachable: publish answers unavailable; one line per state change; reconnect re-declares; no secret in any line', async () => {
    const fake = new FakeConnection()
    const lines: string[] = []
    const queue = createAmqpDeliveryQueue({
      url: URL_WITH_SECRET,
      label: describeBrokerUrl(URL_WITH_SECRET),
      log: line => lines.push(line),
      connect: () => fake as unknown as BrokerConnection,
      connectWaitMs: 20
    })
    assert.equal(queue.status().state, 'idle')

    await assert.rejects(queue.publish('main', message('reconnect-1')), DeliveryQueueUnavailable)
    assert.equal(lines.length, 1)
    assert.match(lines[0]!, /connecting to amqp:\/\/\*\*\*@127\.0\.0\.1:5672\/arnotes/)

    const refused = Object.assign(new Error(`refused ${URL_WITH_SECRET}`), { code: 'ECONNREFUSED' })
    fake.emit('error', refused)
    fake.emit('error', refused)
    fake.emit('error', refused)
    assert.equal(queue.status().state, 'reconnecting')
    assert.equal(lines.length, 2, 'the failed attempts after the first are not logged')
    assert.match(lines[1]!, /unreachable.*\(Error ECONNREFUSED\)/)

    fake.reachable = true
    fake.emit('connection')
    assert.equal(queue.status().state, 'connected')
    assert.match(lines[2]!, /reconnected to amqp:\/\/\*\*\*@/)
    await queue.publish('main', message('reconnect-2'))
    const declaredOnce = fake.declared.length
    assert.equal(declaredOnce, 1 + 4 + 1, 'the exchange, the four queues and the binding')

    fake.emit('error', refused)
    fake.emit('connection')
    await queue.publish('main', message('reconnect-3'))
    assert.equal(fake.declared.length, declaredOnce * 2, 'the topology is declared again after a reconnect')

    await queue.close()
    assert.equal(queue.status().state, 'closed')
    for (const line of lines) assert.ok(!line.includes(SECRET) && !line.includes('arnotes:'), `no credentials in: ${line}`)
    assert.equal(lines.length, 6)
  })

  test('a synchronous throw while opening the connection is summarised, not raised raw', async () => {
    const queue = createAmqpDeliveryQueue({
      url: 'amqp://arnotes:x@127.0.0.1:5672/arnotes',
      label: describeBrokerUrl('amqp://arnotes:x@127.0.0.1:5672/arnotes'),
      log: () => {},
      connect: () => {
        throw Object.assign(new TypeError(`Invalid URL ${SECRET}`), { code: 'ERR_INVALID_URL' })
      },
      connectWaitMs: 20
    })
    const error = await queue.publish('main', message('throw-1')).catch((e: unknown) => e)
    assert.ok(error instanceof DeliveryQueueUnavailable)
    assert.ok(!(error as Error).message.includes(SECRET))
  })
})

describe('size cap on publish: no broker needed', () => {
  test('an oversize body is refused before any connection is opened', async () => {
    const queue = createAmqpDeliveryQueue({ url: 'amqp://127.0.0.1:1/none', label: 'amqp://***@127.0.0.1:1/none', log: () => {} })
    await assert.rejects(queue.publish('main', { deliveryId: 'big', event: 'issues', attempt: 0, body: Buffer.alloc(MAX_BODY_BYTES + 1) }), DeliveryTooLarge)
    await queue.close()
  })
})

after(async () => {
  await testVhost?.remove()
})

describe('RabbitMQ adapter against a fake broker: topology failures and the requeue pause', () => {
  const SECRET_URL = 'amqp://arnotes:topo-secret@127.0.0.1:5672/arnotes'

  /** A broker whose declarations can be made to fail, and whose publisher can refuse a copy. */
  class FailingBroker {
    failOn: string | null = null
    sendFails = false
    consumerCallback: ((message: unknown) => Promise<number>) | null = null
    private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    on(name: string, listener: (...args: unknown[]) => void): this {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener])
      return this
    }

    emit(name: string): void {
      for (const listener of this.listeners.get(name) ?? []) listener()
    }

    async exchangeDeclare(): Promise<void> {}

    async queueDeclare(params: { queue: string }): Promise<{ messageCount: number }> {
      if (params.queue === this.failOn) {
        throw Object.assign(new Error(`PRECONDITION_FAILED for ${params.queue} at ${SECRET_URL}`), { code: 'PRECONDITION_FAILED' })
      }
      return { messageCount: 0 }
    }

    async queueBind(): Promise<void> {}

    createPublisher(): { send: () => Promise<void>, close: () => Promise<void> } {
      return {
        send: async () => {
          if (this.sendFails) throw Object.assign(new Error('nacked'), { code: 'NACK' })
        },
        close: async () => {}
      }
    }

    createConsumer(_props: unknown, callback: (message: unknown) => Promise<number>): { on: () => void, close: () => Promise<void> } {
      this.consumerCallback = callback
      return { on: () => {}, close: async () => {} }
    }

    async close(): Promise<void> {}
  }

  function adapterOn(broker: FailingBroker, lines: string[], extra: { retryBaseMs?: number, requeueDelayMs?: number } = {}): DeliveryQueue {
    return createAmqpDeliveryQueue({
      url: SECRET_URL,
      label: describeBrokerUrl(SECRET_URL),
      log: line => lines.push(line),
      connect: () => {
        // The client reports the connection after the adapter has attached its listeners.
        setTimeout(() => broker.emit('connection'), 5)
        return broker as unknown as BrokerConnection
      },
      connectWaitMs: 200,
      ...extra
    })
  }

  test('a declaration that fails: one line per distinct failure, unavailable with the detail, then recovery after the backoff', async () => {
    const broker = new FailingBroker()
    broker.failOn = 'github.deliveries'
    const lines: string[] = []
    const queue = adapterOn(broker, lines, { retryBaseMs: 30 })
    await assert.rejects(queue.publish('main', message('topo-1')), DeliveryQueueUnavailable)
    await assert.rejects(queue.publish('main', message('topo-2')), DeliveryQueueUnavailable)
    const status = queue.status()
    assert.equal(status.state, 'unavailable')
    assert.match(status.detail ?? '', /github\.deliveries: Error PRECONDITION_FAILED/)
    assert.equal(lines.filter(line => line.includes('topology not declared')).length, 1, 'one line for the distinct failure')
    for (const line of lines) assert.ok(!line.includes('topo-secret') && !line.includes('arnotes:'), `no credentials in: ${line}`)

    broker.failOn = null
    await new Promise(resolve => setTimeout(resolve, 150))
    await queue.publish('main', message('topo-3'))
    assert.equal(queue.status().state, 'connected')
    assert.equal(queue.status().detail, undefined)
    assert.ok(lines.some(line => line.includes('topology declared at')), 'the recovery is logged once')
    await queue.close()
  })

  test('a copy that is not confirmed: the delivery goes back after the pause, the handler does not run again at once, the line names the id', async () => {
    const broker = new FailingBroker()
    broker.sendFails = true
    const lines: string[] = []
    const queue = adapterOn(broker, lines, { requeueDelayMs: 60 })
    let calls = 0
    await queue.consume(async () => {
      calls += 1
      return { fail: 'bad body' }
    }, { prefetch: 1, beforeFail: async () => {} })
    assert.ok(broker.consumerCallback)
    const started = Date.now()
    const status = await broker.consumerCallback!({
      messageId: 'pause-1',
      type: 'issues',
      headers: { attempt: 0 },
      rawBody: Buffer.from('{}'),
      redelivered: false
    })
    assert.equal(status, 1, 'REQUEUE')
    assert.ok(Date.now() - started >= 50, 'the requeue waits')
    assert.equal(calls, 1)
    assert.ok(lines.some(line => line.includes('pause-1') && line.includes('could not be moved')))
    await queue.close()
  })
})
describe('the factory: which queue is given out', () => {
  const keys = ['RABBITMQ_URL', 'NODE_ENV'] as const
  let saved: Record<string, string | undefined> = {}

  function setEnv(values: Partial<Record<(typeof keys)[number], string>>): void {
    for (const key of keys) {
      saved[key] ??= process.env[key]
      const value = values[key]
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = value
    }
  }

  async function restore(): Promise<void> {
    await closeDeliveryQueue()
    for (const key of keys) {
      if (!(key in saved)) continue
      if (saved[key] === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = saved[key]
    }
    saved = {}
  }

  after(restore)

  test('no RABBITMQ_URL in production: unavailable, and the health check says so without throwing', async () => {
    setEnv({ NODE_ENV: 'production' })
    assert.throws(() => getDeliveryQueue(), DeliveryQueueUnavailable)
    const health = await deliveryQueueHealth()
    assert.equal(health.state, 'unavailable')
    assert.equal(health.depth, null)
    assert.equal(health.failed, null)
    await restore()
  })

  test('no RABBITMQ_URL and NODE_ENV unset: unavailable, never memory', async () => {
    setEnv({})
    assert.throws(() => getDeliveryQueue(), DeliveryQueueUnavailable)
    await restore()
  })

  test('no RABBITMQ_URL in development or test: the in-memory queue', async () => {
    setEnv({ NODE_ENV: 'test' })
    assert.equal(getDeliveryQueue().kind, 'memory')
    await restore()
    setEnv({ NODE_ENV: 'development' })
    assert.equal(getDeliveryQueue().kind, 'memory')
    await restore()
  })

  test('RABBITMQ_URL set: RabbitMQ, connecting lazily (no broker is dialled here)', async () => {
    setEnv({ NODE_ENV: 'production', RABBITMQ_URL: 'amqp://arnotes:factory-pw@127.0.0.1:5672/arnotes' })
    const queue = getDeliveryQueue()
    assert.equal(queue.kind, 'rabbitmq')
    assert.equal(queue.status().state, 'idle')
    assert.equal(queue.status().broker, 'amqp://***@127.0.0.1:5672/arnotes')
    await restore()
  })
})
