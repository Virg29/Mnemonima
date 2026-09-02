import { Lexer } from 'marked'
import type { Token, Tokens } from 'marked'

/**
 * The markdown renderer for the previews — the editor's and the graph's.
 *
 * `marked` does the parsing; the markup is assembled here, token by token.
 * That division is the point. A note body is operator-authored text this page
 * did not write, so the set of tags that can reach the document has to be a
 * list somebody chose, not whatever the input contained: raw HTML in a note is
 * rendered as the text it is, and a link is dropped unless its scheme is one of
 * ours. Handing a library a string and putting its output into `innerHTML`
 * gives that decision away.
 *
 * It replaced a hand-rolled line loop that covered headings, paragraphs, bullet
 * lists, quotes and fences and nothing else. Tables are the reason: notes in a
 * real project are full of them, and a table rendered as five lines of pipes is
 * not a preview of anything. Ordered lists, nested lists, task lists, images
 * and rules came with the parser rather than as five more regular expressions.
 *
 * `core/markdown.ts` is still the parser of record. Everything the engine
 * derives — chunks, the outline, links, terms — comes from remark on the
 * server. This one only has to look right.
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char)
}

/**
 * Only http(s), mailto and our own hash routes.
 *
 * A preview must not turn a note body into a `javascript:` link, and a note
 * that legitimately mentions some other scheme is better served by seeing the
 * target than by a link that does nothing.
 */
function safeHref(href: string): string | null {
  const trimmed = href.trim()
  return /^(https?:\/\/|mailto:|#|\/)/i.test(trimmed) ? trimmed : null
}

const WIKILINK = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g

/**
 * `[[SL-0042 Shaders introduction|the basics]]` becomes a route into this page.
 *
 * Not markdown, so the lexer hands the text through untouched and it is picked
 * apart here. The leading token is the id — what the exported filenames lead
 * with and what the resolver reads first.
 */
function wikilinks(escaped: string): string {
  return escaped.replace(WIKILINK, (whole, target: string, label: string | undefined) => {
    const id = target.trim().split(/\s+/)[0] ?? target.trim()
    return `<a href="#note/${encodeURIComponent(id)}" class="wiki">${label ?? target}</a>`
  })
}

/** A run of inline tokens, or the raw text when the lexer produced none. */
function inline(tokens: readonly Token[] | undefined, raw: string): string {
  if (tokens === undefined) return wikilinks(escape(raw))
  return tokens.map((token) => inlineToken(token)).join('')
}

function inlineToken(token: Token): string {
  switch (token.type) {
    case 'text': {
      const text = token as Tokens.Text
      return text.tokens === undefined
        ? wikilinks(escape(text.text))
        : inline(text.tokens, text.text)
    }

    case 'escape':
      return escape((token as Tokens.Escape).text)

    case 'strong':
      return `<strong>${inline((token as Tokens.Strong).tokens, token.raw)}</strong>`

    case 'em':
      return `<em>${inline((token as Tokens.Em).tokens, token.raw)}</em>`

    case 'del':
      return `<del>${inline((token as Tokens.Del).tokens, token.raw)}</del>`

    case 'codespan':
      return `<code>${escape((token as Tokens.Codespan).text)}</code>`

    case 'br':
      return '<br>'

    case 'link': {
      const link = token as Tokens.Link
      const href = safeHref(link.href)
      const label = inline(link.tokens, link.text)
      return href === null
        ? `${label} (${escape(link.href)})`
        : `<a href="${escape(href)}">${label}</a>`
    }

    case 'image': {
      const image = token as Tokens.Image
      const src = safeHref(image.href)
      const alt = escape(image.text)
      return src === null
        ? `${alt} (${escape(image.href)})`
        : `<img src="${escape(src)}" alt="${alt}">`
    }

    // Raw HTML is shown as the text it is. Notes carry `<T>` and `<br/>` in
    // prose, and neither is markup this page should execute.
    case 'html':
      return escape((token as Tokens.HTML).raw)

    default:
      return wikilinks(escape(token.raw))
  }
}

function alignment(align: string | null | undefined): string {
  return align === null || align === undefined ? '' : ` style="text-align:${escape(align)}"`
}

function block(token: Token): string {
  switch (token.type) {
    case 'space':
      return ''

    case 'heading': {
      const heading = token as Tokens.Heading
      const level = Math.min(6, Math.max(1, heading.depth))
      return `<h${level}>${inline(heading.tokens, heading.text)}</h${level}>`
    }

    case 'paragraph':
      return `<p>${inline((token as Tokens.Paragraph).tokens, token.raw)}</p>`

    case 'text': {
      const text = token as Tokens.Text
      return text.tokens === undefined
        ? wikilinks(escape(text.text))
        : inline(text.tokens, text.text)
    }

    case 'code': {
      const code = token as Tokens.Code
      const language = (code.lang ?? '').trim().split(/\s+/)[0] ?? ''
      const attribute = /^[\w+.#-]+$/.test(language) ? ` class="language-${escape(language)}"` : ''
      return `<pre><code${attribute}>${escape(code.text)}</code></pre>`
    }

    case 'blockquote':
      return `<blockquote>${blocks((token as Tokens.Blockquote).tokens)}</blockquote>`

    case 'hr':
      return '<hr>'

    case 'list': {
      const list = token as Tokens.List
      const tag = list.ordered ? 'ol' : 'ul'
      const start = list.ordered && Number(list.start) > 1 ? ` start="${Number(list.start)}"` : ''
      return `<${tag}${start}>${list.items.map((item) => listItem(item)).join('')}</${tag}>`
    }

    case 'table': {
      const table = token as Tokens.Table

      const head = table.header
        .map(
          (cell, index) =>
            `<th${alignment(table.align[index])}>${inline(cell.tokens, cell.text)}</th>`,
        )
        .join('')

      const body = table.rows
        .map(
          (row) =>
            `<tr>${row
              .map(
                (cell, index) =>
                  `<td${alignment(table.align[index])}>${inline(cell.tokens, cell.text)}</td>`,
              )
              .join('')}</tr>`,
        )
        .join('')

      return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
    }

    case 'html':
      return `<p>${escape((token as Tokens.HTML).raw.trim())}</p>`

    default:
      return `<p>${wikilinks(escape(token.raw))}</p>`
  }
}

/**
 * A list item, with a task list's checkbox drawn but disabled.
 *
 * Disabled because this is a preview: the body is the source of truth and the
 * editor is where it changes. A box that ticked without writing anything would
 * be a lie about what had happened.
 */
function listItem(item: Tokens.ListItem): string {
  const box = item.task
    ? `<input type="checkbox" disabled${item.checked === true ? ' checked' : ''}> `
    : ''

  return `<li${item.task ? ' class="task"' : ''}>${box}${blocks(item.tokens)}</li>`
}

function blocks(tokens: readonly Token[]): string {
  return tokens
    .map((token) => block(token))
    .filter((html) => html !== '')
    .join('\n')
}

export function renderMarkdown(source: string): string {
  // `gfm` is what brings tables, strikethrough and task lists. `breaks` is off
  // because a note body is wrapped prose, and a hard break per line would
  // double the height of every paragraph.
  return blocks(new Lexer({ gfm: true, breaks: false }).lex(source))
}
