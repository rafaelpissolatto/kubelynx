import ELK, { type ElkNode } from 'elkjs/lib/elk.bundled.js'
import type { Edge, Node } from '@xyflow/react'
import { flowId, type Flow, type Graph, type Workload } from './topology'

const elk = new ELK()

export const NODE_WIDTH = 220
export const NODE_HEIGHT = 72

// Traffic-rate-to-stroke-width mapping: log scale so a handful of KB/s and a
// few MB/s edge don't collapse to visually identical lines.
const MIN_STROKE = 1.5
const MAX_STROKE = 8

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
}

function buildEdges(graph: Graph): Edge[] {
  const maxBytesPerSecond = graph.edges.reduce((max, e) => Math.max(max, e.bytesPerSecond), 0)
  return graph.edges.map((flow) => ({
    id: flowId(flow),
    source: flow.source,
    target: flow.target,
    label: edgeLabel(flow),
    // Animated dashes convey traffic actually moving between workloads,
    // rather than a static line implying a dormant/theoretical connection.
    animated: true,
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
// stacks the resulting bands vertically. Cross-namespace edges are still
// rendered — React Flow draws them from each node's absolute position
// regardless of which band it belongs to — they just aren't a factor in
// intra-band node placement.
async function layoutSwimlanes(
  graph: Graph,
  namespaces: string[],
): Promise<{ nodes: Node<WorkloadNodeData | NamespaceBandData>[]; edges: Edge[] }> {
  const positions = new Map<string, { x: number; y: number }>()
  const bands: { namespace: string; y: number; width: number; height: number }[] = []

  let yOffset = 0
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
    const bandWidth = contentWidth + BAND_PADDING_X * 2
    const bandHeight = BAND_HEADER_HEIGHT + contentHeight + BAND_PADDING_BOTTOM

    for (const child of layout.children ?? []) {
      positions.set(child.id, {
        x: (child.x ?? 0) + BAND_PADDING_X,
        y: (child.y ?? 0) + BAND_HEADER_HEIGHT + yOffset,
      })
    }

    bands.push({ namespace, y: yOffset, width: bandWidth, height: bandHeight })
    yOffset += bandHeight + BAND_GAP
  }

  const bandWidth = Math.max(...bands.map((b) => b.width), NODE_WIDTH + BAND_PADDING_X * 2)

  const bandNodes: Node<NamespaceBandData>[] = bands.map((band) => ({
    id: `namespace-band:${band.namespace}`,
    type: 'namespaceBand',
    position: { x: 0, y: band.y },
    style: { width: bandWidth, height: band.height },
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
): Promise<{ nodes: Node<WorkloadNodeData | NamespaceBandData>[]; edges: Edge[] }> {
  const namespaces = Array.from(new Set(graph.nodes.map((n) => n.namespace))).sort()
  if (namespaces.length <= 1) {
    return layoutFlat(graph)
  }
  return layoutSwimlanes(graph, namespaces)
}
