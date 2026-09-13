// Mirrors the JSON shape served by /api/topology
// (internal/topology.Graph in the Go backend).

export interface Workload {
  id: string
  name: string
  namespace: string
  ownerKind?: string
}

export interface Flow {
  source: string
  target: string
  protocol?: string
  port?: string
  bytesPerSecond: number
  query: string
}

export interface Graph {
  nodes: Workload[]
  edges: Flow[]
}

// flowId derives a stable identity for a Flow from the same dimensions
// internal/topology's edgeKey dedupes edges on (source, target, protocol,
// port) — not an array index — so a selection referencing it survives a
// background refresh as long as the same logical flow is still present,
// even if its position in Graph.edges shifts. The delimiters aren't escaped:
// safe today because source/target are workload IDs ("namespace/name", both
// valid Kubernetes names) that can't contain "->" or "|", but revisit this
// if either field ever becomes a less-constrained string.
export function flowId(flow: Flow): string {
  return `${flow.source}->${flow.target}|${flow.protocol ?? ''}|${flow.port ?? ''}`
}

// ProtocolFilter is one of the values /api/protocols returns and
// /api/topology?protocol= accepts. The frontend never hardcodes the set
// itself — see fetchProtocols — matching the same pattern NamespacesResponse
// establishes for AllNamespaces/MaxNamespaces below.
export type ProtocolFilter = string

export async function fetchTopology(namespace: string, protocol: ProtocolFilter): Promise<Graph> {
  const params = new URLSearchParams({ namespace, protocol })
  const res = await fetch(`/api/topology?${params}`)
  if (!res.ok) {
    throw new Error(`GET /api/topology failed: ${res.status} ${res.statusText}`)
  }
  return res.json()
}

// ProtocolsResponse mirrors the JSON shape served by /api/protocols
// (internal/api.protocolsResponse in the Go backend).
export interface ProtocolsResponse {
  protocols: ProtocolFilter[]
}

export async function fetchProtocols(): Promise<ProtocolsResponse> {
  const res = await fetch('/api/protocols')
  if (!res.ok) {
    throw new Error(`GET /api/protocols failed: ${res.status} ${res.statusText}`)
  }
  return res.json()
}

// NamespacesResponse mirrors the JSON shape served by /api/namespaces
// (internal/api.namespacesResponse in the Go backend). `all` is the
// sentinel /api/topology?namespace= accepts to mean "every namespace", and
// `max` is the most namespaces a single /api/topology request may be scoped
// to (all is exempt) — the frontend must never hardcode either value
// itself, since the backend is the only source of truth for both.
export interface NamespacesResponse {
  namespaces: string[]
  all: string
  max: number
}

export async function fetchNamespaces(): Promise<NamespacesResponse> {
  const res = await fetch('/api/namespaces')
  if (!res.ok) {
    throw new Error(`GET /api/namespaces failed: ${res.status} ${res.statusText}`)
  }
  return res.json()
}
