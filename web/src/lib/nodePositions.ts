import type { EdgeRoute } from './edgeRoute'

// Persists manually-dragged (and auto-anchored) node positions so a
// background refresh or an unrelated filter change doesn't wipe out a
// user's manual layout — see finishLayout's reconciliation in lib/layout.ts.
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
//
// `arrangementKey` is LayoutPlan.arrangementKey (lib/layout.ts): the explicit
// 'vertical' / 'horizontal' as before, but for 'auto' with several
// namespaces the shape it resolved to ('auto:rows4', 'auto:vertical', …).
// Since issue #81 'auto' resolves from the canvas's size and aspect, so the
// same scope can come out as a different grid on another screen; each shape
// keeps its own positions instead of a 4-row grid inheriting coordinates
// dragged on a single strip. Positions saved under the bare pre-#81
// '<scope>|auto' key were laid out for the old strip/stack and are simply
// no longer read for multi-namespace views.
export function positionScopeKey(namespaceKey: string, arrangementKey: string): string {
  return `${namespaceKey}|${arrangementKey}`
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
    localStorage.removeItem(routesStorageKey(scopeKey))
  } catch {
    // Nothing to clean up if storage isn't available.
  }
}

// The ELK route each edge was last drawn with (issue #39), persisted under
// the same scope as the positions it was computed against: a route only
// fits the node positions it came with, so once persisted positions outlive
// the ELK layout they came from (topology changed since), the stored route
// is what still connects them — see selectRoutes in lib/layout.ts. Cleared
// together with positions by clearNodePositions (Rearrange).
const ROUTES_STORAGE_PREFIX = 'kubelynx.edgeRoutes.'

function routesStorageKey(scopeKey: string): string {
  return `${ROUTES_STORAGE_PREFIX}${scopeKey}`
}

function isPoint(value: unknown): value is { x: number; y: number } {
  return (
    !!value &&
    typeof (value as { x: unknown }).x === 'number' &&
    typeof (value as { y: unknown }).y === 'number'
  )
}

function isEdgeRoute(value: unknown): value is EdgeRoute {
  const route = value as EdgeRoute
  return (
    !!route &&
    Array.isArray(route.points) &&
    route.points.length >= 2 &&
    route.points.every(isPoint) &&
    isPoint(route.source) &&
    isPoint(route.target)
  )
}

export function loadEdgeRoutes(scopeKey: string): Map<string, EdgeRoute> {
  try {
    const raw = localStorage.getItem(routesStorageKey(scopeKey))
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (!parsed || typeof parsed !== 'object') return new Map()
    return new Map(Object.entries(parsed).filter((entry): entry is [string, EdgeRoute] => isEdgeRoute(entry[1])))
  } catch {
    return new Map()
  }
}

export function saveEdgeRoutes(scopeKey: string, routes: Map<string, EdgeRoute>): void {
  try {
    localStorage.setItem(routesStorageKey(scopeKey), JSON.stringify(Object.fromEntries(routes)))
  } catch {
    // Without it, routes just fall back to the floating elbow sooner.
  }
}
