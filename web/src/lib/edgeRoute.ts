type Point = { x: number; y: number }

// An edge path ELK computed during layout (issue #39): obstacle-aware
// orthogonal routing through bend points, rather than a client-side elbow
// between two endpoints. `source`/`target` record where ELK placed the two
// endpoint nodes, since the route is only valid relative to those spots.
export type EdgeRoute = { points: Point[]; source: Point; target: Point }

// Movement below this (in flow units) is treated as "not moved", absorbing
// float noise from repeated position round-trips through storage.
const MOVE_TOLERANCE = 0.5

// ELK's route stays valid as long as both endpoints moved by the same offset
// since layout — untouched nodes, or a namespace band dragged as one block —
// in which case it's shifted by that offset. If the endpoints moved
// independently (a node was dragged), the route no longer connects them
// and null is returned, so the caller falls back to its own geometry.
export function placeRoute(route: EdgeRoute, source: Point, target: Point): Point[] | null {
  const dx = source.x - route.source.x
  const dy = source.y - route.source.y
  const tdx = target.x - route.target.x
  const tdy = target.y - route.target.y
  if (Math.abs(dx - tdx) > MOVE_TOLERANCE || Math.abs(dy - tdy) > MOVE_TOLERANCE) return null
  return route.points.map((p) => ({ x: p.x + dx, y: p.y + dy }))
}

export type Rect = { x: number; y: number; width: number; height: number }

// Boxes a route may graze without counting as "through" them: ELK keeps
// edges at least edgeNodeBetweenLayers away from nodes, so only a real
// overlap — not float noise at a shared border — should disqualify a route.
const OBSTACLE_INSET = 2

// Whether an axis-aligned segment crosses the interior of `rect`. ELK's
// ORTHOGONAL routes only ever contain horizontal and vertical segments, so
// an interval-overlap test is exact here.
function segmentHitsRect(a: Point, b: Point, rect: Rect): boolean {
  const left = rect.x + OBSTACLE_INSET
  const right = rect.x + rect.width - OBSTACLE_INSET
  const top = rect.y + OBSTACLE_INSET
  const bottom = rect.y + rect.height - OBSTACLE_INSET
  return (
    Math.max(a.x, b.x) > left &&
    Math.min(a.x, b.x) < right &&
    Math.max(a.y, b.y) > top &&
    Math.min(a.y, b.y) < bottom
  )
}

export function routeCrossesAny(points: Point[], obstacles: Iterable<Rect>): boolean {
  for (const rect of obstacles) {
    for (let i = 1; i < points.length; i++) {
      if (segmentHitsRect(points[i - 1], points[i], rect)) return true
    }
  }
  return false
}

// Picks the first candidate route that still connects the edge's endpoints
// at their current positions (placeRoute) and doesn't pass through any
// other workload box. A route can go stale without its own endpoints moving
// — ELK computed it around neighbors that persisted positions (#43) or a
// drag have since put somewhere else — and drawing it then would look like
// a deliberate obstacle-aware path while cutting straight through a box.
// Returns null when no candidate qualifies; the caller falls back to its
// obstacle-unaware geometry.
export function chooseRoute(
  candidates: EdgeRoute[],
  source: Point,
  target: Point,
  obstacles: Rect[],
): { index: number; points: Point[] } | null {
  for (let index = 0; index < candidates.length; index++) {
    const points = placeRoute(candidates[index], source, target)
    if (points && !routeCrossesAny(points, obstacles)) return { index, points }
  }
  return null
}

// SVG path through `points` with each bend rounded by up to `radius`
// (clamped so adjacent corners never overlap), plus the point halfway along
// the polyline's length for the edge label.
export function roundedPolylinePath(points: Point[], radius: number): [path: string, labelX: number, labelY: number] {
  let d = `M ${points[0].x},${points[0].y}`
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1]
    const corner = points[i]
    const next = points[i + 1]
    const inLength = Math.hypot(corner.x - prev.x, corner.y - prev.y)
    const outLength = Math.hypot(next.x - corner.x, next.y - corner.y)
    const r = Math.min(radius, inLength / 2, outLength / 2)
    if (r <= 0) {
      d += ` L ${corner.x},${corner.y}`
      continue
    }
    const start = { x: corner.x - ((corner.x - prev.x) / inLength) * r, y: corner.y - ((corner.y - prev.y) / inLength) * r }
    const end = { x: corner.x + ((next.x - corner.x) / outLength) * r, y: corner.y + ((next.y - corner.y) / outLength) * r }
    d += ` L ${start.x},${start.y} Q ${corner.x},${corner.y} ${end.x},${end.y}`
  }
  const last = points[points.length - 1]
  d += ` L ${last.x},${last.y}`

  const lengths = points.slice(1).map((p, i) => Math.hypot(p.x - points[i].x, p.y - points[i].y))
  let remaining = lengths.reduce((sum, l) => sum + l, 0) / 2
  for (let i = 0; i < lengths.length; i++) {
    if (remaining <= lengths[i] && lengths[i] > 0) {
      const t = remaining / lengths[i]
      return [d, points[i].x + (points[i + 1].x - points[i].x) * t, points[i].y + (points[i + 1].y - points[i].y) * t]
    }
    remaining -= lengths[i]
  }
  return [d, last.x, last.y]
}
