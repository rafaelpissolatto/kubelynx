import ELK, { type ElkNode } from 'elkjs/lib/elk.bundled.js'
import type { Edge, Node } from '@xyflow/react'
import { flowId, type Flow, type Graph, type Workload } from './topology'
import type { BandArrangement } from './bandArrangement'
import { bandShapeKey, placeBands, resolveBandShape, type BandShape, type Size } from './bandPacking'
import type { NodePositionMap } from './nodePositions'
import { chooseRoute, type EdgeRoute, type Rect } from './edgeRoute'

const elk = new ELK()

export const NODE_WIDTH = 220
export const NODE_HEIGHT = 72

// Workload box geometry. Must match .workload-node and its children in
// App.css (padding, border, gap, fonts, line heights): each box's size is
// computed here rather than measured, so ELK, band fitting and the rendered
// box all agree on it without a measure-then-relayout pass.
const NODE_PADDING_X = 14
const NODE_PADDING_Y = 10
const NODE_BORDER = 1
const NODE_ROW_GAP = 6
const NODE_NAME_LINE_HEIGHT = 18
const NODE_BADGE_HEIGHT = 16
const NODE_BADGE_PADDING_X = 6
const NODE_BADGE_GAP = 4
const NODE_NAME_FONT = '500 13px ui-sans-serif, system-ui, -apple-system, sans-serif'
const NODE_BADGE_FONT = '10px ui-monospace, Menlo, monospace'
// Fallback average glyph widths when no canvas is available (e.g. tests).
const APPROX_NAME_CHAR_WIDTH = 7.5
const APPROX_BADGE_CHAR_WIDTH = 6.1
// Absorbs sub-pixel font rendering differences between canvas and DOM.
const TEXT_SLACK = 4

let measureContext: CanvasRenderingContext2D | null | undefined

function measureText(text: string, font: string, approxCharWidth: number): number {
  if (measureContext === undefined) {
    measureContext = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null
  }
  if (!measureContext) return text.length * approxCharWidth
  measureContext.font = font
  return measureContext.measureText(text).width
}

function badgeRowWidth(labels: string[]): number {
  if (labels.length === 0) return 0
  const badges = labels.reduce(
    (sum, label) => sum + measureText(label, NODE_BADGE_FONT, APPROX_BADGE_CHAR_WIDTH) + NODE_BADGE_PADDING_X * 2,
    0,
  )
  return badges + NODE_BADGE_GAP * (labels.length - 1)
}

// Each workload box is as wide as its full name or its port-badge row needs
// (never narrower than NODE_WIDTH), and as tall as the rows it actually has
// — name, owner-kind badge, port badges. ELK gets the same size, so boxes
// are spaced apart rather than overlapping.
export function workloadNodeSize(workload: Workload, ports: string[]): { width: number; height: number } {
  const chromeX = (NODE_PADDING_X + NODE_BORDER) * 2 + TEXT_SLACK
  const contentWidth = Math.max(
    measureText(workload.name, NODE_NAME_FONT, APPROX_NAME_CHAR_WIDTH),
    badgeRowWidth(ports),
  )
  const badgeRows = (workload.ownerKind ? 1 : 0) + (ports.length > 0 ? 1 : 0)
  return {
    width: Math.max(NODE_WIDTH, Math.ceil(contentWidth + chromeX)),
    height: (NODE_PADDING_Y + NODE_BORDER) * 2 + NODE_NAME_LINE_HEIGHT + badgeRows * (NODE_ROW_GAP + NODE_BADGE_HEIGHT),
  }
}

// A flow's port is its destination port, so a workload's own (listening)
// ports are the ones on its inbound flows. Deduplicated per protocol+port,
// sorted by protocol then port number, with the aggregated "multiple" bucket
// (issue #38) last.
export function workloadPorts(graph: Graph): Map<string, string[]> {
  const byWorkload = new Map<string, Map<string, { protocol: string; port: string }>>()
  for (const flow of graph.edges) {
    if (!flow.port) continue
    const protocol = flow.protocol ?? ''
    const ports = byWorkload.get(flow.target) ?? new Map()
    ports.set(`${protocol}|${flow.port}`, { protocol, port: flow.port })
    byWorkload.set(flow.target, ports)
  }
  const result = new Map<string, string[]>()
  for (const [id, ports] of byWorkload) {
    const sorted = Array.from(ports.values()).sort((a, b) => {
      if (a.protocol !== b.protocol) return a.protocol.localeCompare(b.protocol)
      const an = Number(a.port)
      const bn = Number(b.port)
      if (Number.isNaN(an) !== Number.isNaN(bn)) return Number.isNaN(an) ? 1 : -1
      return Number.isNaN(an) ? a.port.localeCompare(b.port) : an - bn
    })
    result.set(id, sorted.map(portLabel))
  }
  return result
}

function workloadSizes(graph: Graph, ports: Map<string, string[]>): Map<string, { width: number; height: number }> {
  return new Map(graph.nodes.map((n) => [n.id, workloadNodeSize(n, ports.get(n.id) ?? [])]))
}

function portLabel({ protocol, port }: { protocol: string; port: string }): string {
  const value = Number.isNaN(Number(port)) ? ` ${port}` : ` :${port}`
  return `${protocol}${value}`.trim()
}

// Every flow line has the same weight; traffic volume is conveyed by the
// moving dots (edgeTrafficDots) instead, so line thickness doesn't compete
// with the direction arrowhead or the dots for attention.
const EDGE_STROKE_WIDTH = 1.5

// Traffic-rate-to-live-dots mapping (issue #44): busier edges carry more
// dots, travelling faster, so a trickle and a firehose look proportionally
// different, on a log scale (trafficRatio). Durations are per full trip
// along the edge's path.
const MIN_TRAFFIC_DOTS = 1
const MAX_TRAFFIC_DOTS = 4
const MAX_DOT_DURATION_S = 4
const MIN_DOT_DURATION_S = 1.2

// Swimlane band layout constants: a namespace with multiple namespaces in
// view gets stacked, labeled bands rather than one undifferentiated canvas.
const BAND_GAP = 48
const BAND_PADDING_X = 24
const BAND_PADDING_BOTTOM = 24
const BAND_HEADER_HEIGHT = 40

// Log scale so a handful of a unit and a few thousand don't look identical —
// null when there's no traffic to compare against (maxRate <= 0). Scales
// purely on Flow.rate's raw magnitude regardless of Flow.metric (REQ-004):
// bytes and requests are different units, but this only ever compares an
// edge's rate against the max rate among edges of the *same* graph response
// (buildEdges below), so it doesn't need them to be comparable in magnitude
// — it just needs to not crash or produce NaN when the unit changes.
function trafficRatio(rate: number, maxRate: number): number | null {
  if (maxRate <= 0) return null
  return Math.log1p(rate) / Math.log1p(maxRate)
}

export type TrafficDots = { count: number; durationSeconds: number }

// null for a zero-traffic edge: it stays a plain static line rather than
// implying movement that isn't happening (#33).
export function edgeTrafficDots(rate: number, maxRate: number): TrafficDots | null {
  if (rate <= 0) return null
  const ratio = trafficRatio(rate, maxRate) ?? 0
  return {
    count: Math.round(MIN_TRAFFIC_DOTS + ratio * (MAX_TRAFFIC_DOTS - MIN_TRAFFIC_DOTS)),
    durationSeconds: MAX_DOT_DURATION_S - ratio * (MAX_DOT_DURATION_S - MIN_DOT_DURATION_S),
  }
}

export function edgeLabel(flow: Flow): string {
  return [flow.protocol, flow.port ? `:${flow.port}` : undefined].filter(Boolean).join(' ')
}

export type WorkloadNodeData = { workload: Workload; ports: string[] }
export type NamespaceBandData = { namespace: string }

const elkLayoutOptions = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.spacing.nodeNode': '48',
  'elk.layered.spacing.nodeNodeBetweenLayers': '96',
  // Explicit crossing-minimization plus extra room around edges gives ELK
  // more freedom to route parallel/near-parallel flows apart before they're
  // ever drawn, rather than leaving them to overlap visually.
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.layered.spacing.edgeEdgeBetweenLayers': '24',
  'elk.layered.spacing.edgeNodeBetweenLayers': '24',
  // Orthogonal is already the layered default; stated explicitly because the
  // routes it produces are now rendered (issue #39 — see collectRoutes),
  // not discarded.
  'elk.edgeRouting': 'ORTHOGONAL',
}

// Reads the obstacle-aware edge routes ELK computed alongside node
// positions, translated by `offset` into the same absolute frame the nodes
// are placed in. Keyed by flowId — the ELK edge ids are flowIds for this.
function collectRoutes(layout: ElkNode, offset: { x: number; y: number }, routes: Map<string, EdgeRoute>) {
  const nodeAt = new Map((layout.children ?? []).map((c) => [c.id, { x: (c.x ?? 0) + offset.x, y: (c.y ?? 0) + offset.y }]))
  for (const edge of layout.edges ?? []) {
    const section = edge.sections?.[0]
    const source = nodeAt.get(edge.sources[0])
    const target = nodeAt.get(edge.targets[0])
    if (!section || !source || !target) continue
    const shift = (p: { x: number; y: number }) => ({ x: p.x + offset.x, y: p.y + offset.y })
    routes.set(edge.id, {
      points: [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map(shift),
      source,
      target,
    })
  }
}

// Picks the one route each edge is drawn with, given every workload's final
// (reconciled) position. Candidates, in order of preference: the route ELK
// just computed, then the route this edge was drawn with last time
// (`knownRoutes`). The second matters because persisted positions (#43)
// outlive the layout they came from: once a refresh's topology differs (a
// new flow, a new port badge resizing a box, a protocol or source switch),
// ELK's fresh layout no longer matches where the nodes actually are, so its
// fresh routes stop connecting them — while the previous route, computed
// back when those positions *were* ELK's, still does. Without it, routing
// silently degraded to the floating elbow on the first topology change.
// A candidate also has to stay clear of every other workload box at its
// final position (chooseRoute). Only edges ELK laid out (both endpoints in
// the same ELK graph) ever have a candidate; FloatingEdge falls back to its
// own elbow geometry for the rest.
function selectRoutes(
  graph: Graph,
  freshRoutes: Map<string, EdgeRoute>,
  knownRoutes: Map<string, EdgeRoute>,
  positions: Map<string, { x: number; y: number }>,
  sizes: Map<string, { width: number; height: number }>,
): Map<string, EdgeRoute> {
  const rects: [string, Rect][] = []
  for (const [id, pos] of positions) {
    const size = sizes.get(id)
    if (size) rects.push([id, { ...pos, ...size }])
  }
  const selected = new Map<string, EdgeRoute>()
  for (const flow of graph.edges) {
    const id = flowId(flow)
    const candidates = [freshRoutes.get(id), knownRoutes.get(id)].filter((r): r is EdgeRoute => !!r)
    const source = positions.get(flow.source)
    const target = positions.get(flow.target)
    if (candidates.length === 0 || !source || !target) continue
    const obstacles = rects.flatMap(([nodeId, rect]) =>
      nodeId === flow.source || nodeId === flow.target ? [] : [rect],
    )
    const chosen = chooseRoute(candidates, source, target, obstacles)
    if (chosen) selected.set(id, candidates[chosen.index])
  }
  // Edges outside this graph (hidden by the protocol filter, or briefly
  // without traffic) keep their known route for when they come back; it's
  // re-validated then like any other candidate.
  const inGraph = new Set(graph.edges.map(flowId))
  for (const [id, route] of knownRoutes) {
    if (!inGraph.has(id)) selected.set(id, route)
  }
  return selected
}

function buildEdges(graph: Graph, routes: Map<string, EdgeRoute>): Edge[] {
  const maxRate = graph.edges.reduce((max, e) => Math.max(max, e.rate), 0)
  return graph.edges.map((flow) => ({
    id: flowId(flow),
    source: flow.source,
    target: flow.target,
    label: edgeLabel(flow),
    // FloatingEdge (components/FloatingEdge.tsx) draws `data.route`, ELK's
    // obstacle-aware path (issue #39), while it's still valid; otherwise it
    // falls back to a floating elbow computed from node geometry.
    type: 'floating',
    style: { strokeWidth: EDGE_STROKE_WIDTH },
    // No markerEnd: FloatingEdge draws its own direction marks (a mid-edge
    // chevron and a slim open arrowhead, issue #79), which show
    // source -> destination even for zero-traffic or paused edges.
    // FloatingEdge renders these as dots moving along the edge's path.
    data: {
      flow,
      trafficDots: edgeTrafficDots(flow.rate, maxRate),
      route: routes.get(flowId(flow)),
    },
  }))
}

function buildAdjacency(graph: Graph): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>()
  for (const node of graph.nodes) adjacency.set(node.id, new Set())
  for (const edge of graph.edges) {
    adjacency.get(edge.source)?.add(edge.target)
    adjacency.get(edge.target)?.add(edge.source)
  }
  return adjacency
}

// Reconciles a fresh ELK layout with previously known node positions so
// dragging a node (issue #43) sticks across refreshes: nodes with a known
// position keep it exactly; brand-new nodes are anchored at the same
// relative offset their nearest already-positioned neighbor received,
// propagating outward wave-by-wave so a cluster of new nodes anchors off
// whichever of them first touches known territory (mirrors RabbitFlow's
// placeNodes). A new node with no path to any known node — including every
// node, the very first time layout ever runs, when nothing is known yet —
// can't be anchored, so it's stacked below everything else instead of
// guessing at a meaningless offset.
function reconcilePositions(
  graph: Graph,
  autoPositions: Map<string, { x: number; y: number }>,
  knownPositions: NodePositionMap,
): Map<string, { x: number; y: number }> {
  const final = new Map<string, { x: number; y: number }>()

  if (Object.keys(knownPositions).length === 0) {
    for (const [id, pos] of autoPositions) final.set(id, pos)
    return final
  }

  const pending = new Set<string>()
  for (const node of graph.nodes) {
    const stored = knownPositions[node.id]
    if (stored) final.set(node.id, stored)
    else pending.add(node.id)
  }

  const adjacency = buildAdjacency(graph)

  let progress = true
  while (progress && pending.size > 0) {
    progress = false
    for (const id of pending) {
      const positionedNeighbors = Array.from(adjacency.get(id) ?? []).filter((n) => final.has(n))
      if (positionedNeighbors.length === 0) continue

      const auto = autoPositions.get(id) ?? { x: 0, y: 0 }
      let dx = 0
      let dy = 0
      for (const neighbor of positionedNeighbors) {
        const neighborFinal = final.get(neighbor)!
        const neighborAuto = autoPositions.get(neighbor) ?? neighborFinal
        dx += neighborFinal.x - neighborAuto.x
        dy += neighborFinal.y - neighborAuto.y
      }
      final.set(id, { x: auto.x + dx / positionedNeighbors.length, y: auto.y + dy / positionedNeighbors.length })
      pending.delete(id)
      progress = true
    }
  }

  // Anything left is disconnected from every known node — place it below
  // everything else rather than overlapping something a user positioned.
  if (pending.size > 0) {
    let belowY = 0
    for (const pos of final.values()) belowY = Math.max(belowY, pos.y)
    belowY += NODE_HEIGHT + BAND_GAP
    for (const id of pending) {
      const auto = autoPositions.get(id) ?? { x: 0, y: 0 }
      final.set(id, { x: auto.x, y: belowY })
      belowY += NODE_HEIGHT + BAND_GAP
    }
  }

  return final
}

function elkSubgraph(id: string, workloads: Workload[], flows: Flow[], sizes: Map<string, Size>): ElkNode {
  return {
    id,
    layoutOptions: elkLayoutOptions,
    children: workloads.map((n) => ({ id: n.id, ...sizes.get(n.id)! })),
    edges: flows.map((e) => ({
      id: flowId(e),
      sources: [e.source],
      targets: [e.target],
    })),
  }
}

type BandLayout = { namespace: string; layout: ElkNode; width: number; height: number }

// Everything layout needs that depends only on the graph and the canvas —
// the ELK runs and, with several namespaces, the band shape — but not yet on
// any persisted positions. Split from finishLayout because the persisted
// positions to reconcile against are keyed by the resolved shape (see
// arrangementKey and positionScopeKey), which only exists once every band's
// real size is known.
export type LayoutPlan = {
  graph: Graph
  ports: Map<string, string[]>
  sizes: Map<string, Size>
  // What persisted positions are keyed by (positionScopeKey): the explicit
  // arrangement, or for 'auto' with several namespaces the shape it
  // resolved to ('auto:rows3', …), since positions laid out for one shape
  // are meaningless in another.
  arrangementKey: string
  // bandShapeKey of the resolved shape (null for a single namespace) — the
  // next refresh's `preferredShape`.
  shapeKey: string | null
} & ({ kind: 'flat'; layout: ElkNode } | { kind: 'swimlanes'; bands: BandLayout[]; shape: BandShape })

// `canvas` is the graph pane's size in screen pixels; 'auto' picks the band
// shape that fits it best (resolveBandShape). `preferredShape` is the shape
// currently on screen, kept on a refresh unless it has become clearly worse.
export async function planLayout(
  graph: Graph,
  bandArrangement: BandArrangement,
  canvas: Size,
  preferredShape: string | null = null,
): Promise<LayoutPlan> {
  const ports = workloadPorts(graph)
  const sizes = workloadSizes(graph, ports)
  const namespaces = Array.from(new Set(graph.nodes.map((n) => n.namespace))).sort()

  if (namespaces.length <= 1) {
    const layout = await elk.layout(elkSubgraph('root', graph.nodes, graph.edges, sizes))
    return { kind: 'flat', graph, ports, sizes, layout, arrangementKey: bandArrangement, shapeKey: null }
  }

  // Each namespace gets its own ELK sub-layout first (needed to know each
  // band's real size); only then is the band shape resolved. Cross-namespace
  // edges are still rendered — React Flow draws them from each node's
  // absolute position — they just don't affect intra-band placement.
  const bands: BandLayout[] = []
  for (const namespace of namespaces) {
    const nsNodes = graph.nodes.filter((n) => n.namespace === namespace)
    const nsNodeIds = new Set(nsNodes.map((n) => n.id))
    const nsEdges = graph.edges.filter((e) => nsNodeIds.has(e.source) && nsNodeIds.has(e.target))
    const layout = await elk.layout(elkSubgraph(namespace, nsNodes, nsEdges, sizes))
    bands.push({
      namespace,
      layout,
      width: (layout.width ?? NODE_WIDTH) + BAND_PADDING_X * 2,
      height: BAND_HEADER_HEIGHT + (layout.height ?? NODE_HEIGHT) + BAND_PADDING_BOTTOM,
    })
  }

  const shape = resolveBandShape(bandArrangement, bands, canvas, BAND_GAP, preferredShape)
  const shapeKey = bandShapeKey(shape)
  return {
    kind: 'swimlanes',
    graph,
    ports,
    sizes,
    bands,
    shape,
    shapeKey,
    arrangementKey: bandArrangement === 'auto' ? `auto:${shapeKey}` : bandArrangement,
  }
}

// knownPositions carries forward previously-persisted (dragged or
// already-anchored) node positions so a refresh reuses them instead of
// re-running full auto-layout — see reconcilePositions. The returned
// `positions` map is every workload's final position, ready to be persisted
// as the new baseline for the next call (App.tsx does this via
// lib/nodePositions.ts). knownRoutes does the same for edge routes: the
// previous call's `routes`, so an edge keeps the route that still fits its
// persisted endpoints when ELK's fresh one doesn't (see selectRoutes). A
// from-scratch layout (Rearrange) passes neither.
export function finishLayout(
  plan: LayoutPlan,
  knownPositions: NodePositionMap = {},
  knownRoutes: Map<string, EdgeRoute> = new Map(),
): LayoutResult {
  const { graph, ports, sizes } = plan
  const autoPositions = new Map<string, { x: number; y: number }>()
  const routes = new Map<string, EdgeRoute>()
  const bands: { namespace: string; x: number; y: number; width: number; height: number }[] = []

  if (plan.kind === 'flat') {
    collectRoutes(plan.layout, { x: 0, y: 0 }, routes)
    for (const child of plan.layout.children ?? []) {
      autoPositions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 })
    }
  } else {
    const { origins } = placeBands(plan.bands, plan.shape, BAND_GAP)
    plan.bands.forEach(({ namespace, layout, width, height }, i) => {
      const { x: bandX, y: bandY } = origins[i]
      collectRoutes(layout, { x: BAND_PADDING_X + bandX, y: BAND_HEADER_HEIGHT + bandY }, routes)
      for (const child of layout.children ?? []) {
        autoPositions.set(child.id, {
          x: (child.x ?? 0) + BAND_PADDING_X + bandX,
          y: (child.y ?? 0) + BAND_HEADER_HEIGHT + bandY,
        })
      }
      bands.push({ namespace, x: bandX, y: bandY, width, height })
    })
  }

  const positions = reconcilePositions(graph, autoPositions, knownPositions)

  // Each band is fitted to its workloads' final positions — the same fit
  // syncNamespaceBands applies live during a drag — so a band follows
  // dragged/anchored members and is sized by its own content, and a refresh
  // doesn't resize a band the user just shaped by dragging.
  for (const band of bands) {
    const fit = fitBandToMembers(
      graph.nodes
        .filter((n) => n.namespace === band.namespace)
        .flatMap((n) => {
          const pos = positions.get(n.id)
          return pos ? [{ x: pos.x, y: pos.y, ...sizes.get(n.id)! }] : []
        }),
    )
    if (fit) Object.assign(band, fit)
  }

  const bandNodes: Node<NamespaceBandData>[] = bands.map((band) => ({
    id: `namespace-band:${band.namespace}`,
    type: 'namespaceBand',
    position: { x: band.x, y: band.y },
    // pointerEvents 'none' so the band body never blocks panning or the
    // workloads it contains; only its header opts back in (App.css).
    style: { width: band.width, height: band.height, pointerEvents: 'none' },
    data: { namespace: band.namespace },
    selectable: false,
    // Draggable only by its header strip (see NamespaceBand); dragging it
    // carries its workloads along — see syncNamespaceBands.
    draggable: true,
    dragHandle: '.namespace-band__header',
    zIndex: -1,
  }))

  const workloadNodes: Node<WorkloadNodeData>[] = graph.nodes.map((workload) => ({
    id: workload.id,
    type: 'workload',
    position: positions.get(workload.id) ?? { x: 0, y: 0 },
    style: { ...sizes.get(workload.id)! },
    data: { workload, ports: ports.get(workload.id) ?? [] },
  }))

  const selected = selectRoutes(graph, routes, knownRoutes, positions, sizes)
  return { nodes: [...bandNodes, ...workloadNodes], edges: buildEdges(graph, selected), positions, routes: selected }
}

// Smallest band rectangle enclosing its members, with the same padding and
// header room layoutSwimlanes gives an ELK-laid-out band.
function fitBandToMembers(members: Rect[]): Rect | null {
  if (members.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const m of members) {
    minX = Math.min(minX, m.x - BAND_PADDING_X)
    minY = Math.min(minY, m.y - BAND_HEADER_HEIGHT)
    maxX = Math.max(maxX, m.x + m.width + BAND_PADDING_X)
    maxY = Math.max(maxY, m.y + m.height + BAND_PADDING_BOTTOM)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

// Same width/height layoutSwimlanes fits bands with, so a live re-fit and
// the next full layout agree on a band's size.
function nodeRect(node: Node): Rect {
  const width = typeof node.style?.width === 'number' ? node.style.width : NODE_WIDTH
  const height = typeof node.style?.height === 'number' ? node.style.height : NODE_HEIGHT
  return { x: node.position.x, y: node.position.y, width, height }
}

// Keeps namespace bands and their workloads consistent after React Flow
// applies a batch of node changes (App.tsx's onNodesChange), without
// re-running layout:
// - a band that moved carries its workloads along by the same delta, so a
//   namespace can be dragged as one block;
// - a band whose workload was dragged is re-fitted tightly around its
//   members, so it grows and shrinks with them live instead of leaving a
//   stale, oversized rectangle behind that overlaps its neighbors.
export function syncNamespaceBands(prevNodes: Node[], nodes: Node[]): Node[] {
  const prevById = new Map(prevNodes.map((n) => [n.id, n]))
  const moved = (node: Node) => {
    const prev = prevById.get(node.id)
    return !!prev && (prev.position.x !== node.position.x || prev.position.y !== node.position.y)
  }

  const bandDeltas = new Map<string, { dx: number; dy: number }>()
  for (const node of nodes) {
    if (node.type !== 'namespaceBand' || !moved(node)) continue
    const prev = prevById.get(node.id)!
    bandDeltas.set((node.data as NamespaceBandData).namespace, {
      dx: node.position.x - prev.position.x,
      dy: node.position.y - prev.position.y,
    })
  }

  const refit = new Set<string>()
  let next = nodes.map((node) => {
    if (node.type !== 'workload') return node
    const namespace = (node.data as WorkloadNodeData).workload.namespace
    const delta = bandDeltas.get(namespace)
    if (delta && !moved(node)) {
      return { ...node, position: { x: node.position.x + delta.dx, y: node.position.y + delta.dy } }
    }
    if (!delta && moved(node)) refit.add(namespace)
    return node
  })
  if (bandDeltas.size === 0 && refit.size === 0) return nodes

  if (refit.size > 0) {
    next = next.map((node) => {
      if (node.type !== 'namespaceBand') return node
      const namespace = (node.data as NamespaceBandData).namespace
      if (!refit.has(namespace)) return node
      const fit = fitBandToMembers(
        next
          .filter((n) => n.type === 'workload' && (n.data as WorkloadNodeData).workload.namespace === namespace)
          .map(nodeRect),
      )
      if (!fit) return node
      return {
        ...node,
        position: { x: fit.x, y: fit.y },
        style: { ...node.style, width: fit.width, height: fit.height },
      }
    })
  }
  return next
}

export type LayoutResult = {
  nodes: Node<WorkloadNodeData | NamespaceBandData>[]
  edges: Edge[]
  positions: Map<string, { x: number; y: number }>
  // The ELK route each edge was given (see selectRoutes), keyed by flowId,
  // plus known routes of edges not in this graph — the next call's
  // knownRoutes.
  routes: Map<string, EdgeRoute>
}
