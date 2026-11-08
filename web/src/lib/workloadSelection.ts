import type { Flow, Metric } from './topology'

// Pure helpers behind the Workload panel (issue #75). Kept out of the
// component so the planned search + one-hop focus mode (issue #77) can derive
// the same neighborhood from App's selectedWorkloadId without duplicating it.

// Rate-descending, the same order FlowsTable uses, so the panel's lists read
// as that table filtered to one workload.
function byRateDesc(a: Flow, b: Flow): number {
  return b.rate - a.rate
}

export interface WorkloadFlows {
  // Flows whose target is the workload (the peer is flow.source).
  inbound: Flow[]
  // Flows whose source is the workload (the peer is flow.target).
  outbound: Flow[]
}

export function workloadFlows(flows: Flow[], workloadId: string): WorkloadFlows {
  return {
    inbound: flows.filter((flow) => flow.target === workloadId).sort(byRateDesc),
    outbound: flows.filter((flow) => flow.source === workloadId).sort(byRateDesc),
  }
}

export function touchesWorkload(flow: Flow, workloadId: string): boolean {
  return flow.source === workloadId || flow.target === workloadId
}

// One-hop neighborhood (the workload itself plus every peer it exchanges
// traffic with) — what #77's focus mode keeps visible.
export function workloadNeighborhood(flows: Flow[], workloadId: string): Set<string> {
  const ids = new Set([workloadId])
  for (const flow of flows) {
    if (flow.source === workloadId) ids.add(flow.target)
    if (flow.target === workloadId) ids.add(flow.source)
  }
  return ids
}

export interface RateTotal {
  metric: Metric
  rate: number
}

// Request-rate first: it's the HTTP/gRPC view, usually the one people scan
// for. Byte and request rates are never added to each other (ADR 0002) —
// one total per metric present.
const METRIC_ORDER: Metric[] = ['requests', 'bytes']

export function rateTotals(flows: Flow[]): RateTotal[] {
  const sums = new Map<Metric, number>()
  for (const flow of flows) sums.set(flow.metric, (sums.get(flow.metric) ?? 0) + flow.rate)
  return METRIC_ORDER.filter((metric) => sums.has(metric)).map((metric) => ({
    metric,
    rate: sums.get(metric)!,
  }))
}

// Workload IDs are "namespace/name" (internal/topology); used to keep the
// panel's header readable after the workload has dropped out of the graph.
export function splitWorkloadId(id: string): { namespace: string; name: string } {
  const slash = id.indexOf('/')
  if (slash < 0) return { namespace: '', name: id }
  return { namespace: id.slice(0, slash), name: id.slice(slash + 1) }
}
