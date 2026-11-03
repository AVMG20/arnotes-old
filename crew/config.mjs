// Shared loader for the crew's settings. Every script imports this instead of knowing
// about a project, a machine or a chat channel.
//
// Everything the kit writes (creds.json, crew.json, profiles, logs, the rendered documents)
// lives in CREW_HOME, so the kit folder itself can be replaced on update. CREW_HOME defaults
// to the kit folder. crew.json (written by `crew setup`, or by hand) holds the product,
// URLs, people and chat settings; creds.json holds the accounts and keys the board made.
import { readFileSync, existsSync } from 'node:fs'
import { crewHome, kitDir } from './home.mjs'

export { kitDir }
const home = crewHome()
export const here = `${home}/`

// crew.json is the one file a provisioned crew needs. crew.config.json is read too, so an
// older hand-made setup keeps working.
const configFile = [`${here}crew.json`, `${here}crew.config.json`].find(file => existsSync(file))
if (!configFile) {
  // Both forms of the path: a CREW_HOME that resolves somewhere unexpected is the usual cause.
  console.error(process.env.CREW_HOME
    ? `No crew.json in ${here}\nCREW_HOME is "${process.env.CREW_HOME}", which resolves to ${home}. Set CREW_HOME to the full path of the folder that holds crew.json.`
    : `No crew.json in ${here}\nCREW_HOME is not set, so the kit looked in its own folder. Set CREW_HOME to the full path of the folder that holds crew.json (the crew is made on the Crews page, or with POST /api/crews: see README.md).`)
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
    pietje: 'Pietje Precies', nitpicker: 'Nina Nitpick', contact: 'Casey Contact', watcher: 'Log Watcher',
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

const slugify = text => String(text).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

// The members Boss launches as agents, the optional log watcher included.
export const CAST = ['pm', 'w1', 'w2', 'w3', 'w4', 'pietje', 'nitpicker', 'watcher']

/**
 * Each member's Claude Code agent type, such as acme-pia-planner: the crew slug first, so two crews
 * on one machine never share one. init.mjs writes the definitions; PROMPTS.md names them.
 */
export const agentNames = Object.fromEntries(CAST.map(key => [key, `${slugify(config.crew.slug || config.team)}-${slugify(config.people[key])}`]))

// A path as one shell word, quoted only when it has to be.
const shellWord = text => (/^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`)

/**
 * Flat view of the config for templates: {{product.name}}, {{chat.channel}}, {{crew_dir}} ...
 * {{node_kit}} starts a kit command with this crew's CREW_HOME, so it works from any session:
 * `{{node_kit}}/crew.mjs w1 tools` renders as `CREW_HOME=<crew home> node <kit folder>/crew.mjs w1 tools`,
 * with both paths written out in full.
 */
export function templateValues() {
  const out = {
    crew_dir: home,
    kit_dir: kitDir,
    node_kit: `CREW_HOME=${shellWord(home)} node ${shellWord(kitDir)}`,
    today: new Date().toISOString().slice(0, 10)
  }
  const walk = (prefix, value) => {
    if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(prefix ? `${prefix}.${k}` : k, v)
    else out[prefix] = String(value ?? '')
  }
  walk('', { ...config, agents: agentNames })
  return out
}
