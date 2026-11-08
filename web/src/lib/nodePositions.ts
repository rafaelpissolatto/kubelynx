import type { BandArrangement } from './bandArrangement'

// Persists manually-dragged (and auto-anchored) node positions so a
// background refresh or an unrelated filter change doesn't wipe out a
// user's manual layout — see layoutGraph's reconciliation in lib/layout.ts.
// Scoped per namespace selection and band arrangement (not protocol): the
// same node id can legitimately appear in different namespace views, but the
// protocol filter only changes which edges are shown, not the node set, so
// positions stay valid across it.
export type NodePositionMap = Record<string, { x: number; y: number }>

const STORAGE_PREFIX = 'kubelynx.nodePositions.'

function storageKey(scopeKey: string): string {
  return `${STORAGE_PREFIX}${scopeKey}`
}

// Positions saved under one band arrangement are meaningless under another
// (bands stacked vs. side by side), and reusing them would pin every node in
// place so switching arrangement had no visible effect (issue #51). Keying by
// arrangement too means a switch lays out fresh, while each arrangement
// keeps its own manual tweaks for when the user switches back.
export function positionScopeKey(namespaceKey: string, arrangement: BandArrangement): string {
  return `${namespaceKey}|${arrangement}`
}

// localStorage access is wrapped in try/catch for the same reason as
// resizablePanel.ts/theme.ts/bandArrangement.ts: private browsing, disabled
// storage, or quota errors shouldn't break the app, they just mean layout
// resets to fresh auto-layout instead of staying stable.
export function loadNodePositions(scopeKey: string): NodePositionMap {
  try {
    const raw = localStorage.getItem(storageKey(scopeKey))
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as NodePositionMap) : {}
  } catch {
    return {}
  }
}

export function saveNodePositions(scopeKey: string, positions: NodePositionMap): void {
  try {
    localStorage.setItem(storageKey(scopeKey), JSON.stringify(positions))
  } catch {
    // Persistence is a nice-to-have; losing it silently is fine.
  }
}

export function clearNodePositions(scopeKey: string): void {
  try {
    localStorage.removeItem(storageKey(scopeKey))
  } catch {
    // Nothing to clean up if storage isn't available.
  }
}
