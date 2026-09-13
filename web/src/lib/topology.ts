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

export async function fetchTopology(namespace: string): Promise<Graph> {
  const res = await fetch(`/api/topology?namespace=${encodeURIComponent(namespace)}`)
  if (!res.ok) {
    throw new Error(`GET /api/topology failed: ${res.status} ${res.statusText}`)
  }
  return res.json()
}

export async function fetchNamespaces(): Promise<string[]> {
  const res = await fetch('/api/namespaces')
  if (!res.ok) {
    throw new Error(`GET /api/namespaces failed: ${res.status} ${res.statusText}`)
  }
  return res.json()
}
