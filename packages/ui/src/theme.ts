/**
 * Light, dark, or whatever the machine says.
 *
 * The page followed `prefers-color-scheme` and nothing else, which is the right
 * default and the wrong only option: the operator reading in a bright room on a
 * machine set to dark had no way to say so.
 *
 * Three states rather than a toggle, because "follow the system" is a real
 * answer and not the same as either of the other two — a two-state switch would
 * silently freeze whichever value it happened to start on.
 *
 * The choice is a browser preference, kept in `localStorage` and never sent
 * anywhere: it says nothing about the notes, and two people reading the same
 * project should not be arguing over it.
 */

export type Theme = 'auto' | 'light' | 'dark'

const KEY = 'mnemonima.theme'
const THEMES: readonly Theme[] = ['auto', 'light', 'dark']

const listeners = new Set<() => void>()
let choice: Theme = 'auto'

function read(): Theme {
  try {
    const stored = localStorage.getItem(KEY)
    return THEMES.includes(stored as Theme) ? (stored as Theme) : 'auto'
  } catch {
    return 'auto'
  }
}

function write(theme: Theme): void {
  try {
    if (theme === 'auto') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, theme)
  } catch {
    // A browser that refuses storage still gets a working switch, for as long
    // as the page is open.
  }
}

function systemIsDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

function resolved(): 'light' | 'dark' {
  if (choice !== 'auto') return choice
  return systemIsDark() ? 'dark' : 'light'
}

/**
 * Stamps the **resolved** theme on the document, `auto` included.
 *
 * Resolving here rather than in a media query is what keeps the dark palette to
 * one block of CSS. A stylesheet cannot share one rule between `@media
 * (prefers-color-scheme: dark)` and `:root[data-theme="dark"]`, so the other
 * arrangement means writing the palette out twice and maintaining both.
 *
 * `data-theme` is what the stylesheet keys off; `color-scheme` is what the
 * *browser* keys off — scrollbars, form controls, the default canvas — and none
 * of those are ours to paint.
 */
function apply(): void {
  const now = resolved()

  document.documentElement.setAttribute('data-theme', now)
  document.documentElement.style.setProperty('color-scheme', now)

  for (const listener of listeners) listener()
}

export function currentTheme(): Theme {
  return choice
}

export function setTheme(theme: Theme): void {
  choice = theme
  write(theme)
  apply()
}

/** What the page is actually showing, once `auto` has been resolved. */
export function isDark(): boolean {
  return resolved() === 'dark'
}

/**
 * Called whenever the resolved theme may have changed — the operator picking
 * one, or the system changing under `auto`.
 *
 * The graph needs this: a canvas is the one part of the page CSS cannot
 * restyle, so it repaints itself from here.
 */
export function onThemeChange(listener: () => void): void {
  listeners.add(listener)
}

export function startTheme(): void {
  choice = read()
  apply()

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (choice === 'auto') apply()
  })
}
