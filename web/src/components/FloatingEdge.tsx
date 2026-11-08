import { useState } from 'react'
import { BaseEdge, useInternalNode, useStore, getSmoothStepPath, type EdgeProps, type InternalNode } from '@xyflow/react'
import { getEdgeParams } from '../lib/floatingEdge'
import type { TrafficDots } from '../lib/layout'
import { chooseRoute, placeRoute, roundedPolylinePath, type EdgeRoute, type Rect } from '../lib/edgeRoute'

// Corner radius for the elbow bend — larger than smoothstep's tiny default
// so turns read as a deliberate curve rather than a sharp right angle.
const BORDER_RADIUS = 16

// Wide, invisible stroke used only to make hovering easier to trigger —
// the visible line is thin (see EDGE_STROKE_WIDTH in lib/layout.ts).
const HOVER_HIT_WIDTH = 20

const TRAFFIC_DOT_RADIUS = 3

// Label visibility (issue #37): the PROTOCOL :PORT label only renders while
// its edge is hovered or selected, instead of always-on.
//
// Why: before floating edges (#33), the label was always-on, and edges
// converging on the same workload from the same direction produced several
// overlapping "TCP :9153"-style boxes stacked on top of each other —
// unreadable regardless of routing. Floating-edge routing spreads those
// edges apart by angle, which helps, but doesn't guarantee separation (many
// source ports can still land close together, and dense multi-namespace
// views make near-collisions common). Gating the label on hover/selection
// removes the pile-up risk entirely rather than betting on layout spacing,
// at the cost of one extra interaction to read a specific edge's port. The
// flows table already lists every edge's protocol/port as an always-visible
// source of truth, so nothing is lost — this only affects the canvas.
function floatingElbowPath(sourceNode: InternalNode, targetNode: InternalNode): [string, number, number] {
  const { sx, sy, tx, ty, sourcePos, targetPos } = getEdgeParams(sourceNode, targetNode)
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX: sx,
    sourceY: sy,
    sourcePosition: sourcePos,
    targetX: tx,
    targetY: ty,
    targetPosition: targetPos,
    borderRadius: BORDER_RADIUS,
  })
  return [path, labelX, labelY]
}

// Whether ELK's route can still be drawn at the nodes' *current* positions,
// re-checked live (during drags too), not just when layout picked it:
// - Both endpoints must have moved by the same offset since layout (an
//   untouched pair, or a namespace band dragged as one block) — see
//   placeRoute. Dragging one endpoint on its own makes the route stale, and
//   the edge reverts to the floating elbow until the next Rearrange gives
//   ELK a chance to route it again. Decision for #39: ELK can't re-route
//   around fixed positions (that's #46), and redrawing a detour computed for
//   a node position that no longer exists — or bending the old polyline to
//   reach the new spot — would show a path that looks obstacle-aware but
//   isn't. The plain elbow is honest about being a fallback.
// - No other workload box may sit on the route. Dropping a dragged node
//   onto someone else's detour, or persisted positions (#43) disagreeing
//   with the layout a route came from, would otherwise leave an "avoiding"
//   path drawn straight through a box.
function routeIsLive(route: EdgeRoute, source: string, target: string, nodeLookup: Map<string, InternalNode>): boolean {
  const sourceNode = nodeLookup.get(source)
  const targetNode = nodeLookup.get(target)
  if (!sourceNode || !targetNode) return false
  const obstacles: Rect[] = []
  for (const [id, node] of nodeLookup) {
    if (id === source || id === target || node.type !== 'workload') continue
    obstacles.push({
      ...node.internals.positionAbsolute,
      width: node.measured.width ?? 0,
      height: node.measured.height ?? 0,
    })
  }
  return chooseRoute([route], sourceNode.internals.positionAbsolute, targetNode.internals.positionAbsolute, obstacles) !== null
}

export function FloatingEdge({ id, source, target, markerEnd, style, label, selected, data }: EdgeProps) {
  const [hovered, setHovered] = useState(false)
  const sourceNode = useInternalNode(source)
  const targetNode = useInternalNode(target)
  const route = data?.route as EdgeRoute | undefined
  // A boolean selector, so this edge only re-renders when the answer flips,
  // not on every node move or viewport change the store reports.
  const routeLive = useStore((s) => (route ? routeIsLive(route, source, target, s.nodeLookup) : false))

  if (!sourceNode || !targetNode) return null

  // Prefer the obstacle-aware route ELK computed during layout (issue #39),
  // but only while it's still true: see routeIsLive. Edges ELK never routed
  // (cross-namespace) have none. Both cases fall back to the floating elbow
  // below — obstacle-unaware, but never pretending to be a computed detour.
  const routePoints =
    route && routeLive
      ? placeRoute(route, sourceNode.internals.positionAbsolute, targetNode.internals.positionAbsolute)
      : null

  const [path, labelX, labelY] = routePoints
    ? roundedPolylinePath(routePoints, BORDER_RADIUS)
    : floatingElbowPath(sourceNode, targetNode)

  const showLabel = hovered || selected
  const trafficDots = data?.trafficDots as TrafficDots | null | undefined

  return (
    <g onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <path
        d={path}
        fill="none"
        strokeOpacity={0}
        strokeWidth={HOVER_HIT_WIDTH}
        className="react-flow__edge-interaction"
      />
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={style}
        label={showLabel ? label : undefined}
        labelX={showLabel ? labelX : undefined}
        labelY={showLabel ? labelY : undefined}
        labelBgPadding={[6, 3]}
        labelBgBorderRadius={4}
        interactionWidth={0}
      />
      {/* Live traffic (issue #44): dots travel along the edge's actual path,
          bends included. A negative `begin` staggers them evenly along the
          path from the first frame instead of all starting at the source. */}
      {trafficDots &&
        Array.from({ length: trafficDots.count }, (_, i) => (
          <circle key={i} r={TRAFFIC_DOT_RADIUS} className="flow-edge__traffic-dot">
            <animateMotion
              dur={`${trafficDots.durationSeconds}s`}
              begin={`${(-i * trafficDots.durationSeconds) / trafficDots.count}s`}
              repeatCount="indefinite"
              path={path}
            />
          </circle>
        ))}
    </g>
  )
}
