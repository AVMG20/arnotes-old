#!/usr/bin/env node
// Step 1 of the setup. Checks what the crew needs, writes the documents the agents read
// (CREW.md, PIETJE.md, NITPICKER.md, PIA-UX.md, PROMPTS.md, BRIEF.md, PROJECT-RULES.md) from their
// *.tmpl files with the values of crew.config.json, and writes fonts.conf when a font
// directory is given. Safe to run again: it overwrites generated documents (edit the
// .tmpl, not the output) but never PROJECT-RULES.md or BRIEF.md once they exist.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { config, here, templateValues } from './config.mjs'

const ok = m => console.log(`  ok   ${m}`)
const warn = m => console.log(`  WARN ${m}`)
const fail = (m) => {
  console.log(`  FAIL ${m}`)
  failed = true
}
let failed = false

console.log('Checks')
const major = Number(process.versions.node.split('.')[0])
major >= 20 ? ok(`node ${process.versions.node}`) : fail(`node ${process.versions.node}: need 20 or newer`)

try {
  const { chromium } = await import('playwright')
  ok('playwright is installed')
  const exe = config.chromium || process.env.CHROMIUM || chromium.executablePath()
  existsSync(exe)
    ? ok(`browser at ${exe}`)
    : fail(`no browser at ${exe}: run \`npx playwright install chromium\`, or set "chromium" in crew.config.json to an existing Chromium/Chrome binary`)
} catch { fail('playwright is missing: run `npm install` in this folder') }

if (!config.product.repo) warn('product.repo is empty: workers need the repository path to edit files')
else existsSync(config.product.repo) ? ok(`repo ${config.product.repo}`) : fail(`product.repo ${config.product.repo} does not exist`)

try {
  const res = await fetch(`${config.board.url}/api/health`).catch(() => fetch(config.board.url))
  ok(`board app answers at ${config.board.url} (${res.status})`)
} catch { fail(`nothing answers at ${config.board.url}: start the board app first`) }

if (config.chat.client) existsSync(config.chat.client) ? ok('chat client found') : fail(`chat.client ${config.chat.client} does not exist`)
else warn('no chat client configured: meetings in chat are skipped (everything else works)')

let hasFonts = true
try {
  execSync('fc-list | head -1', { stdio: 'pipe' })
} catch {
  hasFonts = false
}
if (!hasFonts && !config.fontDir) warn('no system fonts found (fc-list is empty or missing): headless Chromium may exit on some pages. Set "fontDir" in crew.config.json to a directory with .ttf fonts (e.g. DejaVu) and run init again')

console.log('\nWriting')
mkdirSync(`${here}work`, { recursive: true })
mkdirSync(`${here}backups`, { recursive: true })
const values = templateValues()
const render = text => text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (all, key) => (key in values ? values[key] : all))

for (const file of readdirSync(here).filter(f => f.endsWith('.tmpl'))) {
  const out = file.replace(/\.tmpl$/, '')
  if (out === 'fonts.conf') {
    if (!config.fontDir) continue
  }
  // Documents the owner edits by hand are written once.
  if ((out === 'PROJECT-RULES.md' || out === 'BRIEF.md') && existsSync(`${here}${out}`)) {
    ok(`${out} exists, kept`)
    continue
  }
  const text = render(readFileSync(`${here}${file}`, 'utf8'))
  const left = text.match(/\{\{[^}]+\}\}/g)
  writeFileSync(`${here}${out}`, text)
  ok(`${out}${left ? `  (unfilled: ${[...new Set(left)].join(' ')})` : ''}`)
}

console.log(failed ? '\nFix the FAIL lines above, then run init again.' : '\nInit done. Next: node setup.mjs (see README.md, step 5).')
process.exit(failed ? 1 : 0)
