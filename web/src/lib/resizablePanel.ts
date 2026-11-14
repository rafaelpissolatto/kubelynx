// Bounds and persistence for the resizable flows panel (see App.tsx). Kept as
// pure/isolated functions so the clamping and storage logic can be reasoned
// about (and tested) independently of the drag-event wiring.

export const MIN_FLOWS_PANEL_WIDTH = 280
export const MAX_FLOWS_PANEL_WIDTH = 720
export const DEFAULT_FLOWS_PANEL_WIDTH = 340
// The graph canvas needs at least this much room to stay usable — the
// panel's effective max is capped below MAX_FLOWS_PANEL_WIDTH on a narrow
// viewport so it can't swallow the whole window (see clampFlowsPanelWidth).
export const MIN_CANVAS_WIDTH = 480

const STORAGE_KEY = 'kubelynx.flowsPanelWidth'

// Below this viewport width the panel and the canvas can't both get their
// minimum side by side, so the layout stacks instead: the canvas takes the
// full width and the flows panel goes below it (#97). This is the only place
// the breakpoint is defined; App.tsx sets data-layout="stacked" from it and
// App.css keys off that attribute, so the CSS and the clamp can't drift.
export const STACKED_LAYOUT_MAX_WIDTH = MIN_FLOWS_PANEL_WIDTH + MIN_CANVAS_WIDTH

export function isStackedLayout(viewportWidth: number): boolean {
  return viewportWidth < STACKED_LAYOUT_MAX_WIDTH
}

// The panel width to render side by side at viewportWidth. The canvas keeps
// at least MIN_CANVAS_WIDTH whenever the layout isn't stacked; below the
// breakpoint the result is MIN_FLOWS_PANEL_WIDTH, but the stacked layout
// doesn't use it.
export function clampFlowsPanelWidth(width: number, viewportWidth: number): number {
  const effectiveMax = Math.max(
    MIN_FLOWS_PANEL_WIDTH,
    Math.min(MAX_FLOWS_PANEL_WIDTH, viewportWidth - MIN_CANVAS_WIDTH),
  )
  return Math.min(effectiveMax, Math.max(MIN_FLOWS_PANEL_WIDTH, width))
}

// localStorage access is wrapped in try/catch: private browsing, disabled
// storage, or quota errors shouldn't break the app — they just mean the
// width resets to the default instead of persisting.
//
// Returns the user's preferred width, bounded only by the panel's own
// min/max and not by the current viewport: App.tsx clamps it to the viewport
// at render time, so a narrow window (or a phone-width stacked layout)
// doesn't overwrite the saved width that applies again on a wider one.
export function loadFlowsPanelWidth(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed = raw === null ? NaN : Number(raw)
    return Number.isFinite(parsed)
      ? Math.min(MAX_FLOWS_PANEL_WIDTH, Math.max(MIN_FLOWS_PANEL_WIDTH, parsed))
      : DEFAULT_FLOWS_PANEL_WIDTH
  } catch {
    return DEFAULT_FLOWS_PANEL_WIDTH
  }
}

export function saveFlowsPanelWidth(width: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(width))
  } catch {
    // Persistence is a nice-to-have; losing it silently is fine.
  }
}
