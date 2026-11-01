#!/usr/bin/env node
// A crew member's ears. Waits up to <seconds> (default 60) for something new and prints only
// what is new, then exits:
//   CHAT  a message in the work channel (the PM steers the workers there); with no chat client,
//         a message on the board instead (list_messages); for the PM also
//         in the customer channel; for the tester only the customer channel (meeting calls)
//   BOARD a task newly assigned to you on the development board, or a new Inbox item
//         (a comment on your task, a move, an assignment, a question for you)
// Prints "quiet" when nothing arrived. Run it in a loop; see "Listening" in CREW.md.
//   node listen.mjs <pm|w1|w2|w3|w4|pietje> [seconds]
//
// The first run for a person reads the whole channel history so they know the context.
// History is OLD: a "standing down" line in it is not an order.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { config, here, loadCreds } from './config.mjs'

const creds = loadCreds()
const [who, secs] = process.argv.slice(2)
const me = creds.people[who]
const nick = config.nicks[who]
if (!me || !nick) {
  console.error('usage: node listen.mjs <pm|w1|w2|w3|w4|pietje> [seconds]')
  process.exit(64)
}

const WAIT = Number(secs ?? process.env.WAIT ?? 60) * 1000
const CHAT = config.chat.client
const { channel, workChannel } = config.chat
const CHANNELS = who === 'pm' ? [workChannel, channel] : who === 'pietje' ? [channel] : [workChannel]
const boardId = creds.board.id

mkdirSync(`${here}.listen`, { recursive: true })
const statePath = `${here}.listen/${who}.json`
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { joined: false, notes: [], tasks: null }

function chat(args) {
  if (!CHAT) return ''
  try {
    return execFileSync(CHAT, args, { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    return String(e.stdout ?? '')
  }
}

async function mcp(name, args) {
  const res = await fetch(`${creds.base}/api/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', 'authorization': `Bearer ${me.apiKey}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  })
  const body = await res.json()
  try {
    return JSON.parse(body.result?.content?.[0]?.text ?? 'null')
  } catch {
    return null
  }
}

// With no chat client the board is the channel: messages others posted on the board (and their
// replies) print as CHAT lines with the author "board". The first run only records what is there:
// that history is old, like the chat history.
async function readBoardMessages() {
  const seen = new Set(state.messages ?? [])
  const firstRun = state.messages === undefined
  const out = []
  const res = await mcp('list_messages', { board: boardId })
  for (const message of res?.messages ?? []) {
    for (const item of [message, ...(message.replies ?? [])]) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      if (firstRun || item.author === me.name) continue
      out.push(`CHAT board ${item.author}: ${String(item.body ?? '').slice(0, 300)}`)
    }
  }
  state.messages = [...seen].slice(-500)
  return out
}

function readChat() {
  const out = []
  for (const ch of CHANNELS) {
    if (!state.joined) {
      chat(['join', '--chan', ch, '--nick', nick])
      for (const line of chat(['read', '--chan', ch, '--nick', nick, '--since', '0']).split('\n')) {
        if (line.startsWith('MSG')) out.push(line)
      }
      continue
    }
    for (const line of chat(['read', '--chan', ch, '--nick', nick]).split('\n')) {
      if (line.startsWith('MSG')) out.push(line)
    }
  }
  state.joined = true
  // MSG #chan id ts nick :text  ->  "#chan nick: text", without my own lines
  return out
    .map((line) => {
      const m = /^MSG (#\S+) \d+ \d+ (\S+) :(.*)$/.exec(line)
      return m ? { channel: m[1], from: m[2], text: m[3] } : null
    })
    .filter(m => m && !new RegExp(`^${nick}(-\\d+)?$`).test(m.from))
    .map(m => `CHAT ${m.channel} ${m.from}: ${m.text}`)
}

async function readBoard() {
  const out = []
  const inbox = await mcp('list_notifications', {})
  for (const n of inbox?.notifications ?? []) {
    if (n.read || state.notes.includes(n.id)) continue
    state.notes.push(n.id)
    if (n.board !== creds.board.name) continue
    out.push(`BOARD ${n.type} on task ${n.taskId ?? '?'}: ${n.title} - ${String(n.body ?? '').slice(0, 160)}`)
  }
  state.notes = state.notes.slice(-300)

  const mine = await mcp('my_tasks', {})
  const now = {}
  for (const t of mine?.tasks ?? []) if (t.board?.id === boardId) now[t.id] = t.title
  if (state.tasks !== null) {
    for (const [id, title] of Object.entries(now)) if (!(id in state.tasks)) out.push(`BOARD newly assigned to you: ${id} ${title}`)
  }
  state.tasks = now
  return out
}

const deadline = Date.now() + WAIT
let found = []
for (let round = 0; ; round++) {
  found = [...(CHAT ? readChat() : await readBoardMessages()), ...(round % 2 === 0 ? await readBoard() : [])]
  if (found.length || Date.now() >= deadline) break
  await new Promise(r => setTimeout(r, 5000))
}
writeFileSync(statePath, JSON.stringify(state))
console.log(found.length ? found.join('\n') : 'quiet')
