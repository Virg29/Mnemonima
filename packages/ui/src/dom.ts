/**
 * The smallest set of DOM helpers this UI needs.
 *
 * No framework: every screen renders once from data it just fetched, and the
 * one place that genuinely needs incremental updates — the graph — is a canvas
 * driven by sigma. A virtual DOM would be machinery in service of nothing.
 *
 * `el` sets text through `textContent`, never `innerHTML`. Note bodies, titles
 * and terms are operator-authored text that reaches this page as data, and the
 * one place that renders markup — the preview — goes through an explicit
 * escape.
 */

type Attributes = Record<string, string | number | boolean | ((event: Event) => void)>

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Attributes = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)

  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === 'function') {
      node.addEventListener(key.replace(/^on/, ''), value as EventListener)
    } else if (key === 'class') {
      node.className = String(value)
    } else if (key === 'text') {
      node.textContent = String(value)
    } else if (value === false) {
      // An absent attribute, not `disabled="false"`, which is still disabled.
    } else {
      node.setAttribute(key, value === true ? '' : String(value))
    }
  }

  for (const child of children) {
    node.append(typeof child === 'string' ? document.createTextNode(child) : child)
  }

  return node
}

export function clear(node: Element): void {
  while (node.firstChild !== null) node.firstChild.remove()
}

export function table(headings: string[], rows: (Node | string)[][]): HTMLElement {
  return el('table', { class: 'grid' }, [
    el('thead', {}, [el('tr', {}, headings.map((heading) => el('th', { text: heading })))]),
    el(
      'tbody',
      {},
      rows.map((row) =>
        el(
          'tr',
          {},
          row.map((cell) => el('td', {}, [cell])),
        ),
      ),
    ),
  ])
}

export function empty(message: string, hint?: string): HTMLElement {
  return el('div', { class: 'empty' }, [
    el('p', { text: message }),
    ...(hint === undefined ? [] : [el('p', { class: 'hint', text: hint })]),
  ])
}

/** Milliseconds as something a human reads without counting zeros. */
export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`
  return `${(ms / 3_600_000).toFixed(1)} h`
}

export function when(timestamp: number): string {
  return new Date(timestamp).toLocaleString()
}
