// Shared loader for the crew's settings. Every script imports this instead of knowing
// about a project, a machine or a chat channel.
//
// Everything the kit writes (creds.json, crew.json, profiles, logs, the rendered documents)
// lives in CREW_HOME, so the kit folder itself can be replaced on update. CREW_HOME defaults
// to the kit folder. crew.json (written by `crew setup`, or by hand) holds the product,
// URLs, people and chat settings; creds.json holds the accounts and keys the board made.
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const kitDir = new URL('.', import.meta.url).pathname.replace(/\/$/, '')
const home = resolve(process.env.CREW_HOME || kitDir)
export const here = `${home}/`

// crew.json is the one file a provisioned crew needs. crew.config.json is read too, so an
// older hand-made setup keeps working.
const configFile = [`${here}crew.json`, `${here}crew.config.json`].find(file => existsSync(file))
if (!configFile) {
  console.error(`No crew.json in ${here}. A crew is made with POST /api/crews (see README.md); set CREW_HOME if the file is elsewhere.`)
  process.exit(78)
}

const raw = JSON.parse(readFileSync(configFile, 'utf8'))

// Defaults for everything optional, so a short config works.
export const config = {
  team: raw.team ?? 'Crew',
  product: { name: 'My Product', repo: '', appUrl: raw.board?.url ?? 'http://localhost:3000', ...raw.product },
  board: {
    url: 'http://localhost:3000',
    name: `${raw.product?.name ?? 'My Product'} Development Center`,
    ...raw.board
  },
  customer: { name: 'The Customer', personName: 'Casey Customer', nick: 'customer', ...raw.customer },
  people: {
    boss: 'Boss', pm: 'Pia Planner', w1: 'Wren Worker', w2: 'Wick Worker', w3: 'Wynn Worker', w4: 'Wade Worker',
    pietje: 'Pietje Precies', nitpicker: 'Nina Nitpick', contact: 'Casey Contact',
    ...raw.people
  },
  nicks: { pm: 'pia', w1: 'wren', w2: 'wick', w3: 'wynn', w4: 'wade', pietje: 'pietje', nitpicker: 'nitpicker', ...raw.nicks },
  // The chat line is optional and off by default: with no client, meetings and steering go
  // through the board (board messages, `list_messages`).
  chat: { client: '', channel: '#crew', workChannel: '#crewwork', ...raw.chat },
  // Browser for the screenshots: this path, else CHROMIUM, else Playwright's own.
  chromium: raw.chromium ?? '',
  fontDir: raw.fontDir ?? '',
  // Where Claude Code keeps the transcripts of this session's subagents (for watchlogs.mjs).
  subagentsDir: raw.subagentsDir ?? '',
  // The slug the crew API files this crew under (setup.mjs reads it).
  crew: raw.crew ?? {},
  devLog: raw.devLog ?? `${here}dev.log`
}

// The columns every board needs, in this order. The crew API creates them.
export const COLUMNS = ['Backlog', 'To do', 'In progress', 'Verify', 'Ready for live', 'Done', 'Bugs']

export function loadCreds() {
  const file = `${here}creds.json`
  if (!existsSync(file)) {
    console.error(`No creds.json in ${here}: the crew has not been provisioned here (see README.md).`)
    process.exit(78)
  }
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** Flat view of the config for templates: {{product.name}}, {{chat.channel}}, {{crew_dir}} ... */
export function templateValues() {
  const out = { crew_dir: home, today: new Date().toISOString().slice(0, 10) }
  const walk = (prefix, value) => {
    if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(prefix ? `${prefix}.${k}` : k, v)
    else out[prefix] = String(value ?? '')
  }
  walk('', config)
  return out
}
