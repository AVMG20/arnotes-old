import { createHash } from 'node:crypto'
import { copyFileSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

// The crew kit as one gzipped tarball with the kit at its root (crew.mjs, config.mjs, ...).
// Only the files that crew/kit-files.txt lists are packed, never anything else that might sit
// in crew/ (a token file, a creds file, a log). No secret is in the kit.
//
// The archive is byte-stable: entries sorted by name, owner, group, mtime and mode fixed, and
// gzip without a name or timestamp. Blaze reinstalls only when the bytes change, so the same
// kit must always pack to the same bytes. tests/crew-kit.test.ts checks that.
// The Dockerfile and nix/arnotes.nix read the same list and refuse the same things.
const LIST = 'kit-files.txt'
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

// Where the kit's files are: CREW_KIT_DIR (the nix package sets it), else crew/ in the working directory.
export function crewKitDir(): string {
  return process.env.CREW_KIT_DIR || join(process.cwd(), 'crew')
}

/** The names in kit-files.txt, sorted. A bad name is an error, not a skipped line. */
export function kitFileNames(dir: string): string[] {
  let text: string
  try {
    text = readFileSync(join(dir, LIST), 'utf8')
  } catch {
    throw new Error(`crew kit: ${LIST} is missing from ${dir}`)
  }
  const names = text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
  for (const name of names) {
    if (!NAME.test(name) || name.includes('..')) {
      throw new Error(`crew kit: "${name}" in ${LIST} is not a plain file name`)
    }
  }
  if (names.length === 0) throw new Error(`crew kit: ${LIST} lists no files`)
  return names.sort()
}

// A listed name must be a regular file in the kit folder: not missing, not a symlink (even one
// that points inside the folder), not a folder. A symlink would ship whatever it points at.
export function regularFile(dir: string, name: string): string {
  const path = join(dir, name)
  let info
  try {
    info = lstatSync(path)
  } catch {
    throw new Error(`crew kit: ${name} is listed in ${LIST} but does not exist in ${dir}`)
  }
  if (!info.isFile()) {
    throw new Error(`crew kit: ${name} is not a regular file (symlinks and folders are refused)`)
  }
  return path
}

// One ustar header block (512 bytes) for a regular file.
function tarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512)
  const put = (text: string, at: number, length: number) => header.write(text, at, length, 'latin1')
  put(name, 0, 100)
  put('0000644\0', 100, 8) // mode
  put('0000000\0', 108, 8) // uid
  put('0000000\0', 116, 8) // gid
  put(`${size.toString(8).padStart(11, '0')}\0`, 124, 12)
  put('00000000000\0', 136, 12) // mtime: the epoch, always
  put('        ', 148, 8) // checksum placeholder (spaces while summing)
  put('0', 156, 1) // regular file
  put('ustar\u000000', 257, 8)
  put('root', 265, 32)
  put('root', 297, 32)
  let sum = 0
  for (const byte of header) sum += byte
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8)
  return header
}

/** Packs the kit's files from dir into a byte-stable .tar.gz. Pure: no cache, no request. */
export function packCrewKit(dir: string): { archive: Buffer, version: string, files: string[] } {
  const files = kitFileNames(dir)
  const blocks: Buffer[] = []
  for (const name of files) {
    const body = readFileSync(regularFile(dir, name))
    blocks.push(tarHeader(name, body.length))
    const padding = (512 - (body.length % 512)) % 512
    blocks.push(body, Buffer.alloc(padding))
  }
  blocks.push(Buffer.alloc(1024)) // end of archive
  // gzipSync writes a fixed header (no file name, mtime 0), so the same tar gives the same bytes.
  const archive = gzipSync(Buffer.concat(blocks), { level: 9 })
  const version = createHash('sha256').update(archive).digest('hex').slice(0, 12)
  return { archive, version, files }
}

/** Copies exactly the listed regular files from src to dest (the Docker image and the nix package use it). */
export function copyCrewKit(src: string, dest: string): string[] {
  const files = kitFileNames(src).map(name => ({ name, path: regularFile(src, name) }))
  mkdirSync(dest, { recursive: true })
  for (const { name, path } of files) copyFileSync(path, join(dest, name))
  return files.map(file => file.name)
}

let cache: { key: string, kit: ReturnType<typeof packCrewKit> } | null = null

/** The kit for the server's crew/ folder, packed once per change of a listed file. */
export function buildCrewKit(dir = crewKitDir()) {
  const key = kitFileNames(dir)
    .map((name) => {
      const info = lstatSync(regularFile(dir, name))
      return `${name}:${info.mtimeMs}:${info.size}`
    })
    .join('|')
  if (!cache || cache.key !== key) cache = { key, kit: packCrewKit(dir) }
  return cache.kit
}
