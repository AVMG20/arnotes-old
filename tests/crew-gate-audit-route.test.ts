// Where a refused call's audit row goes. The row of a call that closes the crew API window is
// written at once, even when the queue is full; ordinary rows wait in the queue or are dropped and
// counted. Pure: the database writer is a stub that records what it was given.
//   node --import tsx --test tests/crew-gate-audit-route.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recordAudit, type AuditSink } from '../server/utils/auditRouting'
import { BoundedQueue } from '../server/utils/boundedQueue'

interface Row { peer: string, outcome: string, path: string }

function sinkWith(max: number) {
  const written: Row[] = []
  const sink: AuditSink<Row> = {
    queue: new BoundedQueue<Row>(max),
    writeDirect: async (row) => {
      written.push(row)
    }
  }
  return { sink, written }
}

const row = (outcome: string, peer = 'unix (client 203.0.113.7)'): Row => ({ peer, outcome, path: '/api/crews/x' })

test('a closing refusal is written at once even when the queue is full', async () => {
  const { sink, written } = sinkWith(3)
  for (let i = 0; i < 3; i++) sink.queue.push(row('remote, window closed'))
  assert.equal(sink.queue.length, 3, 'the queue is full')

  const route = await recordAudit(sink, row('bad key'), true)

  assert.equal(route, 'direct')
  assert.equal(written.length, 1, 'the closing row was written')
  assert.equal(written[0]?.outcome, 'bad key', 'with the outcome that closed the window')
  assert.equal(written[0]?.peer, 'unix (client 203.0.113.7)', 'with the peer label, client included')
  assert.equal(sink.queue.length, 3, 'the closing row did not go into the queue')
  assert.equal(sink.queue.dropped, 0, 'and was not counted as dropped')
})

test('an ordinary refusal on a full queue is dropped and counted, never written directly', async () => {
  const { sink, written } = sinkWith(2)
  sink.queue.push(row('remote, window closed'))
  sink.queue.push(row('remote, window closed'))

  const route = await recordAudit(sink, row('remote, window closed'), false)

  assert.equal(route, 'dropped')
  assert.equal(written.length, 0)
  assert.equal(sink.queue.dropped, 1)
})

test('an ordinary refusal with room is queued for the batch', async () => {
  const { sink, written } = sinkWith(2)
  const route = await recordAudit(sink, row('remote, window closed'), false)
  assert.equal(route, 'queued')
  assert.equal(written.length, 0)
  assert.equal(sink.queue.length, 1)
})

test('a closing refusal after the queue overflowed still gets its own row, in order', async () => {
  const { sink, written } = sinkWith(1)
  for (let i = 0; i < 5; i++) await recordAudit(sink, row(`flood ${i}`), false)
  assert.equal(sink.queue.dropped, 4)

  await recordAudit(sink, row('bad key'), true)
  assert.deepEqual(written.map(r => r.outcome), ['bad key'])
  assert.deepEqual(sink.queue.drain().map(r => r.outcome), ['flood 0'], 'the queued row is still there')
})
