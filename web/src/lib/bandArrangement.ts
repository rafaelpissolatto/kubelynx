// How layoutSwimlanes (lib/layout.ts) arranges namespace bands when more
// than one namespace is in view. 'auto' is resolved down to 'vertical' or
// 'horizontal' inside layoutGraph, based on namespace count and viewport
// height — see resolveBandArrangement there.
export type BandArrangement = 'vertical' | 'horizontal' | 'auto'

export const BAND_ARRANGEMENTS: BandArrangement[] = ['vertical', 'horizontal', 'auto']
export const DEFAULT_BAND_ARRANGEMENT: BandArrangement = 'auto'

const STORAGE_KEY = 'kubelynx.bandArrangement'

function isBandArrangement(value: string): value is BandArrangement {
  return (BAND_ARRANGEMENTS as string[]).includes(value)
}

// localStorage access is wrapped in try/catch for the same reason as
// resizablePanel.ts and theme.ts: private browsing, disabled storage, or
// quota errors shouldn't break the app, they just mean the choice resets to
// the default.
export function loadBandArrangement(): BandArrangement {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw !== null && isBandArrangement(raw) ? raw : DEFAULT_BAND_ARRANGEMENT
  } catch {
    return DEFAULT_BAND_ARRANGEMENT
  }
}

export function saveBandArrangement(arrangement: BandArrangement): void {
  try {
    localStorage.setItem(STORAGE_KEY, arrangement)
  } catch {
    // Persistence is a nice-to-have; losing it silently is fine.
  }
}
