import { useContext, useState, type CSSProperties } from 'react'
import { BaseEdge, useInternalNode, useStore, getSmoothStepPath, type EdgeProps, type InternalNode } from '@xyflow/react'
import { getEdgeParams } from '../lib/floatingEdge'
import type { TrafficDots } from '../lib/layout'
import type { Flow } from '../lib/topology'
import { EdgeDisplayContext, edgeLabelText } from '../lib/displayOptions'
import { edgeSecurityVariant, mtlsDescription, type EdgeSecurityVariant } from '../lib/flowSecurity'
import { SecurityGlyphShape } from './SecurityGlyph'
import {
  chevronMark,
  chooseRoute,
  pathVertices,
  placeRoute,
  roundedPolylinePath,
  targetMark,
  type DirectionMark,
  type EdgeRoute,
  type KeepClear,
  type Rect,
} from '../lib/edgeRoute'

// Corner radius for the elbow bend — larger than smoothstep's tiny default
// so turns read as a deliberate curve rather than a sharp right angle.
const BORDER_RADIUS = 16

// Wide, invisible stroke used only to make hovering easier to trigger —
// the visible line is thin (see EDGE_STROKE_WIDTH in lib/layout.ts).
const HOVER_HIT_WIDTH = 20

const TRAFFIC_DOT_RADIUS = 3

// Direction marks (issue #79): an open chevron mid-edge plus a slim open
// arrowhead at the target, replacing the closed SVG marker. The closed head
// was the only direction cue on a paused or static graph, and where edges
// converge on a busy node those heads merged into one blob or hid behind
// the box. Both shapes are open strokes in the edge's own color, drawn in
// screen pixels (see DirectionMarks) with the tip at the local origin, pointing
// along +x.
const CHEVRON_PATH = 'M -3 -4 L 1 0 L -3 4'
const ARROWHEAD_PATH = 'M -7 -3.5 L 0 0 L -7 3.5'
const MARK_STROKE_WIDTH = 1.5
// The chevron's half-length along the edge, and the space it keeps from
// the label and from workload boxes, in screen pixels.
const CHEVRON_HALF = 4
const LABEL_GAP = 6
const NODE_GAP = 3

// Marks keep a constant on-screen size between these zoom levels, so they
// stay crisp and legible on a zoomed-out "All namespaces" view without
// turning into blobs when zoomed in. Outside the range they scale with the
// graph like everything else, rather than dwarfing tiny nodes or vanishing
// next to huge ones.
const MARK_MIN_ZOOM = 0.6
const MARK_MAX_ZOOM = 1.25

// Quantized so a zoom gesture re-renders marks and badges a bounded number
// of times.
const markZoom = (s: { transform: [number, number, number] }) =>
  Math.round(Math.min(MARK_MAX_ZOOM, Math.max(MARK_MIN_ZOOM, s.transform[2])) * 20) / 20

// The mTLS badge (issue #90): a disc behind the lock glyph, in screen
// pixels like the direction marks.
const BADGE_RADIUS = 8

// Rough size of the shown label — PROTOCOL :PORT or a rate, per Display ▾
// (React Flow's 10px edge text plus labelBgPadding below), in flow units —
// close enough to keep the chevron off it without measuring the DOM.
function labelBox(label: unknown, x: number, y: number, scale: number): KeepClear | null {
  if (typeof label !== 'string' || label === '') return null
  return { x, y, halfWidth: label.length * 3 + 6, halfHeight: 9, gap: LABEL_GAP * scale }
}

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

// Boxes the chevron must stay clear of: the shown label, and every other
// workload box. Edges are drawn beneath nodes, and the floating elbow is
// obstacle-unaware, so a chevron placed where the edge runs behind a box
// would simply be hidden.
function keepClearBoxes(
  nodeLookup: Map<string, InternalNode>,
  source: string,
  target: string,
  label: KeepClear | null,
  badge: KeepClear | null,
  scale: number,
): KeepClear[] {
  const boxes: KeepClear[] = []
  if (label) boxes.push(label)
  if (badge) boxes.push(badge)
  for (const [id, node] of nodeLookup) {
    if (id === source || id === target || node.type !== 'workload') continue
    const halfWidth = (node.measured.width ?? 0) / 2
    const halfHeight = (node.measured.height ?? 0) / 2
    const { x, y } = node.internals.positionAbsolute
    boxes.push({ x: x + halfWidth, y: y + halfHeight, halfWidth, halfHeight, gap: NODE_GAP * scale })
  }
  return boxes
}

function sameMark(a: DirectionMark | null, b: DirectionMark | null): boolean {
  if (!a || !b) return a === b
  return a.x === b.x && a.y === b.y && a.angle === b.angle
}

// Draws the chevron and target arrowhead for one edge. Its own component so
// that only these two small paths re-render on zoom (they're sized in
// screen pixels) or when a node moves onto the chevron's spot, not the
// whole edge with its traffic dots.
//
// Color and opacity come from the edge's own style (accent recolor on a
// selected flow, dimming of the rest) and the shared .react-flow__edge-path
// rules, so every state the line has, the marks have too. They sit inside
// the edge's <g>, so opacity applied to the edge as a whole also reaches
// them. Drawn before BaseEdge so a shown label paints over them, never the
// other way round.
function DirectionMarks({
  points,
  source,
  target,
  edgeStyle,
  label,
  badge,
}: {
  points: { x: number; y: number }[]
  source: string
  target: string
  edgeStyle: CSSProperties | undefined
  label: { text: unknown; x: number; y: number } | null
  // Where the mTLS badge sits (issue #90), so the chevron keeps off it too.
  badge: BadgePlacement | null
}) {
  const zoom = useStore(markZoom)
  const scale = 1 / zoom
  // Computed inside the selector, with an equality check on the result, so
  // panning or dragging unrelated nodes doesn't re-render anything.
  const chevron = useStore(
    (s) =>
      points.length < 2
        ? null
        : chevronMark(
            points,
            BORDER_RADIUS,
            CHEVRON_HALF * scale,
            keepClearBoxes(
              s.nodeLookup,
              source,
              target,
              label && labelBox(label.text, label.x, label.y, scale),
              badge && badgeBox(badge, scale),
              scale,
            ),
          ),
    sameMark,
  )
  const head = points.length < 2 ? null : targetMark(points)
  const style: CSSProperties = { stroke: edgeStyle?.stroke, opacity: edgeStyle?.opacity, strokeWidth: MARK_STROKE_WIDTH }
  const mark = (m: DirectionMark, d: string) => (
    <path
      d={d}
      transform={`translate(${m.x} ${m.y}) rotate(${m.angle}) scale(${scale})`}
      className="react-flow__edge-path flow-edge__direction"
      style={style}
    />
  )
  return (
    <>
      {chevron && mark(chevron, CHEVRON_PATH)}
      {head && mark(head, ARROWHEAD_PATH)}
    </>
  )
}

type BadgePlacement = { x: number; y: number; labelShown: boolean }

// The badge sits at the label position; while the label is shown it moves
// just above it, so neither covers the other.
function badgeCenter(badge: BadgePlacement, scale: number): { x: number; y: number } {
  return badge.labelShown ? { x: badge.x, y: badge.y - 9 - (BADGE_RADIUS + 2) * scale } : badge
}

function badgeBox(badge: BadgePlacement, scale: number): KeepClear {
  const { x, y } = badgeCenter(badge, scale)
  const half = BADGE_RADIUS * scale
  return { x, y, halfWidth: half, halfHeight: half, gap: LABEL_GAP * scale }
}

// The mTLS status badge (issue #90): a lock glyph on a disc, its own
// component for the same reason as DirectionMarks (re-renders on zoom only).
// Inside the edge's <g>, so .is-dimmed fades it with the line. The <title>
// gives the status as text on hover and to assistive tech.
function SecurityBadge({
  variant,
  placement,
  description,
}: {
  variant: EdgeSecurityVariant
  placement: BadgePlacement
  description: string | null
}) {
  const scale = 1 / useStore(markZoom)
  const { x, y } = badgeCenter(placement, scale)
  return (
    <g className={`flow-edge__badge flow-edge__badge--${variant}`} transform={`translate(${x} ${y}) scale(${scale})`}>
      {description && <title>{description}</title>}
      <circle r={BADGE_RADIUS} className="flow-edge__badge-disc" />
      <SecurityGlyphShape variant={variant} />
    </g>
  )
}

export function FloatingEdge({ id, source, target, style, label, selected, data }: EdgeProps) {
  const [hovered, setHovered] = useState(false)
  // Display ▾ (issue #76): what the label says, and whether dots run.
  const display = useContext(EdgeDisplayContext)
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

  const flow = data?.flow as Flow | undefined
  const labelText = flow ? edgeLabelText(flow, display.edgeLabels) : display.edgeLabels === 'none' ? undefined : label
  const showLabel = (hovered || selected) && !!labelText
  // With animation off the dots aren't rendered at all, so no <animateMotion>
  // clock keeps ticking for them (hiding them with CSS would not stop it).
  const trafficDots = display.trafficAnimation ? (data?.trafficDots as TrafficDots | null | undefined) : null
  // The elbow's corners, recovered from its path, so both geometries place
  // their direction marks the same way.
  const vertices = routePoints ?? pathVertices(path)
  // mTLS status (issue #90): Istio flows only — a Beyla flow has no
  // Flow.security, gets no variant, and renders exactly as before.
  const security = edgeSecurityVariant(flow, display.highlightPlaintext)
  const badge: BadgePlacement | null = security ? { x: labelX, y: labelY, labelShown: !!showLabel } : null

  return (
    <g
      className={security ? `flow-edge--${security}` : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <path
        d={path}
        fill="none"
        strokeOpacity={0}
        strokeWidth={HOVER_HIT_WIDTH}
        className="react-flow__edge-interaction"
      />
      <DirectionMarks
        points={vertices}
        source={source}
        target={target}
        edgeStyle={style}
        label={showLabel ? { text: labelText, x: labelX, y: labelY } : null}
        badge={badge}
      />
      <BaseEdge
        id={id}
        path={path}
        style={style}
        className="flow-edge__line"
        label={showLabel ? labelText : undefined}
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
      {security && badge && flow && (
        <SecurityBadge variant={security} placement={badge} description={mtlsDescription(flow)} />
      )}
    </g>
  )
}
