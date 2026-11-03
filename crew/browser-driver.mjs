#!/usr/bin/env node
// One shared headless Chromium for the whole crew: each person gets an isolated browser
// context, and named tabs inside it. Node port of the Python reference in GH #71 (the design
// is the reference's; the wire protocol is kept, so the `crew` command can call it as is).
//
//   node browser-driver.mjs WHO goto URL [--tab T] [--width W] [--height H]
//   node browser-driver.mjs WHO shot FILE [--full] [--tab T] [--width W] [--height H]
//   node browser-driver.mjs WHO eval JS [--tab T]
//   node browser-driver.mjs WHO send METHOD [JSON-PARAMS] [--tab T]
//   node browser-driver.mjs WHO console [--tab T]
//   node browser-driver.mjs WHO tabs
//   node browser-driver.mjs WHO close-tab T
//   node browser-driver.mjs WHO done
//   node browser-driver.mjs status
//   node browser-driver.mjs shutdown
//
// Nothing to start or stop: the first command starts the browser. A person idle for
// BROWSER_IDLE_SECONDS (default 1800) loses their context; the browser exits once nobody has
// used it for BROWSER_EXIT_SECONDS (default 600). Tabs default to "main", at most 8 a person.
//
// Dialogs (alert, confirm, prompt) are dismissed unless the goto or eval asks for --accept-dialogs,
// or CREW_ACCEPT_DIALOGS=1 is set for the driver. Either way the note says only the type.
// Protocol: one JSON line {"cmd","who","args"} to the unix socket; one JSON line back,
// {"ok":true,"result","note"} or {"ok":false,"error"}. A second request line is not read.
//
// Lock rule: the driver holds <dir>/pool.lock, created as a hard link to a file that holds the
// owner's pid (so the lock never exists half-written). A second driver takes the lock over only
// when that pid is dead AND the socket refuses a connection; otherwise it exits and the live
// driver keeps its socket. A takeover renames the stale lock to a unique name, checks that what it
// moved is the file it looked at with the same dead owner, and removes it either way. Nothing is put
// back: a live lock the rename caught is gone for a moment, so its owner takes it again on its next
// tick (keepLock), and a claim checks the socket after it creates a lock, so a driver that still
// answers keeps its place.
//
// Limits: shot writes only .png or .jpg files, never through a link, never over a folder, only
// under CREW_BROWSER_SHOT_DIRS (default: the crew's work folder; the system temp folder only when it
// is named there), and
// never over an existing file unless --overwrite is given. send is an allowlist of CDP domains
// (SEND_ALLOWED): no downloads, file chooser or CSP bypass, and no Browser, Target, Fetch, IO,
// Storage, Security, SystemInfo or Debugger. People are capped at CREW_BROWSER_MAX_PEOPLE (default
// 16). The state folder must be a real folder owned by the current user; it is opened without
// following links, and the driver keeps that descriptor open.
//
// Security: the socket sits in a 0700 directory and is 0600, and nothing listens on TCP.
// Chromium runs with --remote-debugging-pipe (fds 3 and 4), never a debug port, and it exits
// when the pipe closes, so a killed driver cannot leave it running. Logs (pool.log) carry only
// the command name, the person key and an error class: never cookies, page text, console output,
// typed values or URLs. Client input is untrusted: WHO, tab names, URLs, JavaScript, file paths and
// CDP method names are validated, and Chromium gets an argument array, never a shell string.
// Contexts keep people's cookies and storage apart, which stops accidents. They do not stop a
// hostile worker: the crew runs as one Linux user, who can read every socket and profile.
// The login is not here: `serve({ prepare })` runs a caller's seam once per new context. The daemon
// loads it from browser.mjs next to this file (the crew's own login). No environment setting can
// point it elsewhere; tests of the driver pass seam: false to request().

import { spawn } from 'node:child_process'
import { accessSync, chmodSync, closeSync, constants, existsSync, fchmodSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { open } from 'node:fs/promises'
import net from 'node:net'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { crewHome } from './home.mjs'

const SELF = fileURLToPath(import.meta.url)
const KIT_DIR = dirname(SELF)
const SOCKET_NAME = 'pool.sock'
const LOCK_NAME = 'pool.lock'
const LOG_NAME = 'pool.log'
export const COMMANDS = ['goto', 'shot', 'eval', 'send', 'console', 'tabs', 'close-tab', 'done', 'status', 'shutdown']
export const MAX_TABS = 8
export const DEFAULT_TAB = 'main'
const NAME_RE = /^[a-z0-9_-]{1,32}$/ // WHO and tab names
const METHOD_RE = /^[A-Za-z]{1,64}\.[A-Za-z]{1,64}$/
const CONSOLE_LIMIT = 500
const MAX_LINE = 8 * 1024 * 1024
const MAX_URL = 4096
const MAX_JS = 1024 * 1024
const LOAD_MS = 30000 // how long goto waits for the load event
const CLIENT_REPLY_MS = 150000 // the longest the server can take is a goto plus two 60 s calls
const SPAWN_RETRY_MS = 10000
const START_DEADLINE_MS = 40000

export class BrowserError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BrowserError'
  }
}

class CdpError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CdpError'
  }
}

const describe = e => `${e.name}: ${e.message}`
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const log = text => console.log(`${new Date().toISOString()} ${text}`)

// ---------- pure parts (unit-tested) ----------

export function validWho(who) {
  return typeof who === 'string' && NAME_RE.test(who)
}

export function formatDuration(seconds) {
  if (seconds >= 60) {
    const minutes = Math.round(seconds / 60)
    return `${minutes} minute${minutes === 1 ? '' : 's'}`
  }
  return `${seconds} second${seconds === 1 ? '' : 's'}`
}

export function idleNote(who, idleSeconds) {
  return `${who}: your browser session expired after ${formatDuration(idleSeconds)} idle, so tabs and logins are gone`
}

export function crashNote(hasPrepare) {
  return hasPrepare
    ? 'the shared browser stopped and was started again: your tabs are gone, and your login was set up again'
    : 'the shared browser stopped and was started again: your tabs and logins are gone, so log in again'
}

function allowedUrl(url) {
  if (url === 'about:blank') return true
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

function checkArgs(cmd, args) {
  const { tab, width, height, url, file, js, method, params, full, accept_dialogs: acceptDialogs, overwrite } = args
  if (tab !== undefined && !(typeof tab === 'string' && NAME_RE.test(tab))) {
    throw new BrowserError('tab names are 1 to 32 letters, digits, _ or -')
  }
  for (const [name, value] of [['width', width], ['height', height]]) {
    if (value !== undefined && !(Number.isInteger(value) && value >= 0 && value <= 4096)) {
      throw new BrowserError(`${name} must be a whole number of pixels`)
    }
  }
  if (full !== undefined && typeof full !== 'boolean') throw new BrowserError('full must be true or false')
  if (overwrite !== undefined && typeof overwrite !== 'boolean') throw new BrowserError('overwrite must be true or false')
  if (acceptDialogs !== undefined && typeof acceptDialogs !== 'boolean') throw new BrowserError('accept_dialogs must be true or false')
  if (cmd === 'goto' && (typeof url !== 'string' || url.length > MAX_URL || !allowedUrl(url))) {
    throw new BrowserError('goto takes an http, https or about:blank URL')
  }
  if (cmd === 'shot' && (typeof file !== 'string' || !isAbsolute(file))) {
    throw new BrowserError('shot takes an absolute file path')
  }
  if (cmd === 'eval' && (typeof js !== 'string' || js.length > MAX_JS)) {
    throw new BrowserError('eval takes a JavaScript string')
  }
  if (cmd === 'send') {
    // The allowlist is in checkSendMethod.
    checkSendMethod(method)
    if (typeof method !== 'string') {
      throw new BrowserError('send takes a method name such as Runtime.evaluate')
    }
    if (params !== undefined && (params === null || typeof params !== 'object' || Array.isArray(params))) {
      throw new BrowserError('send params must be a JSON object')
    }
  }
  if (cmd === 'close-tab' && tab === undefined) throw new BrowserError('close-tab takes a tab name')
}

/** Parses one request line from a client. Throws BrowserError on anything it does not accept. */
export function parseRequest(text) {
  let req
  try {
    req = JSON.parse(text)
  } catch {
    throw new BrowserError('the request is not JSON')
  }
  if (!req || typeof req !== 'object' || Array.isArray(req)) throw new BrowserError('the request is not an object')
  const { cmd } = req
  if (!COMMANDS.includes(cmd)) throw new BrowserError('unknown command')
  const args = req.args ?? {}
  if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new BrowserError('args must be an object')
  const who = cmd === 'status' || cmd === 'shutdown' ? null : req.who
  if (who !== null && !validWho(who)) throw new BrowserError('WHO must be a short lowercase name, such as w1')
  checkArgs(cmd, args)
  return { cmd, who, args }
}

const USAGE = 'usage: browser-driver.mjs WHO goto|shot|eval|send|console|tabs|close-tab|done ... | status | shutdown'

/** Parses the command line of the client mode. Returns { who, cmd, args } or { help: true }. */
export function parseCli(argv) {
  let rest = [...argv]
  if (rest.length === 0 || rest[0] === '-h' || rest[0] === '--help') return { help: true }
  const takeFlag = (name) => {
    const i = rest.indexOf(name)
    if (i < 0) return undefined
    if (i + 1 >= rest.length) throw new BrowserError(`${name} needs a value`)
    const value = rest.splice(i, 2)[1]
    return value
  }
  const full = rest.includes('--full')
  const accept = rest.includes('--accept-dialogs')
  const overwrite = rest.includes('--overwrite')
  rest = rest.filter(item => !['--full', '--accept-dialogs', '--overwrite'].includes(item))
  const args = {}
  const tab = takeFlag('--tab')
  if (tab !== undefined) args.tab = tab
  for (const [flag, key] of [['--width', 'width'], ['--height', 'height']]) {
    const value = takeFlag(flag)
    if (value === undefined) continue
    const n = Number(value)
    if (!Number.isInteger(n)) throw new BrowserError(`${flag} needs a whole number`)
    args[key] = n
  }
  if (full) args.full = true
  if (accept) args.accept_dialogs = true
  if (overwrite) args.overwrite = true
  let who = null
  let cmd
  if (rest[0] === 'status' || rest[0] === 'shutdown') {
    cmd = rest.shift()
  } else {
    who = rest.shift() ?? null
    cmd = rest.shift()
    if (who !== null && !validWho(who)) throw new BrowserError('WHO must be a short lowercase name, such as w1')
  }
  if (!cmd) throw new BrowserError(USAGE)
  const need = (count) => {
    if (rest.length < count) throw new BrowserError(`${cmd} needs an argument`)
  }
  switch (cmd) {
    case 'goto':
      need(1)
      args.url = rest[0]
      break
    case 'shot':
      need(1)
      args.file = resolve(rest[0])
      break
    case 'eval':
      need(1)
      args.js = rest[0]
      break
    case 'send': {
      need(1)
      args.method = rest[0]
      try {
        args.params = rest[1] === undefined ? {} : JSON.parse(rest[1])
      } catch {
        throw new BrowserError('send params must be JSON')
      }
      break
    }
    case 'close-tab':
      need(1)
      args.tab = rest[0]
      break
    default: break
  }
  return { who, cmd, args }
}

/** Splits the bytes Chromium writes on fd 4 into NUL-terminated JSON frames. */
export function splitFrames(buffer) {
  const frames = []
  let start = 0
  let end = buffer.indexOf(0, start)
  while (end !== -1) {
    frames.push(buffer.toString('utf8', start, end))
    start = end + 1
    end = buffer.indexOf(0, start)
  }
  return { frames, rest: buffer.subarray(start) }
}

export function encodeFrame(message) {
  return Buffer.from(`${JSON.stringify(message)}\0`)
}

/** A lock is taken over only when its owner is dead and nobody answers on the socket. */
export function lockDecision({ ownerAlive, socketAccepts }) {
  return ownerAlive || socketAccepts ? 'busy' : 'take'
}

/** True for a live process. A zombie (exited, not yet reaped) counts as dead. */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
  } catch (e) {
    if (e.code !== 'EPERM') return false
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3)
    return state !== 'Z'
  } catch {
    return true
  }
}

/** Chromium's arguments. No --remote-debugging-port: the pipe is the only control channel. */
export function chromeArgs({ profileDir, sandbox = true }) {
  return [
    '--headless=new',
    '--remote-debugging-pipe',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--window-size=1280,900',
    ...(sandbox ? [] : ['--no-sandbox']),
    'about:blank'
  ]
}

// The methods `send` may call, by CDP domain. Page is open except for the methods that write
// downloads anywhere, change the file chooser, or bypass the content security policy; navigate
// stays with goto, so its URL check applies. Network takes reads and the enable/disable switches.
const SEND_ALLOWED = {
  Page: { deny: ['setDownloadBehavior', 'setInterceptFileChooserDialog', 'setBypassCSP', 'navigate'] },
  Runtime: {},
  DOM: {},
  CSS: {},
  Input: {},
  Emulation: {},
  Accessibility: {},
  Log: {},
  Network: { only: /^(get|enable|disable)/ }
}

/** Throws unless the method is on the allowlist. The message lists the allowed domains. */
export function checkSendMethod(method) {
  const [domain, name] = typeof method === 'string' && METHOD_RE.test(method) ? method.split('.') : []
  const rule = Object.hasOwn(SEND_ALLOWED, domain) ? SEND_ALLOWED[domain] : null
  const allowed = rule !== null && !(rule.deny ?? []).includes(name) && (!rule.only || rule.only.test(name))
  if (!allowed) {
    throw new BrowserError(`send: that method is not allowed. Allowed domains: ${Object.keys(SEND_ALLOWED).join(', ')} (Page without the download, file chooser, CSP and navigate methods; Network only get, enable and disable)`)
  }
}

/**
 * Folders a screenshot may go under: CREW_BROWSER_SHOT_DIRS (colon-separated), else the crew's work
 * folder. The system temp folder is never a default: a screenshot there is only allowed when named.
 */
export function shotRoots() {
  const list = process.env.CREW_BROWSER_SHOT_DIRS
    ? process.env.CREW_BROWSER_SHOT_DIRS.split(':').filter(Boolean)
    : [join(crewHome(), 'work')]
  return list.flatMap((path) => {
    try {
      return [realpathSync(resolve(path))]
    } catch {
      return []
    }
  })
}

/**
 * Checks a screenshot target before anything is written: an absolute .png or .jpg name, in an
 * existing folder under an allowed root, not a link or a folder, and not an existing file unless
 * overwrite is set. The messages never print a path.
 */
export function checkShotPath(file, { overwrite = false, roots = shotRoots() } = {}) {
  const refuse = (why) => {
    throw new BrowserError(`shot: ${why}`)
  }
  if (typeof file !== 'string' || !isAbsolute(file)) refuse('the file must be an absolute path')
  if (!/\.(png|jpe?g)$/i.test(file)) refuse('the file must end in .png or .jpg')
  let folder
  try {
    folder = realpathSync(dirname(file))
  } catch {
    refuse('the folder does not exist')
  }
  if (!roots.some(root => folder === root || folder.startsWith(root + sep))) refuse('the file is outside the allowed folders')
  let stat = null
  try {
    stat = lstatSync(file)
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
  if (stat?.isSymbolicLink() || stat?.isDirectory()) refuse('the file is a link or a folder')
  if (stat && !overwrite) refuse('the file exists; use --overwrite to replace it')
  return file
}

/** Writes a screenshot without following a link, and replaces a file only when asked to. */
async function writeShot(file, data, overwrite) {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | (overwrite ? constants.O_TRUNC : constants.O_EXCL)
  let handle
  try {
    handle = await open(file, flags, 0o600)
  } catch (e) {
    if (e.code === 'EEXIST' || e.code === 'ELOOP') throw new BrowserError('shot: the file exists or is a link; use --overwrite to replace a file')
    throw e
  }
  try {
    await handle.write(data, 0, data.length, 0)
  } finally {
    await handle.close()
  }
}

/**
 * Opens the state folder and checks it in one step: O_NOFOLLOW refuses a link, O_DIRECTORY refuses
 * anything else, and fstat checks the owner of the folder that was opened. Returns the descriptor,
 * which the driver keeps for its life, so the check is not separate from the open.
 */
export function openDirectory(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  let fd
  try {
    fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  } catch (e) {
    if (e.code === 'ELOOP' || e.code === 'ENOTDIR') throw new BrowserError('the state folder must be a real folder, not a link')
    throw e
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isDirectory()) throw new BrowserError('the state folder must be a real folder, not a link')
    if (stat.uid !== process.getuid()) throw new BrowserError('the state folder belongs to another user')
    fchmodSync(fd, 0o700)
  } catch (e) {
    closeSync(fd)
    throw e
  }
  return fd
}

/** The check alone, for callers that do not keep the folder open. */
export function checkDirectory(dir) {
  closeSync(openDirectory(dir))
}

/** True while the path still names the folder that was opened: a folder swapped for another is refused. */
export function sameFolder(dir, fd) {
  const opened = fstatSync(fd)
  const named = lstatSync(dir)
  return !named.isSymbolicLink() && named.dev === opened.dev && named.ino === opened.ino
}

/** Unix socket paths are limited to about 108 bytes. */
export function socketPathFits(path) {
  return Buffer.byteLength(path) < 104
}

/** Runs async jobs one after another. */
export class Mutex {
  #tail = Promise.resolve()

  run(job) {
    const result = this.#tail.then(job)
    this.#tail = result.catch(() => {})
    return result
  }
}

export function withTimeout(promise, ms, label) {
  let timer
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new BrowserError(`${label} timed out after ${Math.round(ms / 1000)} seconds`)), ms)
  })
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer))
}

function isExecutable(file) {
  try {
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function chromiumFromConfig() {
  const home = crewHome()
  for (const name of ['crew.json', 'crew.config.json']) {
    try {
      const path = JSON.parse(readFileSync(join(home, name), 'utf8')).chromium
      if (path) return path
    } catch {
      // no such file, or not JSON: the next one
    }
  }
  return ''
}

/** The first Chromium that exists: the given path, CREW_BROWSER_CHROMIUM, CHROMIUM, then crew.json. */
export function findChromium(explicit = '') {
  const candidates = [explicit, process.env.CREW_BROWSER_CHROMIUM, process.env.CHROMIUM, chromiumFromConfig()]
  return candidates.find(path => path && existsSync(path) && isExecutable(path)) ?? ''
}

export function defaultDir() {
  return process.env.CREW_BROWSER_DIR || join(homedir(), '.local', 'share', 'crew-browser')
}

function secondsFromEnv(name, fallback) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function resolveConfig(options) {
  const dir = resolve(options.dir ?? defaultDir())
  const idleSeconds = options.idleSeconds ?? secondsFromEnv('BROWSER_IDLE_SECONDS', 1800)
  const exitSeconds = options.exitSeconds ?? secondsFromEnv('BROWSER_EXIT_SECONDS', 600)
  const callSeconds = options.callSeconds ?? secondsFromEnv('BROWSER_CALL_SECONDS', 60)
  const requestSeconds = options.requestSeconds ?? secondsFromEnv('BROWSER_REQUEST_SECONDS', 120)
  return {
    dir,
    sock: join(dir, SOCKET_NAME),
    profileDir: join(dir, 'profile'),
    chromium: options.chromium || findChromium(),
    prepare: options.prepare ?? null,
    sandbox: process.env.CREW_CHROMIUM_NO_SANDBOX !== '1',
    acceptDialogs: options.acceptDialogs ?? process.env.CREW_ACCEPT_DIALOGS === '1',
    maxPeople: Math.floor(options.maxPeople ?? secondsFromEnv('CREW_BROWSER_MAX_PEOPLE', 16)),
    idleMs: idleSeconds * 1000,
    exitMs: exitSeconds * 1000,
    callMs: callSeconds * 1000,
    requestMs: requestSeconds * 1000,
    reapMs: Math.min(15000, Math.max(1000, (idleSeconds * 1000) / 2)),
    signals: options.signals ?? true
  }
}

// ---------- the lock: one driver per directory ----------

function readOwner(file) {
  try {
    return parseInt(readFileSync(file, 'utf8'), 10)
  } catch {
    return null
  }
}

function tryCreateLock(file) {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${process.pid}\n`, { mode: 0o600 })
  try {
    linkSync(tmp, file)
    return true
  } catch (e) {
    if (e.code !== 'EEXIST') throw e
    return false
  } finally {
    unlinkSync(tmp)
  }
}

/** Connects to the socket once. Resolves the connected socket, or null when nothing answers. */
function connectTo(sock, ms) {
  return new Promise((resolve) => {
    if (!existsSync(sock)) return resolve(null)
    const conn = net.createConnection({ path: sock })
    const timer = setTimeout(() => {
      conn.destroy()
      resolve(null)
    }, ms)
    conn.once('connect', () => {
      clearTimeout(timer)
      resolve(conn)
    })
    conn.once('error', () => {
      clearTimeout(timer)
      conn.destroy()
      resolve(null)
    })
  })
}

async function socketAccepts(sock) {
  const conn = await connectTo(sock, 300)
  if (!conn) return false
  conn.destroy()
  return true
}

/** Takes the lock for dir. Returns true when this process owns it, false when a live driver does. */
export async function acquireLock(dir, sock = join(dir, SOCKET_NAME)) {
  const file = join(dir, LOCK_NAME)
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await claim(dir, sock)) return true
    const owner = readOwner(file)
    if (owner === null) continue // it went away while we looked
    const decision = lockDecision({ ownerAlive: pidAlive(owner), socketAccepts: await socketAccepts(sock) })
    if (decision === 'busy') return false
    if (takeStale(file, owner) && (await claim(dir, sock))) return true
  }
  return false
}

/**
 * Creates the lock, then checks the socket. A live driver whose lock a takeover caught still answers
 * on its socket: this driver gives the lock back and leaves that socket alone.
 */
async function claim(dir, sock) {
  if (!tryCreateLock(join(dir, LOCK_NAME))) return false
  if (!(await socketAccepts(sock))) return true
  releaseLock(dir)
  return false
}

/**
 * Moves the stale lock aside under a unique name, checks what was moved (the file we looked at, the
 * same inode, with the same dead owner) and removes it. Nothing is put back: a hard link back would
 * leave a window in which another driver takes the lock. When the move caught a live lock, its owner
 * takes it again (keepLock), and claim keeps a second driver off the socket meanwhile.
 */
function takeStale(file, owner) {
  let before
  try {
    before = statSync(file)
  } catch {
    return false
  }
  const moved = `${file}.stale-${process.pid}-${randomBytes(6).toString('hex')}`
  try {
    renameSync(file, moved)
  } catch {
    return false
  }
  let same = false
  try {
    same = statSync(moved).ino === before.ino && readOwner(moved) === owner && !pidAlive(owner)
  } catch {
    same = false
  }
  if (!same) {
    // The move caught a lock that is not the stale one: it goes back before the moved name is removed.
    // A hard link cannot replace a newer lock. What remains: between the rename and this link the path
    // is empty, so the live owner takes its lock again on its next tick (keepLock), and claim keeps a
    // driver that starts in that gap off the socket. If the link fails, a newer lock is there and the
    // moved file is kept for its owner rather than deleted.
    try {
      linkSync(moved, file)
    } catch {
      return false
    }
  }
  try {
    unlinkSync(moved)
  } catch {
    // already gone
  }
  return same
}

/** A live driver whose lock a takeover moved away takes it again. A lock someone else holds is left alone. */
export function keepLock(dir) {
  try {
    if (readOwner(join(dir, LOCK_NAME)) === null) tryCreateLock(join(dir, LOCK_NAME))
  } catch {
    // the next tick tries again
  }
}

export function releaseLock(dir) {
  const file = join(dir, LOCK_NAME)
  if (readOwner(file) !== process.pid) return
  try {
    unlinkSync(file)
  } catch {
    // already gone
  }
}

// ---------- Chromium over the pipe ----------

class Browser {
  constructor(owner, child, callMs) {
    this.owner = owner
    this.child = child
    this.pipeIn = child.stdio[3] // Chromium reads its commands from fd 3
    this.pipeOut = child.stdio[4] // and writes its answers and events to fd 4
    this.callMs = callMs
    this.buf = Buffer.alloc(0)
    this.nextId = 0
    this.pending = new Map()
    this.alive = true
    this.reason = ''
  }

  static async start({ owner, chromePath, profileDir, sandbox, callMs }) {
    const child = spawn(chromePath, chromeArgs({ profileDir, sandbox }), {
      stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
      env: process.env
    })
    const browser = new Browser(owner, child, callMs)
    browser.wire()
    try {
      await browser.call('Target.getTargets', {}, undefined, 30000)
    } catch (e) {
      await browser.close()
      throw new BrowserError(`could not start Chromium (${browser.reason || describe(e)})`)
    }
    return browser
  }

  wire() {
    this.pipeOut.on('data', chunk => this.receive(chunk))
    this.pipeOut.on('error', () => {}) // a write to a dead Chromium is reported by 'close'
    this.pipeIn.on('error', () => {})
    this.pipeOut.on('close', () => this.gone('pipe closed'))
    this.child.once('exit', (code, signal) => this.gone(`exit ${signal || code}`))
    this.child.once('error', e => this.gone(`spawn ${e.code || 'error'}`))
  }

  receive(chunk) {
    this.buf = Buffer.concat([this.buf, chunk])
    const { frames, rest } = splitFrames(this.buf)
    this.buf = rest
    for (const text of frames) {
      let message
      try {
        message = JSON.parse(text)
      } catch {
        continue
      }
      const entry = this.pending.get(message.id)
      if (entry) {
        this.pending.delete(message.id)
        clearTimeout(entry.timer)
        if (message.error) entry.reject(new CdpError(message.error.message ?? 'error'))
        else entry.resolve(message.result ?? {})
      } else if (message.method) {
        this.owner.event(this, message.method, message.params ?? {}, message.sessionId)
      }
    }
  }

  call(method, params = {}, sessionId = undefined, ms = this.callMs) {
    if (!this.alive) return Promise.reject(new BrowserError('the shared browser is not running'))
    const id = ++this.nextId
    const frame = { id, method, params }
    if (sessionId) frame.sessionId = sessionId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new BrowserError(`${method} timed out after ${Math.round(ms / 1000)} seconds`))
      }, ms)
      this.pending.set(id, { timer, resolve, reject })
      this.pipeIn.write(encodeFrame(frame))
    })
  }

  gone(reason) {
    if (!this.alive) return
    this.alive = false
    this.reason = reason
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new BrowserError('the shared browser stopped'))
    }
    this.pending.clear()
    this.pipeIn.destroy()
    this.pipeOut.destroy()
    this.owner.browserGone(this, reason)
  }

  /** Closing the pipe makes Chromium exit; SIGTERM and then SIGKILL cover a Chromium that does not. */
  async close(graceMs = 10000) {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      const exited = new Promise(resolve => this.child.once('exit', resolve))
      this.pipeIn.destroy()
      this.child.kill('SIGTERM')
      const timer = setTimeout(() => this.child.kill('SIGKILL'), graceMs)
      await exited
      clearTimeout(timer)
    }
    this.gone('closed')
  }
}

// ---------- the pool: people, contexts, tabs ----------

class Tab {
  constructor(name, target, session) {
    this.name = name
    this.target = target
    this.session = session
    this.mutex = new Mutex()
    this.loadWaiters = new Set()
    this.log = []
    this.width = 0
    this.accept = false // whether dialogs are accepted for the command now running
    this.height = 900
  }

  note(line) {
    this.log.push(line)
    if (this.log.length > CONSOLE_LIMIT) this.log.splice(0, this.log.length - CONSOLE_LIMIT)
  }
}

class Person {
  constructor(who) {
    this.who = who
    this.tabs = new Map()
    this.used = Date.now()
    this.mutex = new Mutex()
    this.context = null
    this.browser = null
    this.ready = null
  }
}

function remoteText(arg) {
  if ('value' in arg) return typeof arg.value === 'object' ? JSON.stringify(arg.value) : String(arg.value)
  return arg.description ?? ''
}

function waitForLoad(tab, ms) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      tab.loadWaiters.delete(done)
      resolve(true)
    }
    const timer = setTimeout(() => {
      tab.loadWaiters.delete(done)
      resolve(false)
    }, ms)
    tab.loadWaiters.add(done)
  })
}

class Pool {
  constructor(cfg) {
    this.cfg = cfg
    this.people = new Map()
    this.sessions = new Map()
    this.notes = new Map()
    this.browser = null
    this.lastUsed = Date.now()
    this.stopping = false
    this.startLock = new Mutex()
    this.stopped = new Promise((resolve) => {
      this.resolveStopped = resolve
    })
  }

  async ensureBrowser() {
    if (this.browser?.alive) return this.browser
    return this.startLock.run(async () => {
      if (this.browser?.alive) return this.browser
      if (!this.cfg.chromium) {
        throw new BrowserError('no Chromium: set chromium in crew.json, or CREW_BROWSER_CHROMIUM or CHROMIUM')
      }
      mkdirSync(this.cfg.profileDir, { recursive: true, mode: 0o700 })
      const browser = await Browser.start({
        owner: this,
        chromePath: this.cfg.chromium,
        profileDir: this.cfg.profileDir,
        sandbox: this.cfg.sandbox,
        callMs: this.cfg.callMs
      })
      this.browser = browser
      log(`chromium pid ${browser.child.pid}`)
      return browser
    })
  }

  /** Called by a Browser when its pipe or process ends: everyone's session is gone with it. */
  browserGone(browser, reason) {
    if (this.browser !== browser) return
    this.browser = null
    log(`browser stopped (${reason})`)
    for (const person of this.people.values()) this.notes.set(person.who, crashNote(Boolean(this.cfg.prepare)))
    this.people.clear()
    this.sessions.clear()
  }

  event(browser, method, params, sessionId) {
    if (method === 'Target.detachedFromTarget') {
      const tab = this.sessions.get(params.sessionId)
      if (tab) this.forgetTab(tab)
      return
    }
    const tab = this.sessions.get(sessionId)
    if (!tab) return
    if (method === 'Page.loadEventFired') {
      for (const done of [...tab.loadWaiters]) done()
    } else if (method === 'Page.javascriptDialogOpening') {
      // Dismissed unless the command asked for accepting: an accepted confirm can delete things. The
      // note carries the type only, so a page's dialog text never reaches the console.
      tab.note(`dialog ${params.type} ${tab.accept ? 'accepted' : 'dismissed'}`)
      browser.call('Page.handleJavaScriptDialog', { accept: tab.accept }, sessionId).catch(() => {})
    } else if (method === 'Runtime.consoleAPICalled') {
      tab.note(`console.${params.type}: ${(params.args ?? []).map(remoteText).join(' ')}`)
    } else if (method === 'Runtime.exceptionThrown') {
      const details = params.exceptionDetails ?? {}
      tab.note(`exception: ${details.exception?.description ?? details.text ?? ''}`)
    } else if (method === 'Log.entryAdded') {
      const entry = params.entry ?? {}
      tab.note(`${entry.source}.${entry.level}: ${entry.text}`)
    }
  }

  forgetTab(tab) {
    this.sessions.delete(tab.session)
    for (const person of this.people.values()) {
      if (person.tabs.get(tab.name) === tab) person.tabs.delete(tab.name)
    }
  }

  person(who) {
    let person = this.people.get(who)
    if (!person && this.people.size >= this.cfg.maxPeople) {
      throw new BrowserError(`the shared browser is full: ${this.cfg.maxPeople} people are using it; a person frees a place with done`)
    }
    if (!person) {
      person = new Person(who)
      this.people.set(who, person)
      person.ready = this.createContext(person).catch((e) => {
        if (this.people.get(who) === person) this.people.delete(who)
        throw e
      })
    }
    return person.ready.then(() => person)
  }

  async createContext(person) {
    const browser = await this.ensureBrowser()
    person.browser = browser
    const { browserContextId } = await browser.call('Target.createBrowserContext')
    person.context = browserContextId
    if (this.cfg.prepare) {
      try {
        await this.cfg.prepare(person.who, (cmd, args = {}) => this.run(cmd, person, args), {
          setCookies: cookies => this.setCookies(person, cookies)
        })
      } catch (e) {
        await this.release(person)
        throw e
      }
    }
  }

  tab(person, name, browser) {
    return person.mutex.run(async () => {
      const have = person.tabs.get(name)
      if (have) return have
      if (person.tabs.size >= MAX_TABS) {
        throw new BrowserError(`${person.who} already has ${MAX_TABS} tabs; close-tab one`)
      }
      const { targetId } = await browser.call('Target.createTarget', { url: 'about:blank', browserContextId: person.context })
      const { sessionId } = await browser.call('Target.attachToTarget', { targetId, flatten: true })
      const tab = new Tab(name, targetId, sessionId)
      person.tabs.set(name, tab)
      this.sessions.set(sessionId, tab)
      try {
        for (const method of ['Page.enable', 'Runtime.enable', 'Log.enable']) {
          await browser.call(method, {}, sessionId)
        }
      } catch (e) {
        this.forgetTab(tab)
        throw e
      }
      return tab
    })
  }

  /** Runs one command as one person. The person's context must already exist. */
  async run(cmd, person, args) {
    const browser = person.browser
    if (!browser || browser !== this.browser || !browser.alive) {
      throw new BrowserError('the shared browser stopped; try again')
    }
    person.used = Date.now()
    if (cmd === 'tabs') return [...person.tabs.keys()].sort()
    if (cmd === 'close-tab') {
      const tab = person.tabs.get(args.tab)
      if (!tab) throw new BrowserError(`no tab ${args.tab}`)
      return tab.mutex.run(async () => {
        await browser.call('Target.closeTarget', { targetId: tab.target })
        this.forgetTab(tab)
        return 'closed'
      })
    }
    const tab = await this.tab(person, args.tab ?? DEFAULT_TAB, browser)
    return tab.mutex.run(() => this.tabCommand(cmd, browser, tab, args))
  }

  async tabCommand(cmd, browser, tab, args) {
    tab.accept = args.accept_dialogs ?? this.cfg.acceptDialogs
    const send = (method, params = {}) => browser.call(method, params, tab.session)
    if (cmd === 'goto') {
      await this.size(tab, args, send)
      const loaded = waitForLoad(tab, LOAD_MS)
      const nav = await send('Page.navigate', { url: args.url })
      if (nav.errorText) throw new BrowserError(nav.errorText)
      await loaded
      await this.size(tab, {}, send)
      const where = await send('Runtime.evaluate', { expression: 'location.href + \' - \' + document.title', returnByValue: true })
      return where.result?.value ?? ''
    }
    if (cmd === 'shot') {
      checkShotPath(args.file, { overwrite: args.overwrite })
      await this.size(tab, args, send)
      const params = { format: 'png', captureBeyondViewport: Boolean(args.full) }
      if (args.full) {
        const metrics = await send('Page.getLayoutMetrics')
        const size = metrics.cssContentSize ?? metrics.contentSize
        params.clip = { x: 0, y: 0, width: size.width, height: size.height, scale: 1 }
      }
      const { data } = await send('Page.captureScreenshot', params)
      await writeShot(args.file, Buffer.from(data, 'base64'), Boolean(args.overwrite))
      return args.file
    }
    if (cmd === 'eval') {
      const reply = await send('Runtime.evaluate', { expression: args.js, returnByValue: true, awaitPromise: true })
      if (reply.exceptionDetails) {
        const details = reply.exceptionDetails
        throw new BrowserError(details.exception?.description ?? details.text ?? 'the script threw')
      }
      const value = reply.result ?? {}
      return 'value' in value ? value.value : value.description ?? null
    }
    if (cmd === 'send') return send(args.method, args.params ?? {})
    if (cmd === 'console') return tab.log.splice(0)
    throw new BrowserError(`unknown command ${cmd}`)
  }

  async size(tab, args, send) {
    if (args.width) tab.width = args.width
    if (args.height) tab.height = args.height
    if (tab.width) {
      await send('Emulation.setDeviceMetricsOverride', {
        width: tab.width,
        height: tab.height,
        deviceScaleFactor: 1,
        mobile: tab.width < 800
      })
    }
  }

  async release(person) {
    if (this.people.get(person.who) === person) this.people.delete(person.who)
    for (const tab of person.tabs.values()) this.sessions.delete(tab.session)
    person.tabs.clear()
    const browser = person.browser
    if (person.context && browser && browser === this.browser && browser.alive) {
      await browser.call('Target.disposeBrowserContext', { browserContextId: person.context }).catch(() => {})
    }
  }

  /**
   * Sets cookies on one person's context and no other. Driver-internal: the login seam calls it
   * through its session argument, and the call is not in the send allowlist. Each cookie needs a
   * name, a value and an http or https URL; the values are never logged.
   */
  async setCookies(person, cookies) {
    if (!Array.isArray(cookies) || cookies.length > 64) throw new BrowserError('cookies must be a list of 64 or fewer')
    for (const cookie of cookies) {
      const ok = cookie && typeof cookie.name === 'string' && typeof cookie.value === 'string'
        && typeof cookie.url === 'string' && /^https?:\/\//.test(cookie.url)
      if (!ok) throw new BrowserError('a cookie needs a name, a value and an http or https URL')
    }
    const browser = person.browser
    if (!browser || browser !== this.browser || !browser.alive) {
      throw new BrowserError('the shared browser stopped; try again')
    }
    await browser.call('Storage.setCookies', { cookies, browserContextId: person.context })
  }

  /** Answers one request: the person's note (if any) comes with it. */
  async handle({ cmd, who, args }) {
    if (cmd === 'status') return { result: this.status(), note: null }
    if (cmd === 'shutdown') {
      setTimeout(() => this.stop(), 50) // after the answer has gone out
      return { result: 'stopping', note: null }
    }
    if (cmd === 'done') {
      this.notes.delete(who)
      const person = this.people.get(who)
      if (person) await this.release(person)
      return { result: 'done', note: null }
    }
    this.lastUsed = Date.now()
    const note = this.notes.get(who) ?? null
    this.notes.delete(who)
    try {
      const person = await this.person(who)
      person.used = Date.now()
      const result = await withTimeout(this.run(cmd, person, args), this.cfg.requestMs, cmd)
      person.used = Date.now()
      return { result, note }
    } catch (e) {
      if (note) this.notes.set(who, note) // the command failed before the note was seen
      log(`${cmd} ${who} failed: ${e.name}`)
      throw e
    }
  }

  status() {
    const now = Date.now()
    return [...this.people.values()].map(person => ({
      who: person.who,
      tabs: [...person.tabs.keys()].sort(),
      idle_seconds: Math.floor((now - person.used) / 1000)
    }))
  }

  reap() {
    if (this.stopping) return
    const now = Date.now()
    for (const person of [...this.people.values()]) {
      if (now - person.used > this.cfg.idleMs) {
        this.notes.set(person.who, idleNote(person.who, this.cfg.idleMs / 1000))
        log(`expired ${person.who}`)
        this.release(person).catch(() => {})
      }
    }
    if (this.people.size === 0 && now - this.lastUsed > this.cfg.exitMs) this.stop()
  }

  stop() {
    if (this.stopping) return
    this.stopping = true
    this.resolveStopped()
  }

  async closeBrowser() {
    const browser = this.browser
    this.browser = null
    this.people.clear()
    this.sessions.clear()
    if (browser) await browser.close()
  }
}

function serveConnection(conn, pool) {
  conn.setEncoding('utf8')
  conn.setTimeout(10000)
  conn.on('error', () => {}) // a client that went away (EPIPE) is not our problem
  let buf = ''
  let answered = false
  conn.on('timeout', () => {
    if (!answered) conn.destroy()
  })
  conn.on('data', (chunk) => {
    if (answered) return
    buf += chunk
    const newline = buf.indexOf('\n')
    if (newline < 0 && buf.length > MAX_LINE) {
      answered = true
      return reply(conn, { ok: false, error: 'BrowserError: the request is too large' })
    }
    if (newline < 0) return
    answered = true
    conn.setTimeout(0)
    answer(buf.slice(0, newline), pool).then(resp => reply(conn, resp))
  })
}

async function answer(line, pool) {
  let req
  try {
    req = parseRequest(line)
  } catch (e) {
    return { ok: false, error: describe(e) }
  }
  try {
    const { result, note } = await pool.handle(req)
    return { ok: true, result: result ?? null, note }
  } catch (e) {
    return { ok: false, error: describe(e) }
  }
}

function reply(conn, resp) {
  if (!conn.destroyed) conn.end(`${JSON.stringify(resp)}\n`)
}

function listen(server, path) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => {
      server.off('error', reject)
      resolve()
    })
  })
}

/**
 * The driver itself (daemon mode). Resolves 'busy' when a live driver owns dir, 'stopped' when it
 * has shut down. options: dir, chromium, prepare(who, call), idleSeconds, exitSeconds,
 * callSeconds, requestSeconds, signals. Each defaults to the environment (see the header).
 */
export async function serve(options = {}) {
  const cfg = resolveConfig(options)
  const dirFd = openDirectory(cfg.dir)
  if (!socketPathFits(cfg.sock)) {
    closeSync(dirFd)
    throw new BrowserError('the state directory is too long for a unix socket path')
  }
  if (!(await acquireLock(cfg.dir, cfg.sock))) {
    closeSync(dirFd)
    log(`another driver owns ${cfg.dir}; leaving its socket alone`)
    return 'busy'
  }
  const umask = process.umask(0o077)
  const pool = new Pool(cfg)
  let server = null
  let reaper = null
  const onSignal = () => pool.stop()
  const teardown = async () => {
    clearInterval(reaper)
    if (cfg.signals) {
      process.off('SIGTERM', onSignal)
      process.off('SIGINT', onSignal)
    }
    if (server?.listening) server.close()
    try {
      unlinkSync(cfg.sock)
    } catch {
      // not there
    }
    await pool.closeBrowser()
    releaseLock(cfg.dir)
    closeSync(dirFd)
    process.umask(umask)
    log('stopped')
  }
  try {
    try {
      unlinkSync(cfg.sock) // we hold the lock, so nobody is listening on it
    } catch {
      // none
    }
    await pool.ensureBrowser()
    // The folder and the lock are checked again just before the socket appears.
    if (!sameFolder(cfg.dir, dirFd)) throw new BrowserError('the state folder changed while the driver started')
    keepLock(cfg.dir)
    if (readOwner(join(cfg.dir, LOCK_NAME)) !== process.pid) throw new BrowserError('the lock was taken by another driver')
    server = net.createServer(conn => serveConnection(conn, pool))
    await listen(server, cfg.sock)
    chmodSync(cfg.sock, 0o600)
  } catch (e) {
    await teardown()
    throw e
  }
  if (cfg.signals) {
    process.on('SIGTERM', onSignal)
    process.on('SIGINT', onSignal)
  }
  reaper = setInterval(() => {
    keepLock(cfg.dir)
    pool.reap()
  }, cfg.reapMs)
  log('ready')
  await pool.stopped
  await teardown()
  return 'stopped'
}

// ---------- the client ----------

function spawnDaemon(dir, chromium, seam) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const out = openSync(join(dir, LOG_NAME), 'a', 0o600)
  const env = { ...process.env, CREW_BROWSER_DIR: dir }
  if (chromium) env.CREW_BROWSER_CHROMIUM = chromium
  try {
    spawn(process.execPath, [SELF, '_daemon', ...(seam ? [] : ['--no-seam'])], { cwd: dir, env, detached: true, stdio: ['ignore', out, out] }).unref()
  } finally {
    closeSync(out)
  }
}

function exchange(conn, message) {
  return new Promise((resolve, reject) => {
    let buf = ''
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      conn.destroy()
      if (error) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(() => finish(new BrowserError('no answer from the shared browser')), CLIENT_REPLY_MS)
    conn.setEncoding('utf8')
    conn.on('data', (chunk) => {
      buf += chunk
      const newline = buf.indexOf('\n')
      if (newline < 0) return
      try {
        finish(null, JSON.parse(buf.slice(0, newline)))
      } catch {
        finish(new BrowserError('bad answer from the shared browser'))
      }
    })
    conn.on('error', e => finish(new BrowserError(`connection failed: ${e.code ?? e.name}`)))
    conn.on('end', () => finish(new BrowserError('the shared browser closed the connection')))
    conn.write(`${JSON.stringify(message)}\n`)
  })
}

/**
 * Sends one command. Resolves { result, note }, or null when nothing is running and start is false.
 * Starts the driver when none is running and start is true. Throws when the command fails.
 */
export async function request({ dir = defaultDir(), who = null, cmd, args = {}, start = true, chromium = '', seam = true }) {
  const sock = join(dir, SOCKET_NAME)
  let conn = await connectTo(sock, 500)
  if (!conn) {
    if (!start) return null
    const deadline = Date.now() + START_DEADLINE_MS
    let spawnedAt = null
    while (!conn) {
      if (Date.now() > deadline) throw new BrowserError(`the shared browser did not start; see ${join(dir, LOG_NAME)}`)
      if (spawnedAt === null || Date.now() - spawnedAt > SPAWN_RETRY_MS) {
        spawnDaemon(dir, chromium, seam)
        spawnedAt = Date.now()
      }
      await sleep(200)
      conn = await connectTo(sock, 500)
    }
  }
  const reply = await exchange(conn, { cmd, who, args })
  if (!reply.ok) throw new Error(reply.error)
  return { result: reply.result ?? null, note: reply.note ?? null }
}

async function main(argv) {
  if (argv[0] === '_daemon') {
    process.on('uncaughtException', (e) => {
      log(`crashed: ${e.name}`)
      process.exit(1)
    })
    process.on('unhandledRejection', (e) => {
      log(`crashed: ${e?.name ?? 'rejection'}`)
      process.exit(1)
    })
    const seam = argv.includes('--no-seam') ? {} : await import(pathToFileURL(join(KIT_DIR, 'browser.mjs')).href)
    await serve({ prepare: seam.prepare })
    process.exit(0)
  }
  const parsed = parseCli(argv)
  if (parsed.help) {
    console.log(USAGE)
    return
  }
  const start = parsed.cmd !== 'status' && parsed.cmd !== 'shutdown'
  const reply = await request({ who: parsed.who, cmd: parsed.cmd, args: parsed.args, start, chromium: findChromium() })
  if (reply === null) {
    console.log(parsed.cmd === 'status' ? '[]' : 'not running')
    return
  }
  if (reply.note) console.error(`note: ${reply.note}`)
  console.log(typeof reply.result === 'string' ? reply.result : JSON.stringify(reply.result, null, 1))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message)
    process.exitCode = 1
  })
}
