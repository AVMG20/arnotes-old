// The reviewer's view of the crew: column counts, who holds what, and the newest status
// update. Read-only. Run: node watch.mjs
import { loadCreds } from './config.mjs'

const creds = loadCreds()
const key = creds.people.boss.apiKey
let id = 1
const call = async (name, args) => {
  const res = await fetch(`${creds.base}/api/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', 'authorization': `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } })
  })
  const body = await res.json()
  return JSON.parse(body.result?.content?.[0]?.text ?? 'null')
}

const board = await call('get_board', { board: creds.board.id })
for (const column of board.columns) {
  console.log(`${column.name.padEnd(14)} ${column.taskCount}`)
  for (const task of column.tasks ?? []) {
    console.log(`   ${task.id} ${task.assignee ? `[${task.assignee}] ` : ''}${task.title}${task.comments ? ` (${task.comments} updates)` : ''}`)
  }
}
const status = await call('list_status_updates', { board: creds.board.id, limit: 1 })
const latest = status?.updates?.[0]
if (latest) console.log(`\nLatest report (${latest.status}) ${latest.at ?? ''}:\n${latest.body}`)
