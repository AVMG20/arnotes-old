// The crew kit: byte-stable archive at the root, no secret in it, and one list of files that the
// packer, the Docker image and the nix package all copy through the same code. Run:
//   node --import tsx --test tests/crew-kit.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { gunzipSync } from 'node:zlib'
import { packCrewKit } from '../server/utils/crewKit'

const ROOT = process.cwd()
const KIT_DIR = join(ROOT, 'crew')
const COPY_SCRIPT = join(ROOT, 'scripts', 'copy-crew-kit.ts')

// The entries of an uncompressed ustar archive: name, mtime, owner and body.
function entries(archive: Buffer) {
  const out: { name: string, mtime: number, owner: string, body: Buffer }[] = []
  let at = 0
  while (at + 512 <= archive.length && archive[at] !== 0) {
    const field = (from: number, to: number) => archive.subarray(at + from, at + to).toString('latin1').replace(/\0.*$/s, '')
    const size = parseInt(field(124, 136), 8)
    out.push({ name: field(0, 100), mtime: parseInt(field(136, 148), 8), owner: field(265, 297), body: archive.subarray(at + 512, at + 512 + size) })
    at += 512 + Math.ceil(size / 512) * 512
  }
  return out
}

// The file names in the one list, without comments and blank lines.
function listedFiles(dir: string): string[] {
  return readFileSync(join(dir, 'kit-files.txt'), 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .sort()
}

// A throwaway kit folder with the given list and files; returns its path and a cleanup.
function tempKit(list: string | null, files: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'crew-kit-'))
  if (list !== null) writeFileSync(join(dir, 'kit-files.txt'), list)
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

// Runs the one copy script the image and the package use.
function runCopy(src: string, dest: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', COPY_SCRIPT, src, dest], { encoding: 'utf8' })
}

test('packing the kit twice gives the same bytes', () => {
  const first = packCrewKit(KIT_DIR)
  const second = packCrewKit(KIT_DIR)
  assert.ok(first.archive.equals(second.archive), 'the archive changed between two builds of the same kit')
  assert.equal(first.version, second.version)
})

test('the kit sits at the root of the archive, sorted, with fixed owner and mtime', () => {
  const { archive, files } = packCrewKit(KIT_DIR)
  const list = entries(gunzipSync(archive))
  assert.deepEqual(list.map(entry => entry.name), files)
  assert.deepEqual(files, [...files].sort())
  assert.ok(files.includes('crew.mjs'), 'the entry point crew.mjs is in the archive')
  assert.ok(files.every(name => !name.includes('/')), 'no folder prefix: the kit is at the root')
  for (const entry of list) {
    assert.equal(entry.mtime, 0)
    assert.equal(entry.owner, 'root')
  }
})

test('the packer and the copy script read the same list, and the image and package call the script', () => {
  const { files } = packCrewKit(KIT_DIR)
  assert.deepEqual(files, listedFiles(KIT_DIR), 'the packer ships other files than the list names')
  const script = readFileSync(COPY_SCRIPT, 'utf8')
  assert.match(script, /copyCrewKit/, 'the copy script does not use the packer code')
  const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8')
  const nix = readFileSync(join(ROOT, 'nix', 'arnotes.nix'), 'utf8')
  assert.match(dockerfile, /RUN bun scripts\/copy-crew-kit\.ts crew \/app\/crew-kit/, 'the Dockerfile does not run the copy script')
  assert.match(nix, /bun scripts\/copy-crew-kit\.ts crew "\$out\/lib\/arnotes\/crew"/, 'the nix package does not run the copy script')
})

test('the Dockerfile and the nix package never copy the crew folder or loop over the list in shell', () => {
  const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8')
  const nix = readFileSync(join(ROOT, 'nix', 'arnotes.nix'), 'utf8')
  for (const [name, text] of [['Dockerfile', dockerfile], ['nix/arnotes.nix', nix]] as const) {
    assert.doesNotMatch(text, /^\s*COPY\s+(--\S+\s+)*crew\/?\s/m, `${name} copies the crew folder`)
    assert.doesNotMatch(text, /cp -r\s+crew\b/, `${name} copies the crew folder`)
    assert.doesNotMatch(text, /while read/, `${name} has its own copy loop`)
  }
})

test('the image and the package filter out a kit working copy state and secrets', () => {
  const dockerignore = readFileSync(join(ROOT, '.dockerignore'), 'utf8')
  for (const name of ['crew/creds.json', 'crew/crew.json', 'crew/profiles', 'crew/.listen', 'crew/work', '**/*.env']) {
    assert.ok(dockerignore.split('\n').includes(name), `.dockerignore lacks ${name}`)
  }
  const nix = readFileSync(join(ROOT, 'nix', 'arnotes.nix'), 'utf8')
  for (const name of ['"creds.json"', '"profiles"', '".listen"', '"work"']) {
    assert.ok(nix.includes(name), `the nix source filter lacks ${name}`)
  }
})

test('no secret file, key or local path is in the archive or in SKILL.md', () => {
  const { archive, files } = packCrewKit(KIT_DIR)
  // A credentials file or an env file is never packed, whatever sits in crew/.
  assert.ok(!files.some(name => name === 'creds.json' || name.endsWith('.env')), 'a credentials or env file is packed')
  const text = gunzipSync(archive).toString('latin1')
  const patterns = [
    /arn_[A-Za-z0-9]{8,}/, // an API key
    /PRIVATE KEY/,
    /forge/i, // the local forge
    /\/home\//,
    /tokens/i
  ]
  const skill = readFileSync(join(KIT_DIR, 'SKILL.md'), 'latin1')
  for (const pattern of patterns) {
    assert.doesNotMatch(skill, pattern, `SKILL.md matches ${pattern}`)
    assert.doesNotMatch(text, pattern, `the archive matches ${pattern}`)
  }
})

test('a file in crew/ that is not on the list is left out of the archive', () => {
  const kit = tempKit('# the list\ncrew.mjs\n', { 'crew.mjs': '// entry\n', 'tokens.env': 'SECRET=planted\n', 'creds.json': '{}\n' })
  try {
    mkdirSync(join(kit.dir, 'profiles'))
    writeFileSync(join(kit.dir, 'profiles', 'x.mjs'), '// not shipped\n')
    const { archive, files } = packCrewKit(kit.dir)
    assert.deepEqual(files, ['crew.mjs'])
    assert.deepEqual(entries(gunzipSync(archive)).map(entry => entry.name), ['crew.mjs'])
  } finally {
    kit.done()
  }
})

test('the copy script copies exactly the listed files from a good kit', () => {
  const kit = tempKit('crew.mjs\nconfig.mjs\n', { 'crew.mjs': '// entry\n', 'config.mjs': '// config\n', 'creds.json': '{}\n', 'tokens.env': 'X=1\n' })
  const dest = mkdtempSync(join(tmpdir(), 'crew-kit-dest-'))
  try {
    mkdirSync(join(kit.dir, 'profiles'))
    const run = runCopy(kit.dir, join(dest, 'out'))
    assert.equal(run.status, 0, run.stderr)
    assert.deepEqual(readdirSync(join(dest, 'out')).sort(), ['config.mjs', 'crew.mjs'])
  } finally {
    kit.done()
    rmSync(dest, { recursive: true, force: true })
  }
})

test('the copy script fails when the list is missing', () => {
  const kit = tempKit(null, { 'crew.mjs': '// entry\n' })
  const dest = mkdtempSync(join(tmpdir(), 'crew-kit-dest-'))
  try {
    const run = runCopy(kit.dir, join(dest, 'out'))
    assert.notEqual(run.status, 0)
    assert.match(run.stderr, /kit-files\.txt is missing/)
  } finally {
    kit.done()
    rmSync(dest, { recursive: true, force: true })
  }
})

test('the copy script fails when the list is empty', () => {
  const kit = tempKit('# nothing listed\n\n', { 'crew.mjs': '// entry\n' })
  const dest = mkdtempSync(join(tmpdir(), 'crew-kit-dest-'))
  try {
    const run = runCopy(kit.dir, join(dest, 'out'))
    assert.notEqual(run.status, 0)
    assert.match(run.stderr, /lists no files/)
  } finally {
    kit.done()
    rmSync(dest, { recursive: true, force: true })
  }
})

test('a list with only comments and blank lines is refused by the script and the packer', () => {
  const kit = tempKit('# one\n\n# two\n   \n', { 'crew.mjs': '// entry\n' })
  const dest = mkdtempSync(join(tmpdir(), 'crew-kit-dest-'))
  try {
    const run = runCopy(kit.dir, join(dest, 'out'))
    assert.notEqual(run.status, 0)
    assert.match(run.stderr, /lists no files/)
    assert.throws(() => packCrewKit(kit.dir), /lists no files/)
  } finally {
    kit.done()
    rmSync(dest, { recursive: true, force: true })
  }
})

test('the copy script fails on a name that climbs out of the kit', () => {
  const kit = tempKit('crew.mjs\n../x\n', { 'crew.mjs': '// entry\n' })
  const dest = mkdtempSync(join(tmpdir(), 'crew-kit-dest-'))
  try {
    const run = runCopy(kit.dir, join(dest, 'out'))
    assert.notEqual(run.status, 0)
    assert.match(run.stderr, /not a plain file name/)
  } finally {
    kit.done()
    rmSync(dest, { recursive: true, force: true })
  }
})

test('the copy script fails on a listed symlink, even one into the kit', () => {
  const kit = tempKit('crew.mjs\nlink.mjs\n', { 'crew.mjs': '// entry\n' })
  const dest = mkdtempSync(join(tmpdir(), 'crew-kit-dest-'))
  try {
    symlinkSync(join(kit.dir, 'crew.mjs'), join(kit.dir, 'link.mjs'))
    const run = runCopy(kit.dir, join(dest, 'out'))
    assert.notEqual(run.status, 0)
    assert.match(run.stderr, /link\.mjs.*not a regular file/)
  } finally {
    kit.done()
    rmSync(dest, { recursive: true, force: true })
  }
})

test('the packer refuses a listed symlink that points outside the kit', () => {
  const outside = mkdtempSync(join(tmpdir(), 'crew-kit-outside-'))
  writeFileSync(join(outside, 'secret.env'), 'SECRET=outside\n')
  const kit = tempKit('crew.mjs\nlink.mjs\n', { 'crew.mjs': '// entry\n' })
  try {
    symlinkSync(join(outside, 'secret.env'), join(kit.dir, 'link.mjs'))
    assert.throws(() => packCrewKit(kit.dir), /link\.mjs.*not a regular file/)
  } finally {
    kit.done()
    rmSync(outside, { recursive: true, force: true })
  }
})

test('the packer refuses a listed name that does not exist', () => {
  const kit = tempKit('crew.mjs\nghost.mjs\n', { 'crew.mjs': '// entry\n' })
  try {
    assert.throws(() => packCrewKit(kit.dir), /ghost\.mjs.*does not exist/)
  } finally {
    kit.done()
  }
})

test('a list entry that is not a plain file name is refused', () => {
  for (const bad of ['../secret.env', 'sub/crew.mjs', '.env', '-rf', 'a b.mjs', 'x..y.mjs']) {
    const kit = tempKit(`${bad}\n`)
    try {
      assert.throws(() => packCrewKit(kit.dir), /not a plain file name/, `accepted ${bad}`)
    } finally {
      kit.done()
    }
  }
})
