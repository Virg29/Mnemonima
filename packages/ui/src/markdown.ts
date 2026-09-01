/**
 * A small markdown renderer for the editor's preview.
 *
 * Deliberately not the parser of record. `core/markdown.ts` is that, it runs
 * with remark on the server, and everything the engine derives — chunks,
 * outline, links, terms — comes from there. This is a preview: it exists so the
 * operator can see the shape of what they are typing, and it covers the
 * constructs a note actually uses.
 *
 * Bundling remark into the page to render a preview would add most of a
 * markdown toolchain to a browser bundle for a job that does not need to be
 * exact. What it does need to be is safe: a note body is operator-authored text
 * that this page did not write, so every character is escaped before any markup
 * is added, and the only tags that appear are the ones produced here.
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

/** Everything except code spans, applied to already-escaped text. */
function marks(text: string): string {
  return (
    text
      .replace(
        /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g,
        (_, target: string, label: string | undefined) => {
          const id = target.trim().split(/\s+/)[0] ?? target.trim()
          return `<a href="#note/${encodeURIComponent(id)}" class="wiki">${label ?? target}</a>`
        },
      )
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label: string, href: string) =>
        // Only http(s) and our own hashes: a preview must not turn a note body
        // into a javascript: link.
        /^(https?:|#)/.test(href) ? `<a href="${href}">${label}</a>` : `${label} (${href})`,
      )
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
  )
}

/**
 * Inline constructs.
 *
 * Split on backticks rather than substituting a placeholder for each code span:
 * the odd segments are code and are left exactly as written, the even ones get
 * the rest of the syntax. A placeholder would have to be a string that cannot
 * occur in the text, and every candidate for that is either a control character
 * or something a note could plausibly contain.
 */
function inline(text: string): string {
  return text
    .split('`')
    .map((segment, index) => (index % 2 === 1 ? `<code>${segment}</code>` : marks(segment)))
    .join('')
}

export function renderMarkdown(source: string): string {
  const out: string[] = []
  const lines = source.split('\n')

  let paragraph: string[] = []
  let list: string[] | null = null
  let fence: string[] | null = null

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    out.push(`<p>${inline(escape(paragraph.join(' ')))}</p>`)
    paragraph = []
  }

  const flushList = (): void => {
    if (list === null) return
    out.push(`<ul>${list.map((item) => `<li>${inline(escape(item))}</li>`).join('')}</ul>`)
    list = null
  }

  for (const line of lines) {
    if (fence !== null) {
      if (line.startsWith('```')) {
        out.push(`<pre><code>${escape(fence.join('\n'))}</code></pre>`)
        fence = null
      } else {
        fence.push(line)
      }
      continue
    }

    if (line.startsWith('```')) {
      flushParagraph()
      flushList()
      fence = []
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null) {
      flushParagraph()
      flushList()
      const level = heading[1]?.length ?? 1
      out.push(`<h${level}>${inline(escape(heading[2] ?? ''))}</h${level}>`)
      continue
    }

    const item = /^\s*[-*+]\s+(.*)$/.exec(line)
    if (item !== null) {
      flushParagraph()
      list ??= []
      list.push(item[1] ?? '')
      continue
    }

    const quote = /^>\s?(.*)$/.exec(line)
    if (quote !== null) {
      flushParagraph()
      flushList()
      out.push(`<blockquote>${inline(escape(quote[1] ?? ''))}</blockquote>`)
      continue
    }

    if (line.trim() === '') {
      flushParagraph()
      flushList()
      continue
    }

    flushList()
    paragraph.push(line)
  }

  if (fence !== null) out.push(`<pre><code>${escape(fence.join('\n'))}</code></pre>`)
  flushParagraph()
  flushList()

  return out.join('\n')
}
