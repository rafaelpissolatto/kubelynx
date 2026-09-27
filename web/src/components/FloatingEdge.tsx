import { useState } from 'react'
import { BaseEdge, useInternalNode, getSmoothStepPath, type EdgeProps } from '@xyflow/react'
import { getEdgeParams } from '../lib/floatingEdge'
import type { TrafficDots } from '../lib/layout'

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
export function FloatingEdge({ id, source, target, markerEnd, style, label, selected, data }: EdgeProps) {
  const [hovered, setHovered] = useState(false)
  const sourceNode = useInternalNode(source)
  const targetNode = useInternalNode(target)

  if (!sourceNode || !targetNode) return null

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
