// The Markdown renderer for task comments, kept free of the DOM and of Nuxt so
// the tests can run it under node. app/utils/markdown.ts builds the instance the
// app draws with and adds the sanitiser (a second layer) after it.
import { Marked, type TokenizerAndRendererExtension } from 'marked'

/** Escapes the characters a text node would otherwise read as markup. */
export function escapeTextChars(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Links only to schemes a reader can safely be sent to; anything else is drawn as
// its text. The sanitiser uses this same list (app/utils/markdown.ts).
export const SAFE_URL = /^(https?:|mailto:|#|\/)/i

// `==text==` → `<mark>`, which Marked has no syntax for.
export const highlightExtension: TokenizerAndRendererExtension = {
  name: 'highlight',
  level: 'inline' as const,
  start: (src: string) => src.indexOf('=='),
  tokenizer(src: string) {
    const match = /^==(?=\S)([^\n]*?\S)==/.exec(src)
    if (!match) return undefined
    return { type: 'highlight', raw: match[0], tokens: this.lexer.inlineTokens(match[1]!) }
  },
  renderer(token) {
    return `<mark>${this.parser.parseInline(token.tokens ?? [])}</mark>`
  }
}

/**
 * A task comment's Markdown renderer. Raw HTML is drawn as the text it was typed
 * as, never as markup, and `&` is not read as an entity, so a stored row draws as
 * it was written. The HTML block tokenizer is off: it would run to the next blank
 * line and swallow the Markdown after a line such as `<script>...`. Links with an
 * unsafe scheme and images are drawn as their text, so no live href or src is
 * left for the sanitiser to take out.
 */
export function createCommentMarked(): Marked {
  return new Marked({
    gfm: true,
    breaks: true,
    extensions: [highlightExtension],
    tokenizer: { html: () => undefined },
    renderer: {
      html: token => escapeTextChars(token.text),
      text(token) {
        return 'tokens' in token && token.tokens ? this.parser.parseInline(token.tokens) : escapeTextChars(token.text)
      },
      link({ href, title, tokens }) {
        const inner = this.parser.parseInline(tokens)
        if (!SAFE_URL.test(href.trim())) return inner
        const titleAttr = title ? ` title="${escapeTextChars(title)}"` : ''
        return `<a href="${escapeTextChars(href)}"${titleAttr}>${inner}</a>`
      },
      image({ text }) {
        return escapeTextChars(text)
      }
    }
  })
}
