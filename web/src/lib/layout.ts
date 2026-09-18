import ELK, { type ElkNode } from 'elkjs/lib/elk.bundled.js'
import type { Edge, Node } from '@xyflow/react'
import { flowId, type Flow, type Graph, type Workload } from './topology'
import type { BandArrangement } from './bandArrangement'

const elk = new ELK()

export const NODE_WIDTH = 220
export const NODE_HEIGHT = 72

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

type WorkloadNodeData = { workload: Workload }
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

async function layoutFlat(
  graph: Graph,
): Promise<{ nodes: Node<WorkloadNodeData>[]; edges: Edge[] }> {
  const elkGraph = {
    id: 'root',
    layoutOptions: elkLayoutOptions,
    children: graph.nodes.map((n) => ({ id: n.id, width: NODE_WIDTH, height: NODE_HEIGHT })),
    edges: graph.edges.map((e, i) => ({
      id: `e${i}-${e.source}-${e.target}`,
      sources: [e.source],
      targets: [e.target],
    })),
  }

  const layout = await elk.layout(elkGraph)

  const positions = new Map<string, { x: number; y: number }>()
  for (const child of layout.children ?? []) {
    positions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 })
  }

  const nodes: Node<WorkloadNodeData>[] = graph.nodes.map((workload) => ({
    id: workload.id,
    type: 'workload',
    position: positions.get(workload.id) ?? { x: 0, y: 0 },
    data: { workload },
  }))

  return { nodes, edges: buildEdges(graph) }
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
): Promise<{ nodes: Node<WorkloadNodeData | NamespaceBandData>[]; edges: Edge[] }> {
  const namespaceLayouts: { namespace: string; layout: ElkNode; width: number; height: number }[] = []

  for (const namespace of namespaces) {
    const nsNodes = graph.nodes.filter((n) => n.namespace === namespace)
    const nsNodeIds = new Set(nsNodes.map((n) => n.id))
    const nsEdges = graph.edges.filter((e) => nsNodeIds.has(e.source) && nsNodeIds.has(e.target))

    const elkGraph: ElkNode = {
      id: namespace,
      layoutOptions: elkLayoutOptions,
      children: nsNodes.map((n) => ({ id: n.id, width: NODE_WIDTH, height: NODE_HEIGHT })),
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

  const positions = new Map<string, { x: number; y: number }>()
  const bands: { namespace: string; x: number; y: number; width: number; height: number }[] = []

  let offset = 0
  for (const { namespace, layout, width, height } of namespaceLayouts) {
    const bandX = resolvedArrangement === 'horizontal' ? offset : 0
    const bandY = resolvedArrangement === 'horizontal' ? 0 : offset

    for (const child of layout.children ?? []) {
      positions.set(child.id, {
        x: (child.x ?? 0) + BAND_PADDING_X + bandX,
        y: (child.y ?? 0) + BAND_HEADER_HEIGHT + bandY,
      })
    }

    bands.push({ namespace, x: bandX, y: bandY, width, height })
    offset += (resolvedArrangement === 'horizontal' ? width : height) + BAND_GAP
  }

  // Bands share one common size along the axis perpendicular to the one
  // they're arranged on, so every band's rectangle lines up evenly instead
  // of being only as big as its own namespace's content.
  if (resolvedArrangement === 'horizontal') {
    const uniformHeight = Math.max(...bands.map((b) => b.height))
    for (const band of bands) band.height = uniformHeight
  } else {
    const uniformWidth = Math.max(...bands.map((b) => b.width))
    for (const band of bands) band.width = uniformWidth
  }

  const bandNodes: Node<NamespaceBandData>[] = bands.map((band) => ({
    id: `namespace-band:${band.namespace}`,
    type: 'namespaceBand',
    position: { x: band.x, y: band.y },
    style: { width: band.width, height: band.height },
    data: { namespace: band.namespace },
    selectable: false,
    draggable: false,
    zIndex: -1,
  }))

  const workloadNodes: Node<WorkloadNodeData>[] = graph.nodes.map((workload) => ({
    id: workload.id,
    type: 'workload',
    position: positions.get(workload.id) ?? { x: 0, y: 0 },
    data: { workload },
  }))

  return { nodes: [...bandNodes, ...workloadNodes], edges: buildEdges(graph) }
}

export async function layoutGraph(
  graph: Graph,
  bandArrangement: BandArrangement = 'auto',
): Promise<{ nodes: Node<WorkloadNodeData | NamespaceBandData>[]; edges: Edge[] }> {
  const namespaces = Array.from(new Set(graph.nodes.map((n) => n.namespace))).sort()
  if (namespaces.length <= 1) {
    return layoutFlat(graph)
  }
  return layoutSwimlanes(graph, namespaces, bandArrangement, window.innerHeight)
}
