// What the update composer writes for the text a person typed.
//
// An update is stored as Markdown and drawn by the renderer task comments use
// (shared/utils/commentMarkdown.ts). That renderer draws raw HTML, `&`, and a lone
// `<`, `>`, `*`, `_`, `=` or `~` literally, so those are escaped only when the line
// holds a partner that would make them markup:
//   * `*`, `` ` ``, `~`, `=`: when the same character occurs later in the text.
//   * `_`: unless it sits between two letters or digits (snake_case stays).
//   * `[` and `]`: all of them, when a `[` comes before a `]` (a bracket pair).
//   * `<`: when a `>` comes after it (an autolink).
//   * `\`: when it would eat the next character (punctuation, or the line end).
// Lone characters are written as typed, so `a = b`, `cost ~5` and `[note` show no
// backslashes. The partner check runs over the whole text, because emphasis and
// code spans can run across a line break.
// Block starts at the start of a line are always escaped: # > + - | : = * and a
// number followed by `.` or `)`. Leading and trailing spaces and tabs become
// no-break spaces: marked would otherwise read four spaces as a code block, drop
// the indentation of a continued line, or make a hard break. Once drawn, a no-break
// space is read as a space, so nothing is lost.

const WORD = /[\p{L}\p{N}]/u
// ASCII punctuation, which a backslash escapes.
const PUNCTUATION = /[!-/:-@[-`{-~]/
const BLOCK_START = new Set(['#', '>', '+', '-', '|', ':', '=', '*'])
const ORDERED_START = /^\d+[.)]/
const NBSP = '\xa0' // no-break space, written as an escape so it is visible in source

function isSpace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t'
}

/** Escapes text the person typed, so it is drawn exactly as typed. */
export function escapeMarkdown(text: string): string {
  const escape = new Array<boolean>(text.length).fill(false)

  // Partners across the whole text: a markup character needs a later twin.
  for (const ch of ['*', '`', '~', '=']) {
    const last = text.lastIndexOf(ch)
    for (let i = 0; i < last; i++) {
      if (text[i] === ch) escape[i] = true
    }
  }
  const firstOpen = text.indexOf('[')
  if (firstOpen !== -1 && text.lastIndexOf(']') > firstOpen) {
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '[' || text[i] === ']') escape[i] = true
    }
  }
  // A `<` makes markup only as an autolink, `<scheme:...>`; other `<` stay as typed.
  const autolink = /^<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*>/
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '<' && autolink.test(text.slice(i))) escape[i] = true
  }
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '_') escape[i] = !(WORD.test(text[i - 1] ?? '') && WORD.test(text[i + 1] ?? ''))
    if (text[i] === '\\') escape[i] = i + 1 >= text.length || text[i + 1] === '\n' || PUNCTUATION.test(text[i + 1]!)
  }

  let offset = 0
  return text.split('\n').map((line) => {
    const start = offset
    offset += line.length + 1
    const first = line.search(/[^ \t]/)
    if (first !== -1) {
      if (BLOCK_START.has(line[first]!)) escape[start + first] = true
      const ordered = ORDERED_START.exec(line.slice(first))
      if (ordered) escape[start + first + ordered[0].length - 1] = true
    }

    // Edge whitespace: everything before the first and after the last non-space.
    let lead = 0
    while (lead < line.length && isSpace(line[lead])) lead++
    let trail = line.length
    while (trail > lead && isSpace(line[trail - 1])) trail--

    let out = ''
    for (let k = 0; k < line.length; k++) {
      const ch = line[k]!
      if (isSpace(ch) && (k < lead || k >= trail)) out += NBSP
      else if (escape[start + k]) out += `\\${ch}`
      else out += ch
    }
    return out
  }).join('\n')
}
