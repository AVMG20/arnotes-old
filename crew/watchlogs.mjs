// The log watcher's eyes. Waits (up to WAIT seconds, default 240) for something new and
// prints only what looks wrong since the last call: dev-server errors, crew transcripts
// with failing tool calls or workarounds, and new bugs on the board. Remembers where it
// stopped in .watch-state.json. Read-only. Prints "nothing new" when all is quiet.
//
// Needs two paths in crew.config.json (both optional; a missing one is skipped):
//   devLog       the product's dev-server output, e.g. `npm run dev > crew/dev.log 2>&1`
//   subagentsDir Claude Code's folder with this session's subagent transcripts, usually
//                ~/.claude/projects/<project-folder>/<session-id>/subagents
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, openSync, readSync, closeSync } from 'node:fs'
import { config, here, loadCreds } from './config.mjs'

const statePath = `${here}.watch-state.json`
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { offsets: {}, bugs: [] }
const creds = loadCreds()
const project = creds.board.id
const SUBAGENTS = process.env.SUBAGENTS || config.subagentsDir
const SINCE = Number(process.env.SINCE_MS || Date.now() - 60_000)
const WAIT = Number(process.env.WAIT || 240) * 1000

function fresh(file) {
  const size = statSync(file).size
  const from = state.offsets[file] ?? (file.endsWith('.log') ? Math.max(0, size - 20000) : size)
  state.offsets[file] = size
  if (size <= from) return ''
  const fd = openSync(file, 'r')
  const buf = Buffer.alloc(Math.min(size - from, 2_000_000))
  readSync(fd, buf, 0, buf.length, from)
  closeSync(fd)
  return buf.toString('utf8')
}

const DEV_BAD = /(ERROR|Error:|unhandled|ECONN|\b5\d\d\b.*(api|GET|POST|PUT)|RollupError|is not exported|Cannot find|TypeError|ReferenceError|Failed to|SQL|relation .* does not exist|column .* does not exist)/
const SAY_BAD = /(work(ed|ing)? ?around|workaround|didn'?t work|did not work|doesn'?t work|can'?t|cannot|couldn'?t|unable|blank|stuck|hang|hung|weird|strange|unexpected|not found|no such|refus|blocked|denied|forbidden|timed? ?out)/i
const TOOL_BAD = /\b(Error|error:|FAIL|Timeout|TypeError|ECONN|403|404|409|422|429|500|503)\b/

function scan() {
  const out = []
  const devLog = config.devLog
  if (existsSync(devLog)) {
    const seen = new Set()
    for (const line of fresh(devLog).split('\n')) {
      if (!DEV_BAD.test(line)) continue
      const key = line.replace(/\d+/g, '#').slice(0, 120)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(`dev log: ${line.trim().slice(0, 260)}`)
    }
  }
  if (SUBAGENTS && existsSync(SUBAGENTS)) {
    for (const f of readdirSync(SUBAGENTS).filter(f => f.endsWith('.jsonl'))) {
      const file = `${SUBAGENTS}/${f}`
      if (statSync(file).mtimeMs < SINCE) continue
      const id = f.slice(6, 14)
      // The watcher's own transcript quotes the log lines it reads; do not report those back.
      if (readFileSync(file, 'utf8').slice(0, 6000).includes('Log Watcher for a small team')) continue
      const seen = new Set()
      for (const line of fresh(file).split('\n')) {
        if (!line) continue
        let o
        try {
          o = JSON.parse(line)
        } catch {
          continue
        }
        const c = o.message?.content
        if (!Array.isArray(c)) continue
        for (const b of c) {
          if (b.type === 'text' && o.type === 'assistant') {
            for (const s of b.text.split(/(?<=[.!?])\s+|\n+/)) {
              if (s.length < 25 || s.length > 300 || !SAY_BAD.test(s)) continue
              const key = s.slice(0, 70)
              if (seen.has(key)) continue
              seen.add(key)
              out.push(`[${id}] said: ${s.trim()}`)
            }
          } else if (b.type === 'tool_result') {
            const t = typeof b.content === 'string' ? b.content : (b.content || []).map(x => x.text || '').join(' ')
            if (!(b.is_error || TOOL_BAD.test(t.slice(0, 500)))) continue
            if (/^PreToolUse|hook error/.test(t)) continue
            const key = t.slice(0, 70)
            if (seen.has(key)) continue
            seen.add(key)
            out.push(`[${id}] tool failed: ${t.replace(/\s+/g, ' ').slice(0, 240)}`)
          }
        }
      }
    }
  }
  return out
}

async function bugs() {
  try {
    const res = await fetch(`${creds.base}/api/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', 'authorization': `Bearer ${creds.people.boss.apiKey}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_board', arguments: { board: project } } })
    })
    const board = JSON.parse((await res.json()).result?.content?.[0]?.text ?? 'null')
    const col = board?.columns?.find(c => c.name === 'Bugs')
    const fresh = []
    for (const t of col?.tasks ?? []) {
      if (state.bugs.includes(t.id)) continue
      fresh.push(`new bug on the board: ${t.title}`)
      state.bugs.push(t.id)
    }
    return fresh
  } catch (e) {
    return [`board unreachable: ${String(e).slice(0, 120)}`]
  }
}

const deadline = Date.now() + WAIT
let found = []
for (;;) {
  found = [...scan(), ...await bugs()]
  if (found.length || Date.now() >= deadline) break
  await new Promise(r => setTimeout(r, 15000))
}
writeFileSync(statePath, JSON.stringify(state))
console.log(found.length ? found.slice(0, 40).join('\n') : 'nothing new')
