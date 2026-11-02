// Task comment Markdown, without a DOM. Run:
//   node --import tsx --test tests/comment-markdown.test.ts
// The sanitiser needs the browser and is checked there; these tests cover what the
// renderer itself must guarantee before any sanitising happens.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCommentMarked } from '../shared/utils/commentMarkdown'
import { escapeMarkdown } from '../shared/utils/inlineMarkdown'

const commentMarked = createCommentMarked()

const render = (markdown: string) => commentMarked.parse(markdown, { async: false }) as string

// What a reader sees: line breaks kept, markup removed, entities decoded.
function visibleText(html: string): string {
  return html
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<\/p>\n<p>/g, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
}

// Both sides of a comparison go through this: no-break spaces read as spaces, a
// line of spaces alone is an empty line, runs of empty lines count as one, and the
// empty lines at the start and end are dropped. Nothing inside a line is changed.
function normalize(text: string): string {
  const kept: string[] = []
  for (const raw of text.replace(/\xa0/g, ' ').split('\n')) {
    const line = /^ *$/.test(raw) ? '' : raw
    if (line === '' && kept[kept.length - 1] === '') continue
    kept.push(line)
  }
  while (kept[0] === '') kept.shift()
  while (kept[kept.length - 1] === '') kept.pop()
  return kept.join('\n')
}

const TYPED = [
  '*stars* and **bold**',
  '_under_ and snake_case_name',
  '`code` and ``double``',
  '# not a heading',
  '- not a list',
  '1. not a list',
  '> not a quote',
  '| a | b |',
  '<script>x</script>',
  'a & b',
  'AT&amp;T',
  '==x==',
  '[l](http://x)',
  '![img](http://x/y.png)',
  '<b>bold</b> text',
  'back\\slash and \\* twice',
  '+ plus item',
  'line one\n- two\n# three\n1. four',
  '*open then\n close*',
  '**mixed** _marks_ `and` [link](https://example.com) ~~gone~~',
  'snake_case and a & b',
  '<b>x</b>',
  'Tom & Jerry <3',
  'sum 2*3*4',
  '_x_ and _leading',
  '    indented typed',
  '\tTabbed line'
]

// Covers escapeMarkdown alone: what it writes, drawn by the comment renderer, reads back as
// the typed text. The composer's mark wrapping (bold, italic, links) is not run here.
// Leading whitespace beyond three spaces is drawn as no-break spaces, so those are
// read back as spaces.
test('escapeMarkdown round trip: the drawn text equals what was typed', () => {
  for (const typed of TYPED) {
    const drawn = normalize(visibleText(render(escapeMarkdown(typed))))
    const expected = normalize(typed.replace(/\t/g, ' '))
    assert.equal(drawn, expected, `typed ${JSON.stringify(typed)} drew as ${JSON.stringify(drawn)}`)
  }
})

test('Pietje case: a script line, then a fence and a dash list, all before sanitising', () => {
  const html = render('<script>alert(1)</script>\n```\ncode line\n```\n- dash one\n- dash two')
  assert.ok(!html.includes('<script'), 'no script element comes out of the renderer')
  assert.ok(html.includes('<pre>'), 'the fence is a code block')
  assert.ok(html.includes('<li>'), 'the dash lines are list items')
})

test('a javascript: link and an image leave no live href or src', () => {
  const link = render('[bad](javascript:alert(1))')
  assert.ok(!/href=/.test(link), `unsafe link drawn as ${link}`)
  assert.ok(link.includes('bad'), 'the link text is kept')

  const image = render('![pic](http://x.test/a.png)')
  assert.ok(!/<img|src=/.test(image), `image drawn as ${image}`)
  assert.ok(image.includes('pic'), 'the alt text is kept')
})

// Seeded, so a failure reproduces: the same strings every run.
function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Every class of string the escaper promises to round-trip. Nothing is excluded: the
// no-break spaces stand for leading and trailing spaces, and normalize() reads them
// back as spaces, so a trailing double space or a four-space indent holds too.
const FUZZ_ALPHABET = ['*', '_', '`', '~', '=', '[', ']', '(', ')', '#', '>', '-', '+', '|', '\\', '.', '1', 'a', ' ', '\n', ':', '/', '&', '<']

test('fuzz: 3000 seeded strings draw back as typed', () => {
  const random = seededRandom(20260211)
  for (let run = 0; run < 3000; run++) {
    const length = 1 + Math.floor(random() * 14)
    let typed = ''
    for (let i = 0; i < length; i++) typed += FUZZ_ALPHABET[Math.floor(random() * FUZZ_ALPHABET.length)]
    const drawn = normalize(visibleText(render(escapeMarkdown(typed))))
    assert.equal(drawn, normalize(typed), `run ${run}: typed ${JSON.stringify(typed)} drew as ${JSON.stringify(drawn)}`)
  }
})

test('lone markup characters are written as typed, with no backslash', () => {
  for (const typed of ['a = b', '[note', 'cost ~5', '5 * 3', 'a_b and 2_3', 'x ` y']) {
    assert.equal(escapeMarkdown(typed), typed)
  }
})

test('a line break inside a paired mark still escapes both halves', () => {
  assert.equal(escapeMarkdown('*open\nclose*'), '\\*open\nclose*')
})

test('a line that starts with a bullet or a heading is escaped', () => {
  assert.equal(escapeMarkdown('- item'), '\\- item')
  assert.equal(escapeMarkdown('# head'), '\\# head')
})

test('a safe link keeps its href', () => {
  assert.ok(render('[ok](https://x.test/a)').includes('href="https://x.test/a"'))
})

test('escapes only what forms markup; raw svg and math are drawn as text', () => {
  assert.equal(escapeMarkdown('snake_case and a & b'), 'snake_case and a & b')
  assert.equal(escapeMarkdown('<b>x</b> Tom & Jerry <3'), '<b>x</b> Tom & Jerry <3')
  assert.equal(escapeMarkdown('_x_'), '\\_x\\_')
  for (const html of ['<svg><script>x</script>visible</svg>', '<math><style>x</style>visible</math>']) {
    const out = render(html)
    assert.ok(!/<(svg|math|script|style)/.test(out), `no element from ${html}: ${out}`)
    assert.equal(normalize(visibleText(out)), html)
  }
})
