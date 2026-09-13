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
export function loadFlowsPanelWidth(viewportWidth: number): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed = raw === null ? NaN : Number(raw)
    return Number.isFinite(parsed)
      ? clampFlowsPanelWidth(parsed, viewportWidth)
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
