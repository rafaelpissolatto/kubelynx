import { flowId, type Graph } from './topology'
import { touchesWorkload, workloadNeighborhood } from './workloadSelection'

// Which nodes and edges stay at full strength (issue #77). The single source
// of dimming for the graph: search, focus mode (#77) and a selected flow
// (#75) all feed in here, and App turns the answer into one CSS class
// (.is-dimmed, opacity only) — never a relayout, never a position or route
// write, so nothing here can disturb lib/nodePositions.ts or lib/edgeRoute.ts.
//
// A null set means "nothing of that kind is dimmed".
export interface GraphEmphasis {
  litNodes: Set<string> | null
  litEdges: Set<string> | null
  // Workload IDs matching the search query, in graph order; empty when the
  // query is empty or nothing matches.
  matches: string[]
}

// Case-insensitive substring match on the workload ID, which is
// "namespace/name" (internal/topology) — so "shop/" finds a namespace and
// "/cart" a name.
export function searchMatches(graph: Graph, query: string): string[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  return graph.nodes.filter((workload) => workload.id.toLowerCase().includes(needle)).map((w) => w.id)
}

// Precedence, highest first:
//  - nodes: an active search (its matches, plus the selected workload so its
//    ring is never greyed out), else focus mode around the selected workload
//    (its one-hop neighborhood), else nothing dimmed.
//  - edges: a selected flow (only it), else an active search (edges between
//    two lit workloads), else focus mode (edges touching the selected
//    workload), else nothing dimmed.
// Search wins over focus so Enter can step through matches — selecting each
// one — without the neighborhood swallowing the other matches; clearing the
// search (Escape) then reveals the focus view of whatever was landed on.
export function graphEmphasis(
  graph: Graph,
  query: string,
  selectedWorkloadId: string | null,
  selectedFlowId: string | null,
  focusMode: boolean,
): GraphEmphasis {
  const matches = searchMatches(graph, query)
  const searching = query.trim() !== ''

  let litNodes: Set<string> | null = null
  if (searching) {
    litNodes = new Set(matches)
    if (selectedWorkloadId) litNodes.add(selectedWorkloadId)
  } else if (focusMode && selectedWorkloadId) {
    litNodes = workloadNeighborhood(graph.edges, selectedWorkloadId)
  }

  let litEdges: Set<string> | null = null
  if (selectedFlowId) {
    litEdges = new Set([selectedFlowId])
  } else if (searching && litNodes) {
    const lit = litNodes
    litEdges = new Set(
      graph.edges.filter((flow) => lit.has(flow.source) && lit.has(flow.target)).map(flowId),
    )
  } else if (focusMode && selectedWorkloadId) {
    const id = selectedWorkloadId
    litEdges = new Set(graph.edges.filter((flow) => touchesWorkload(flow, id)).map(flowId))
  }

  return { litNodes, litEdges, matches }
}

const FOCUS_MODE_STORAGE_KEY = 'kubelynx.focusMode'

// Defaults on: selecting a workload isolates its neighborhood unless the
// user has turned that off. Storage failures fall back to the default, as
// in lib/theme.ts.
export function loadFocusMode(): boolean {
  try {
    return localStorage.getItem(FOCUS_MODE_STORAGE_KEY) !== 'off'
  } catch {
    return true
  }
}

export function saveFocusMode(on: boolean): void {
  try {
    localStorage.setItem(FOCUS_MODE_STORAGE_KEY, on ? 'on' : 'off')
  } catch {
    // Persistence is a nice-to-have.
  }
}
