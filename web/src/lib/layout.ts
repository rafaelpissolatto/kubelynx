import ELK, { type ElkNode } from 'elkjs/lib/elk.bundled.js'
import type { Edge, Node } from '@xyflow/react'
import { flowId, type Flow, type Graph, type Workload } from './topology'
import type { BandArrangement } from './bandArrangement'
import type { NodePositionMap } from './nodePositions'

const elk = new ELK()

export const NODE_WIDTH = 220
export const NODE_HEIGHT = 72

// Must match .workload-node's horizontal padding + border and
// .workload-node__name's font in App.css, so the measured width fits the
// full name on one line instead of ellipsizing it.
const NODE_HORIZONTAL_CHROME = 14 * 2 + 2
const NODE_NAME_FONT = '500 13px ui-sans-serif, system-ui, -apple-system, sans-serif'
// Fallback average glyph width when no canvas is available (e.g. tests).
const APPROX_CHAR_WIDTH = 7.5

let measureContext: CanvasRenderingContext2D | null | undefined

function measureNameWidth(name: string): number {
  if (measureContext === undefined) {
    measureContext = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null
    if (measureContext) measureContext.font = NODE_NAME_FONT
  }
  return measureContext ? measureContext.measureText(name).width : name.length * APPROX_CHAR_WIDTH
}

// Each workload node is as wide as its full name needs (never narrower than
// NODE_WIDTH), so long Deployment/StatefulSet names show whole. ELK gets the
// same width, so wide nodes are spaced apart rather than overlapping.
export function workloadNodeWidth(workload: Workload): number {
  return Math.max(NODE_WIDTH, Math.ceil(measureNameWidth(workload.name) + NODE_HORIZONTAL_CHROME + 4))
}

// Traffic-rate-to-stroke-width mapping: log scale so a handful of KB/s and a
// few MB/s edge don't collapse to visually identical lines.
const MIN_STROKE = 1
const MAX_STROKE = 4

// Traffic-rate-to-animation-speed mapping: busier edges pulse faster (a
// shorter dash-cycle duration) so throughput is visible at a glance, not
// just inferable from stroke width. Same log scale as edgeStrokeWidth so the
// two visual cues agree on what counts as "busy".
const MAX_ANIMATION_DURATION_S = 2
const MIN_ANIMATION_DURATION_S = 0.3

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

// Shared by edgeStrokeWidth and edgeAnimationDuration so both visual cues
// agree on what counts as "busy" — null when there's no traffic to compare
// against (maxBytesPerSecond <= 0), leaving each caller to pick its own
// floor value for that case.
function trafficRatio(bytesPerSecond: number, maxBytesPerSecond: number): number | null {
  if (maxBytesPerSecond <= 0) return null
  return Math.log1p(bytesPerSecond) / Math.log1p(maxBytesPerSecond)
}

export function edgeStrokeWidth(bytesPerSecond: number, maxBytesPerSecond: number): number {
  const ratio = trafficRatio(bytesPerSecond, maxBytesPerSecond)
  if (ratio === null) return MIN_STROKE
  return MIN_STROKE + ratio * (MAX_STROKE - MIN_STROKE)
}

export function edgeAnimationDuration(bytesPerSecond: number, maxBytesPerSecond: number): string {
  const ratio = trafficRatio(bytesPerSecond, maxBytesPerSecond)
  if (ratio === null) return `${MAX_ANIMATION_DURATION_S}s`
  return `${MAX_ANIMATION_DURATION_S - ratio * (MAX_ANIMATION_DURATION_S - MIN_ANIMATION_DURATION_S)}s`
}

export function edgeLabel(flow: Flow): string {
  return [flow.protocol, flow.port ? `:${flow.port}` : undefined].filter(Boolean).join(' ')
}

export type WorkloadNodeData = { workload: Workload }
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
    // Animated dashes single out edges actually carrying traffic right now;
    // a zero-byte edge stays a plain static line instead of implying
    // movement that isn't happening.
    animated: flow.bytesPerSecond > 0,
    style: {
      strokeWidth: edgeStrokeWidth(flow.bytesPerSecond, maxBytesPerSecond),
      animationDuration: edgeAnimationDuration(flow.bytesPerSecond, maxBytesPerSecond),
    },
    data: { flow },
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
  const elkGraph = {
    id: 'root',
    layoutOptions: elkLayoutOptions,
    children: graph.nodes.map((n) => ({ id: n.id, width: workloadNodeWidth(n), height: NODE_HEIGHT })),
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
    style: { width: workloadNodeWidth(workload) },
    data: { workload },
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

  for (const namespace of namespaces) {
    const nsNodes = graph.nodes.filter((n) => n.namespace === namespace)
    const nsNodeIds = new Set(nsNodes.map((n) => n.id))
    const nsEdges = graph.edges.filter((e) => nsNodeIds.has(e.source) && nsNodeIds.has(e.target))

    const elkGraph: ElkNode = {
      id: namespace,
      layoutOptions: elkLayoutOptions,
      children: nsNodes.map((n) => ({ id: n.id, width: workloadNodeWidth(n), height: NODE_HEIGHT })),
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
          return pos ? [{ x: pos.x, y: pos.y, width: workloadNodeWidth(n), height: NODE_HEIGHT }] : []
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
    style: { width: workloadNodeWidth(workload) },
    data: { workload },
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
  return { x: node.position.x, y: node.position.y, width, height: NODE_HEIGHT }
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
