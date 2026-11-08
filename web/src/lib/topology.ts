// Mirrors the JSON shape served by /api/topology
// (internal/topology.Graph in the Go backend).

export interface Workload {
  id: string
  name: string
  namespace: string
  ownerKind?: string
}

// Metric is one of the units a Flow's rate is expressed in: "bytes" is a
// byte rate (Beyla's flows, and Istio's TCP flows); "requests" is a request
// rate (Istio's HTTP/gRPC flows, which have no standard byte-rate metric in
// Istio's default telemetry — see ADR 0002). The frontend never assumes
// "bytes" — every rate display and edge-thickness calculation keys off
// whichever Metric the flow actually carries (lib/format.ts's formatRate).
export type Metric = 'bytes' | 'requests'

// FlowSecurity is a Flow's mTLS status (issue #90), from Istio's
// connection_security_policy label — see CONTEXT.md's "Flow security" entry
// and ADR 0002's "Amendment: per-Flow mTLS status" for the contract.
export type FlowSecurity = 'mutual_tls' | 'none' | 'mixed' | 'unknown'

export interface Flow {
  source: string
  target: string
  protocol?: string
  port?: string
  rate: number
  metric: Metric
  query: string
  // Present only for source=istio; absent (not 'unknown') for Beyla, which
  // can't observe mTLS. lib/flowSecurity.ts turns it into labels and styles.
  security?: FlowSecurity
  // 0..1 share of the rate that was mutual_tls; present only when
  // security === 'mixed'.
  mtlsRatio?: number
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
// establishes for AllNamespaces below.
export type ProtocolFilter = string

// TopologyError carries the HTTP status /api/topology responded with, so
// callers can tell a Prometheus-side failure (502, from internal/api's
// TopologyHandler) apart from a rejected request (400, e.g. an invalid
// protocol or source) rather than treating every failure the same way.
export class TopologyError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'TopologyError'
    this.status = status
  }
}

export async function fetchTopology(
  namespace: string,
  protocol: ProtocolFilter,
  source: SourceFilter,
): Promise<Graph> {
  const params = new URLSearchParams({ namespace, protocol, source })
  const res = await fetch(`/api/topology?${params}`)
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).trim()
    throw new TopologyError(res.status, body || `${res.status} ${res.statusText}`)
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

// SourceFilter is one of the values /api/sources returns and
// /api/topology?source= accepts (e.g. "beyla" | "istio") — mirrors
// ProtocolFilter above: the frontend never hardcodes the set itself, since
// the backend is the only source of truth for which telemetry sources it
// actually has data for (ADR 0002).
export type SourceFilter = string

// SourcesResponse mirrors the JSON shape served by /api/sources
// (internal/api.sourcesResponse in the Go backend, added by issue #60).
// `default` is the source /api/topology falls back to when the frontend
// hasn't picked one yet (e.g. no `?source=` override in the URL).
export interface SourcesResponse {
  sources: SourceFilter[]
  default: SourceFilter
}

export async function fetchSources(): Promise<SourcesResponse> {
  const res = await fetch('/api/sources')
  if (!res.ok) {
    throw new Error(`GET /api/sources failed: ${res.status} ${res.statusText}`)
  }
  return res.json()
}

// NamespacesResponse mirrors the JSON shape served by /api/namespaces
// (internal/api.namespacesResponse in the Go backend). `all` is the
// sentinel /api/topology?namespace= accepts to mean "every namespace" — the
// frontend must never hardcode it, since the backend is the only source of
// truth for it.
export interface NamespacesResponse {
  namespaces: string[]
  all: string
}

export async function fetchNamespaces(): Promise<NamespacesResponse> {
  const res = await fetch('/api/namespaces')
  if (!res.ok) {
    throw new Error(`GET /api/namespaces failed: ${res.status} ${res.statusText}`)
  }
  return res.json()
}

// ConfigResponse mirrors the JSON shape served by /api/config
// (internal/api.configResponse in the Go backend): settings the operator
// chose at deploy time (--refresh-interval and --namespace-warn-threshold,
// i.e. the Helm chart's refreshInterval and namespaceWarnThreshold) that the
// frontend can't know on its own. namespaceWarnThreshold is 0 when the
// broad-selection warning is turned off.
export interface ConfigResponse {
  refreshIntervalMs: number
  namespaceWarnThreshold: number
}

export async function fetchConfig(): Promise<ConfigResponse> {
  const res = await fetch('/api/config')
  if (!res.ok) {
    throw new Error(`GET /api/config failed: ${res.status} ${res.statusText}`)
  }
  return res.json()
}
