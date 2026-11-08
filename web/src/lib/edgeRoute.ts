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

// Direction marks (issue #79): where to draw an edge's mid-edge chevron and
// its target arrowhead, as a point plus the direction of travel there
// (source -> target) in degrees.
export type DirectionMark = { x: number; y: number; angle: number }

// An axis-aligned box the chevron must stay `gap` away from, in flow units,
// centered on (x, y): the edge's label, or a workload box.
export type KeepClear = { x: number; y: number; halfWidth: number; halfHeight: number; gap: number }

function angleOf(a: Point, b: Point): number {
  return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI
}

// The target arrowhead sits on the path's last point, pointing along the
// last non-degenerate segment.
export function targetMark(points: Point[]): DirectionMark | null {
  const last = points[points.length - 1]
  for (let i = points.length - 2; i >= 0; i--) {
    if (points[i].x !== last.x || points[i].y !== last.y) return { ...last, angle: angleOf(points[i], last) }
  }
  return null
}

// Drops repeated points and points in the middle of a straight run, so a
// straight stretch counts as one segment. getSmoothStepPath splits even a
// perfectly straight elbow into collinear pieces at its stubs and center.
function straightRuns(points: Point[]): Point[] {
  const runs: Point[] = []
  for (const p of points) {
    const last = runs[runs.length - 1]
    if (last && last.x === p.x && last.y === p.y) continue
    const prev = runs[runs.length - 2]
    const collinear =
      prev &&
      Math.abs((last.x - prev.x) * (p.y - last.y) - (last.y - prev.y) * (p.x - last.x)) < 1e-6 &&
      (last.x - prev.x) * (p.x - last.x) + (last.y - prev.y) * (p.y - last.y) > 0
    if (collinear) {
      runs[runs.length - 1] = p
      continue
    }
    runs.push(p)
  }
  return runs
}

// The chevron goes at the middle of the polyline's longest segment — the
// straight run least likely to be crowded by neighbors, and never on a
// bend: each end of the segment keeps `cornerRadius` (the rounded corner)
// plus the chevron's own half-length clear. If that spot is covered by one
// of the `keepClear` boxes (the shown label, or a workload box an
// obstacle-unaware elbow runs behind, which would hide the chevron), it
// slides along the segment to the nearest free spot, preferring the target
// side on a tie; if the segment has none, the next-longest one is tried.
// Returns null when no segment has room (very short or fully covered
// edges), leaving the target arrowhead alone to show direction.
// `chevronHalf` is in flow units.
export function chevronMark(
  points: Point[],
  cornerRadius: number,
  chevronHalf: number,
  keepClear: KeepClear[],
): DirectionMark | null {
  const runs = straightRuns(points)
  const segments = runs
    .slice(1)
    .map((b, i) => ({ a: runs[i], b, length: Math.hypot(b.x - runs[i].x, b.y - runs[i].y) }))
    .sort((s1, s2) => s2.length - s1.length)
  for (const { a, b, length } of segments) {
    if (length === 0) break
    const margin = Math.min(cornerRadius, length / 2) + chevronHalf
    if (length < 2 * margin) break
    const ux = (b.x - a.x) / length
    const uy = (b.y - a.y) / length

    // The stretch of this segment each box covers, as distances from `a`,
    // widened by the chevron's half-length and the box's gap. Box extents
    // are measured along and across the segment.
    const blocked: [number, number][] = []
    for (const box of keepClear) {
      const along = Math.abs(ux) * box.halfWidth + Math.abs(uy) * box.halfHeight
      const across = Math.abs(uy) * box.halfWidth + Math.abs(ux) * box.halfHeight
      const center = (box.x - a.x) * ux + (box.y - a.y) * uy
      const offset = Math.abs((box.x - a.x) * uy - (box.y - a.y) * ux)
      const reach = chevronHalf + box.gap
      if (offset < across + reach) blocked.push([center - along - reach, center + along + reach])
    }
    const mid = length / 2
    const free = [mid, ...blocked.flat()]
      .filter((s) => s >= margin && s <= length - margin && !blocked.some(([lo, hi]) => s > lo + 1e-6 && s < hi - 1e-6))
      .sort((s1, s2) => Math.abs(s1 - mid) - Math.abs(s2 - mid) || s2 - s1)
    if (free.length > 0) return { x: a.x + ux * free[0], y: a.y + uy * free[0], angle: angleOf(a, b) }
  }
  return null
}

// The vertices of a path built from M/L/Q commands as getSmoothStepPath
// emits them (the floating elbow): each rounded bend is "L <bend start>
// Q <corner> <bend end>", so the corner is the Q control point and the L
// right before it is skipped. Recovers the elbow's underlying polyline,
// so chevronMark/targetMark treat elbows and ELK routes the same way.
export function pathVertices(d: string): Point[] {
  const commands = [...d.matchAll(/([MLQ])([^MLQ]*)/g)].map(([, cmd, args]) => ({
    cmd,
    nums: (args.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number),
  }))
  const points: Point[] = []
  commands.forEach(({ cmd, nums }, i) => {
    if (cmd === 'Q' && nums.length >= 2) points.push({ x: nums[0], y: nums[1] })
    else if (cmd !== 'Q' && nums.length >= 2 && commands[i + 1]?.cmd !== 'Q') points.push({ x: nums[0], y: nums[1] })
  })
  return points
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
