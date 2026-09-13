import ELK from 'elkjs/lib/elk.bundled.js'
import type { Edge, Node } from '@xyflow/react'
import type { Flow, Graph, Workload } from './topology'

const elk = new ELK()

export const NODE_WIDTH = 220
export const NODE_HEIGHT = 72

// Traffic-rate-to-stroke-width mapping: log scale so a handful of KB/s and a
// few MB/s edge don't collapse to visually identical lines.
const MIN_STROKE = 1.5
const MAX_STROKE = 8

export function edgeStrokeWidth(bytesPerSecond: number, maxBytesPerSecond: number): number {
  if (maxBytesPerSecond <= 0) return MIN_STROKE
  const ratio = Math.log1p(bytesPerSecond) / Math.log1p(maxBytesPerSecond)
  return MIN_STROKE + ratio * (MAX_STROKE - MIN_STROKE)
}

export function edgeLabel(flow: Flow): string {
  return [flow.protocol, flow.port ? `:${flow.port}` : undefined].filter(Boolean).join(' ')
}

type WorkloadNodeData = { workload: Workload }

export async function layoutGraph(
  graph: Graph,
): Promise<{ nodes: Node<WorkloadNodeData>[]; edges: Edge[] }> {
  const elkGraph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.spacing.nodeNode': '48',
      'elk.layered.spacing.nodeNodeBetweenLayers': '96',
    },
    children: graph.nodes.map((n) => ({ id: n.id, width: NODE_WIDTH, height: NODE_HEIGHT })),
    edges: graph.edges.map((e, i) => ({
      id: `e${i}-${e.source}-${e.target}`,
      sources: [e.source],
      targets: [e.target],
    })),
  }

  const layout = await elk.layout(elkGraph)

  const maxBytesPerSecond = graph.edges.reduce((max, e) => Math.max(max, e.bytesPerSecond), 0)

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

  const edges: Edge[] = graph.edges.map((flow, i) => ({
    id: `e${i}-${flow.source}-${flow.target}`,
    source: flow.source,
    target: flow.target,
    label: edgeLabel(flow),
    style: { strokeWidth: edgeStrokeWidth(flow.bytesPerSecond, maxBytesPerSecond) },
    data: { flow },
  }))

  return { nodes, edges }
}
