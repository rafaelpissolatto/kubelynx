import { createContext } from 'react'
import { flowId, type Flow, type Metric } from './topology'
import { formatRate } from './format'
import { edgeLabel } from './layout'

// How the graph is drawn, chosen under Display ▾ (issue #76). None of these
// change the data fetched or the layout: they're applied on top of an
// already-laid-out graph (App.tsx's renderedEdges, FloatingEdge, and a
// data attribute on the canvas for namespace bands).

// What a flow's label says while its edge is hovered or selected (labels
// stay gated on hover/selection — see FloatingEdge and issue #37). 'port'
// is the PROTOCOL :PORT text the graph has always shown; 'none' turns
// labels off entirely.
export type EdgeLabelMode = 'none' | 'rate' | 'port'
export const EDGE_LABEL_MODES: EdgeLabelMode[] = ['none', 'rate', 'port']

// Share of the quietest flows hidden from the canvas, ranked separately per
// Flow.metric (see hiddenFlowIds). 0 hides nothing.
export type LowTrafficCutoff = 0 | 25 | 50 | 75
export const LOW_TRAFFIC_CUTOFFS: LowTrafficCutoff[] = [0, 25, 50, 75]

export interface DisplayOptions {
  edgeLabels: EdgeLabelMode
  // Off removes the moving dots' elements (and with them their SMIL
  // animation clocks), not just their paint.
  trafficAnimation: boolean
  lowTrafficCutoff: LowTrafficCutoff
  // Band backgrounds and titles; visual only, layout is unchanged.
  namespaceBands: boolean
  // React Flow's overview minimap in the canvas corner (issue #81).
  minimap: boolean
}

// Matches how the graph looked before Display ▾ existed.
export const DEFAULT_DISPLAY_OPTIONS: DisplayOptions = {
  edgeLabels: 'port',
  trafficAnimation: true,
  lowTrafficCutoff: 0,
  namespaceBands: true,
  minimap: false,
}

const STORAGE_KEY = 'kubelynx.display'

// Read field by field, so one stale or hand-edited value falls back to its
// own default without discarding the rest.
function parse(raw: string): DisplayOptions {
  const value: unknown = JSON.parse(raw)
  if (typeof value !== 'object' || value === null) return DEFAULT_DISPLAY_OPTIONS
  const v = value as Record<string, unknown>
  const d = DEFAULT_DISPLAY_OPTIONS
  return {
    edgeLabels: (EDGE_LABEL_MODES as unknown[]).includes(v.edgeLabels) ? (v.edgeLabels as EdgeLabelMode) : d.edgeLabels,
    trafficAnimation: typeof v.trafficAnimation === 'boolean' ? v.trafficAnimation : d.trafficAnimation,
    lowTrafficCutoff: (LOW_TRAFFIC_CUTOFFS as unknown[]).includes(v.lowTrafficCutoff)
      ? (v.lowTrafficCutoff as LowTrafficCutoff)
      : d.lowTrafficCutoff,
    namespaceBands: typeof v.namespaceBands === 'boolean' ? v.namespaceBands : d.namespaceBands,
    minimap: typeof v.minimap === 'boolean' ? v.minimap : d.minimap,
  }
}

// localStorage access is wrapped in try/catch for the same reason as
// theme.ts and bandArrangement.ts: private browsing, disabled storage, quota
// errors (or here, malformed JSON) just mean the defaults come back.
export function loadDisplayOptions(): DisplayOptions {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw !== null ? parse(raw) : DEFAULT_DISPLAY_OPTIONS
  } catch {
    return DEFAULT_DISPLAY_OPTIONS
  }
}

export function saveDisplayOptions(options: DisplayOptions): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(options))
  } catch {
    // Persistence is a nice-to-have; losing it silently is fine.
  }
}

// The flows the low-traffic cutoff takes off the canvas, by flowId. Flows
// are ranked within their own Flow.metric only: an Istio graph mixes request
// rates (HTTP/gRPC) and byte rates (TCP), and a byte count is not
// comparable to a request count. Within a metric, a flow is hidden when its
// rate is below the rate at the cutoff's rank (nearest-rank percentile), so
// ties at the boundary all stay, and a metric with a single flow never loses
// it. Nodes are never hidden — only edges.
export function hiddenFlowIds(flows: Flow[], cutoff: LowTrafficCutoff): Set<string> {
  const hidden = new Set<string>()
  if (cutoff === 0) return hidden
  const byMetric = new Map<Metric, Flow[]>()
  for (const flow of flows) {
    const group = byMetric.get(flow.metric) ?? []
    group.push(flow)
    byMetric.set(flow.metric, group)
  }
  for (const group of byMetric.values()) {
    const rates = group.map((f) => f.rate).sort((a, b) => a - b)
    const threshold = rates[Math.floor((rates.length * cutoff) / 100)]
    for (const flow of group) {
      if (flow.rate < threshold) hidden.add(flowId(flow))
    }
  }
  return hidden
}

// The label text an edge shows (on hover or selection) for a label mode.
export function edgeLabelText(flow: Flow, mode: EdgeLabelMode): string | undefined {
  if (mode === 'none') return undefined
  if (mode === 'rate') return formatRate(flow.rate, flow.metric)
  return edgeLabel(flow) || undefined
}

// The per-edge options FloatingEdge reads; provided around <ReactFlow> in
// App.tsx so a change re-renders edges without rebuilding edge objects.
export const EdgeDisplayContext = createContext<Pick<DisplayOptions, 'edgeLabels' | 'trafficAnimation'>>({
  edgeLabels: DEFAULT_DISPLAY_OPTIONS.edgeLabels,
  trafficAnimation: DEFAULT_DISPLAY_OPTIONS.trafficAnimation,
})
