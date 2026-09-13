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

// ProtocolFilter mirrors the values internal/topology.ValidProtocols accepts
// for /api/topology?protocol=. Unlike the namespace list, this vocabulary is
// fixed (not cluster-specific), so it's safe to hardcode on the frontend.
export type ProtocolFilter = 'all' | 'http' | 'grpc' | 'tcp'

export const PROTOCOL_FILTERS: ProtocolFilter[] = ['all', 'http', 'grpc', 'tcp']

export async function fetchTopology(namespace: string, protocol: ProtocolFilter): Promise<Graph> {
  const params = new URLSearchParams({ namespace, protocol })
  const res = await fetch(`/api/topology?${params}`)
  if (!res.ok) {
    throw new Error(`GET /api/topology failed: ${res.status} ${res.statusText}`)
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
