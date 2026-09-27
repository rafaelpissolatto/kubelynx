// Persists manually-dragged (and auto-anchored) node positions so a
// background refresh or an unrelated filter change doesn't wipe out a
// user's manual layout — see layoutGraph's reconciliation in lib/layout.ts.
// Scoped per namespace selection (not protocol): the same node id can
// legitimately appear in different namespace views, but the protocol filter
// only changes which edges are shown, not the node set, so positions stay
// valid across it.
export type NodePositionMap = Record<string, { x: number; y: number }>

const STORAGE_PREFIX = 'kubelynx.nodePositions.'

function storageKey(namespaceKey: string): string {
  return `${STORAGE_PREFIX}${namespaceKey}`
}

// localStorage access is wrapped in try/catch for the same reason as
// resizablePanel.ts/theme.ts/bandArrangement.ts: private browsing, disabled
// storage, or quota errors shouldn't break the app, they just mean layout
// resets to fresh auto-layout instead of staying stable.
export function loadNodePositions(namespaceKey: string): NodePositionMap {
  try {
    const raw = localStorage.getItem(storageKey(namespaceKey))
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as NodePositionMap) : {}
  } catch {
    return {}
  }
}

export function saveNodePositions(namespaceKey: string, positions: NodePositionMap): void {
  try {
    localStorage.setItem(storageKey(namespaceKey), JSON.stringify(positions))
  } catch {
    // Persistence is a nice-to-have; losing it silently is fine.
  }
}

export function clearNodePositions(namespaceKey: string): void {
  try {
    localStorage.removeItem(storageKey(namespaceKey))
  } catch {
    // Nothing to clean up if storage isn't available.
  }
}
