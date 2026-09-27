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
