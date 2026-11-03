#!/usr/bin/env node
// The one entry point for an agent of the crew:
//
//   crew <who> <command ...>   the board tools (tm.mjs): crew w1 mcp my_tasks '{}', crew boss tools
//   crew <who> update <taskId> <body.md|-> [--internal|--customer]   post an update from a file (no JSON to escape)
//   crew <who> attach <taskId> <image>                              upload an image to a task
//   crew listen <who> [sec]    wait for new messages (listen.mjs)
//   crew watch                 the Boss's board watcher (watch.mjs)
//   crew init                  check the machine and render the documents (init.mjs)
//   crew setup                 make the crew by hand through the crew API (setup.mjs)
//   crew channel <who>         the Claude Code channel server for one person (channel.mjs)
//   crew <who> browser goto|shot|eval|console|tabs|close-tab|done   the shared browser, one context per person (browser.mjs)
//   crew browser status|shutdown                                    the shared browser for everyone
//
// The other file names (tm.mjs, listen.mjs, ...) keep working.
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const kit = dirname(fileURLToPath(import.meta.url))
const [first, ...rest] = process.argv.slice(2)
const scripts = { listen: 'listen.mjs', watch: 'watch.mjs', init: 'init.mjs', setup: 'setup.mjs', channel: 'channel.mjs' }

if (!first || first === '-h' || first === '--help') {
  console.log('usage: crew <who> <command ...> | crew <who> browser <command> | crew browser status|shutdown | crew listen <who> [sec] | crew watch | crew init | crew setup | crew channel <who>')
  process.exit(first ? 0 : 2)
}

// The shared browser: `crew <who> browser ...` and `crew browser status|shutdown`.
if (first === 'browser' || rest[0] === 'browser') {
  const browserArgs = first === 'browser' ? rest : [first, ...rest.slice(1)]
  const run = spawnSync(process.execPath, [join(kit, 'browser.mjs'), ...browserArgs], { stdio: 'inherit' })
  process.exit(run.status ?? 1)
}

const script = scripts[first] ?? 'tm.mjs'
const args = scripts[first] ? rest : process.argv.slice(2)
const run = spawnSync(process.execPath, [join(kit, script), ...args], { stdio: 'inherit' })
process.exit(run.status ?? 1)
