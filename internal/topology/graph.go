// Package topology builds KubeLynx's Graph (Workload nodes + Flow edges) by
// querying Prometheus for a selected telemetry source's series — Beyla's
// beyla_network_flow_bytes_total, or Istio's istio_requests_total /
// istio_tcp_sent_bytes_total / istio_tcp_received_bytes_total (see
// ValidSources).
package topology

// Graph is the JSON shape served by /api/topology.
type Graph struct {
	Nodes []Workload `json:"nodes"`
	Edges []Flow     `json:"edges"`
}

// Workload is a Kubernetes owner object (Deployment, ReplicaSet, DaemonSet,
// or StatefulSet) plus its namespace — see CONTEXT.md's "Workload" entry.
// Node identity is Workload-only for every source BuildTopology supports,
// even for a source (Istio) that also reports genuine Service identity —
// see ADR 0002.
type Workload struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
	OwnerKind string `json:"ownerKind,omitempty"`
}

// MetricBytes and MetricRequests are the values Flow.Metric takes: which
// real-world quantity Flow.Rate is a per-second rate of.
const (
	// MetricBytes means Rate is a byte/sec rate (Beyla's network flows;
	// Istio's istio_tcp_sent_bytes_total + istio_tcp_received_bytes_total).
	MetricBytes = "bytes"
	// MetricRequests means Rate is a request/sec rate (Istio's
	// istio_requests_total HTTP/gRPC flows — Istio's default telemetry has
	// no standard byte-rate metric for HTTP/gRPC traffic).
	MetricRequests = "requests"
)

// Flow is a directed edge between two Workloads, aggregated (summed) from
// every series sharing that edge's endpoint identity, protocol, and port
// for the selected source.
type Flow struct {
	Source   string `json:"source"`
	Target   string `json:"target"`
	Protocol string `json:"protocol,omitempty"`
	Port     string `json:"port,omitempty"`
	// Rate is a per-second rate; Metric names which quantity it measures
	// (MetricBytes or MetricRequests) — the frontend keys edge-thickness
	// scaling and labels off Metric rather than assuming bytes.
	Rate   float64 `json:"rate"`
	Metric string  `json:"metric"`
	Query  string  `json:"query"`
	// Security is the edge's mTLS status, derived from Istio's
	// connection_security_policy label (see edgeSecurity and ADR 0002's
	// "per-Flow mTLS status" amendment): one of SecurityMutualTLS,
	// SecurityNone, SecurityMixed, or SecurityUnknown. It is "" (omitted
	// from JSON) for a source that doesn't observe connection security
	// (Beyla).
	Security string `json:"security,omitempty"`
	// MTLSRatio is the share of Rate that was mutual_tls, strictly between
	// 0 and 1. Set only when Security is SecurityMixed; 0 (omitted)
	// otherwise.
	MTLSRatio float64 `json:"mtlsRatio,omitempty"`
}

// Flow.Security values (ADR 0002, issue #90).
const (
	// SecurityMutualTLS means every policy-labelled sample on the edge
	// with a non-zero rate was mutual_tls.
	SecurityMutualTLS = "mutual_tls"
	// SecurityNone means every policy-labelled sample on the edge with a
	// non-zero rate was plaintext ("none").
	SecurityNone = "none"
	// SecurityMixed means the edge carried both mutual_tls and plaintext
	// traffic; Flow.MTLSRatio holds the mutual_tls share.
	SecurityMixed = "mixed"
	// SecurityUnknown means the source observes connection security but no
	// sample on the edge reported a known policy with a non-zero rate.
	SecurityUnknown = "unknown"
)
