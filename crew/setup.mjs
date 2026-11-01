#!/usr/bin/env node
// Makes a crew by hand: a thin client of POST /api/crews on the Taskmanager instance. The
// instance admin's crews:manage key comes from the environment, never from a file here:
//
//   CREW_ADMIN_KEY=<key> node setup.mjs             # first time: writes creds.json (mode 600)
//   CREW_ADMIN_KEY=<key> node setup.mjs --rotate    # the crew exists but creds.json is lost
//
// It reads crew.json in CREW_HOME for the product name and board URL, and prints nothing
// secret except the one-time response it writes to creds.json.
import { writeFileSync, chmodSync } from 'node:fs'
import { config, here } from './config.mjs'

const key = process.env.CREW_ADMIN_KEY
if (!key) {
  console.error('Set CREW_ADMIN_KEY to a crews:manage key of the instance admin (shown once in the Crews settings).')
  process.exit(78)
}
const rotate = process.argv.includes('--rotate')
const slug = config.crew?.slug || process.env.CREW_SLUG
if (!slug) {
  console.error('Set "crew": { "slug": "..." } in crew.json (or CREW_SLUG): lowercase letters, digits and dashes.')
  process.exit(78)
}

const base = config.board.url
const res = await fetch(`${base}/api/crews`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'authorization': `Bearer ${key}` },
  body: JSON.stringify({ slug, name: config.team, product: config.product, rotate })
})
const body = await res.json().catch(() => ({}))

if (res.status === 409) {
  console.error(`The crew "${slug}" already exists. Run with --rotate to get new keys (the old ones stop working).`)
  process.exit(1)
}
if (!res.ok) {
  console.error(`The crew API answered ${res.status}: ${body.message ?? 'no detail'}`)
  process.exit(1)
}

const file = `${here}creds.json`
writeFileSync(file, JSON.stringify({ ...body, base: body.base ?? base }, null, 2))
chmodSync(file, 0o600)
console.log(`Crew "${slug}" ${res.status === 201 ? 'created' : 'rotated'}. Board: ${body.crew?.boardUrl ?? '(see the Crews page)'}`)
console.log(`Credentials written to ${file}. Next: node init.mjs, then read README.md.`)
