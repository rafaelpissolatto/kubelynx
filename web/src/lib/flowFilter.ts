import type { Flow } from './topology'

// Case-insensitive substring match against a flow's source and/or
// destination workload ID (namespace/name), used by FlowsTable's text
// filter. A blank query matches everything.
export function matchesFlowFilter(flow: Flow, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return flow.source.toLowerCase().includes(needle) || flow.target.toLowerCase().includes(needle)
}
