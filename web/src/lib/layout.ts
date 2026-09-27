import ELK, { type ElkNode } from 'elkjs/lib/elk.bundled.js'
import { MarkerType, type Edge, type Node } from '@xyflow/react'
import { flowId, type Flow, type Graph, type Workload } from './topology'
import type { BandArrangement } from './bandArrangement'
import type { NodePositionMap } from './nodePositions'

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

type ResolvedBandArrangement = 'vertical' | 'horizontal'

// 'auto' picks horizontal once stacking every band's *actual* height (from
// its own ELK sub-layout — see layoutSwimlanes) would need more vertical
// space than the viewport gives it, so the common case (a handful of small
// namespaces) stays vertical while either many namespaces or a few
// workload-heavy ones avoid forcing excessive scrolling. Deciding this from
// real band heights, rather than a fixed per-namespace guess, means a
// namespace with unusually many workloads is correctly weighted too.
function resolveBandArrangement(
  arrangement: BandArrangement,
  bandHeights: number[],
  viewportHeight: number,
): ResolvedBandArrangement {
  if (arrangement !== 'auto') return arrangement
  const stackedHeight = bandHeights.reduce((sum, height) => sum + height + BAND_GAP, 0)
  return stackedHeight > viewportHeight ? 'horizontal' : 'vertical'
}

// Log scale so a handful of KB/s and a few MB/s don't look identical —
// null when there's no traffic to compare against (maxBytesPerSecond <= 0).
function trafficRatio(bytesPerSecond: number, maxBytesPerSecond: number): number | null {
  if (maxBytesPerSecond <= 0) return null
  return Math.log1p(bytesPerSecond) / Math.log1p(maxBytesPerSecond)
}

export type TrafficDots = { count: number; durationSeconds: number }

// null for a zero-traffic edge: it stays a plain static line rather than
// implying movement that isn't happening (#33).
export function edgeTrafficDots(bytesPerSecond: number, maxBytesPerSecond: number): TrafficDots | null {
  if (bytesPerSecond <= 0) return null
  const ratio = trafficRatio(bytesPerSecond, maxBytesPerSecond) ?? 0
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
}

function buildEdges(graph: Graph): Edge[] {
  const maxBytesPerSecond = graph.edges.reduce((max, e) => Math.max(max, e.bytesPerSecond), 0)
  return graph.edges.map((flow) => ({
    id: flowId(flow),
    source: flow.source,
    target: flow.target,
    label: edgeLabel(flow),
    // FloatingEdge (components/FloatingEdge.tsx) computes each edge's actual
    // border-crossing point from node geometry — a smooth elbow bend that
    // naturally fans edges apart by angle, instead of routing every edge
    // through the same fixed handle position.
    type: 'floating',
    style: { strokeWidth: EDGE_STROKE_WIDTH },
    // Arrowhead at the destination end shows source -> destination even for
    // zero-traffic edges, which have no moving dots to show it.
    markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--edge-stroke)' },
    // FloatingEdge renders these as dots moving along the edge's path.
    data: { flow, trafficDots: edgeTrafficDots(flow.bytesPerSecond, maxBytesPerSecond) },
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

async function layoutFlat(
  graph: Graph,
  knownPositions: NodePositionMap,
): Promise<{
  nodes: Node<WorkloadNodeData>[]
  edges: Edge[]
  positions: Map<string, { x: number; y: number }>
}> {
  const ports = workloadPorts(graph)
  const sizes = workloadSizes(graph, ports)
  const elkGraph = {
    id: 'root',
    layoutOptions: elkLayoutOptions,
    children: graph.nodes.map((n) => ({ id: n.id, ...sizes.get(n.id)! })),
    edges: graph.edges.map((e, i) => ({
      id: `e${i}-${e.source}-${e.target}`,
      sources: [e.source],
      targets: [e.target],
    })),
  }

  const layout = await elk.layout(elkGraph)

  const autoPositions = new Map<string, { x: number; y: number }>()
  for (const child of layout.children ?? []) {
    autoPositions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 })
  }

  const positions = reconcilePositions(graph, autoPositions, knownPositions)

  const nodes: Node<WorkloadNodeData>[] = graph.nodes.map((workload) => ({
    id: workload.id,
    type: 'workload',
    position: positions.get(workload.id) ?? { x: 0, y: 0 },
    style: { ...sizes.get(workload.id)! },
    data: { workload, ports: ports.get(workload.id) ?? [] },
  }))

  return { nodes, edges: buildEdges(graph), positions }
}

// layoutSwimlanes lays out each namespace's workloads independently, then
// arranges the resulting bands either stacked vertically or side by side
// horizontally. Cross-namespace edges are still rendered — React Flow draws
// them from each node's absolute position regardless of which band it
// belongs to — they just aren't a factor in intra-band node placement.
//
// Runs in two passes: first every namespace's own ELK sub-layout (needed to
// know each band's real size), then — only once those real sizes are known —
// 'auto' picks vertical or horizontal and positions are assigned. Deciding
// the arrangement before laying anything out would mean guessing at sizes
// ELK hasn't computed yet.
async function layoutSwimlanes(
  graph: Graph,
  namespaces: string[],
  arrangement: BandArrangement,
  viewportHeight: number,
  knownPositions: NodePositionMap,
): Promise<{
  nodes: Node<WorkloadNodeData | NamespaceBandData>[]
  edges: Edge[]
  positions: Map<string, { x: number; y: number }>
}> {
  const namespaceLayouts: { namespace: string; layout: ElkNode; width: number; height: number }[] = []
  const ports = workloadPorts(graph)
  const sizes = workloadSizes(graph, ports)

  for (const namespace of namespaces) {
    const nsNodes = graph.nodes.filter((n) => n.namespace === namespace)
    const nsNodeIds = new Set(nsNodes.map((n) => n.id))
    const nsEdges = graph.edges.filter((e) => nsNodeIds.has(e.source) && nsNodeIds.has(e.target))

    const elkGraph: ElkNode = {
      id: namespace,
      layoutOptions: elkLayoutOptions,
      children: nsNodes.map((n) => ({ id: n.id, ...sizes.get(n.id)! })),
      edges: nsEdges.map((e, i) => ({
        id: `e${namespace}-${i}-${e.source}-${e.target}`,
        sources: [e.source],
        targets: [e.target],
      })),
    }
    const layout = await elk.layout(elkGraph)

    const contentWidth = layout.width ?? NODE_WIDTH
    const contentHeight = layout.height ?? NODE_HEIGHT
    namespaceLayouts.push({
      namespace,
      layout,
      width: contentWidth + BAND_PADDING_X * 2,
      height: BAND_HEADER_HEIGHT + contentHeight + BAND_PADDING_BOTTOM,
    })
  }

  const resolvedArrangement = resolveBandArrangement(
    arrangement,
    namespaceLayouts.map((n) => n.height),
    viewportHeight,
  )

  const autoPositions = new Map<string, { x: number; y: number }>()
  const bands: { namespace: string; x: number; y: number; width: number; height: number }[] = []

  let offset = 0
  for (const { namespace, layout, width, height } of namespaceLayouts) {
    const bandX = resolvedArrangement === 'horizontal' ? offset : 0
    const bandY = resolvedArrangement === 'horizontal' ? 0 : offset

    for (const child of layout.children ?? []) {
      autoPositions.set(child.id, {
        x: (child.x ?? 0) + BAND_PADDING_X + bandX,
        y: (child.y ?? 0) + BAND_HEADER_HEIGHT + bandY,
      })
    }

    bands.push({ namespace, x: bandX, y: bandY, width, height })
    offset += (resolvedArrangement === 'horizontal' ? width : height) + BAND_GAP
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

  return { nodes: [...bandNodes, ...workloadNodes], edges: buildEdges(graph), positions }
}

type Rect = { x: number; y: number; width: number; height: number }

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
// re-running layoutGraph:
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

// knownPositions carries forward previously-persisted (dragged or
// already-anchored) node positions so a refresh reuses them instead of
// re-running full auto-layout — see reconcilePositions. The returned
// `positions` map is every workload's final position, ready to be persisted
// as the new baseline for the next call (App.tsx does this via
// lib/nodePositions.ts).
export async function layoutGraph(
  graph: Graph,
  bandArrangement: BandArrangement = 'auto',
  knownPositions: NodePositionMap = {},
): Promise<{
  nodes: Node<WorkloadNodeData | NamespaceBandData>[]
  edges: Edge[]
  positions: Map<string, { x: number; y: number }>
}> {
  const namespaces = Array.from(new Set(graph.nodes.map((n) => n.namespace))).sort()
  if (namespaces.length <= 1) {
    return layoutFlat(graph, knownPositions)
  }
  return layoutSwimlanes(graph, namespaces, bandArrangement, window.innerHeight, knownPositions)
}
