// Posts a brief as the customer's request on the development board (Backlog, customer-visible).
//   node postbrief.mjs BRIEF.md "Request: <short title>"
import { readFileSync } from 'node:fs'
import { loadCreds } from './config.mjs'

const [file, title] = process.argv.slice(2)
if (!file || !title) {
  console.error('usage: node postbrief.mjs <brief.md> "<title>"')
  process.exit(64)
}
const creds = loadCreds()
const res = await fetch(`${creds.base}/api/mcp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', 'authorization': `Bearer ${creds.people.customer.apiKey}` },
  body: JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'create_task', arguments: { board: creds.board.id, column: 'Backlog', title, description: readFileSync(file, 'utf8'), visibility: 'customer' } }
  })
})
console.log(res.status, (await res.text()).slice(0, 300))
