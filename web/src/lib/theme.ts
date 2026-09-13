// Theme is what the user picked; 'system' defers to the OS/browser's
// prefers-color-scheme rather than a fixed choice. resolveTheme collapses
// that down to the two concrete values the DOM (data-theme attribute) and
// CSS actually branch on.
export type Theme = 'dark' | 'light' | 'system'
export type ResolvedTheme = 'dark' | 'light'

export const THEMES: Theme[] = ['dark', 'light', 'system']
export const DEFAULT_THEME: Theme = 'system'

const STORAGE_KEY = 'kubelynx.theme'

function isTheme(value: string): value is Theme {
  return (THEMES as string[]).includes(value)
}

export function resolveTheme(theme: Theme, systemPrefersDark: boolean): ResolvedTheme {
  if (theme === 'system') return systemPrefersDark ? 'dark' : 'light'
  return theme
}

// localStorage access is wrapped in try/catch for the same reason as
// resizablePanel.ts: private browsing, disabled storage, or quota errors
// shouldn't break the app, they just mean the choice resets to the default.
export function loadTheme(): Theme {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw !== null && isTheme(raw) ? raw : DEFAULT_THEME
  } catch {
    return DEFAULT_THEME
  }
}

export function saveTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    // Persistence is a nice-to-have; losing it silently is fine.
  }
}
