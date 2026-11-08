package topology

import (
	"slices"

	"github.com/prometheus/common/model"
)

// Source selector values BuildTopology accepts (its source parameter).
// SourceBeyla is the zero-value default — an empty string passed to
// sourceFor is treated as SourceBeyla so no internal caller breaks
// silently if one is missed during a refactor, but every caller should
// pass one of ValidSources explicitly (see REQ-002,
// plan/feature-istio-source-1.md).
const (
	SourceBeyla = "beyla"
	SourceIstio = "istio"
)

// ValidSources lists every value BuildTopology's source parameter accepts,
// in the order /api/sources reports them.
var ValidSources = []string{SourceBeyla, SourceIstio}

// IsValidSource reports whether source is one of ValidSources.
func IsValidSource(source string) bool {
	return slices.Contains(ValidSources, source)
}

// querySource is the per-telemetry-source seam BuildTopology selects
// between (see sourceFor). An implementation owns its own PromQL and label
// mapping, but must produce Workloads/Flows in the same Graph shape as
// every other source — BuildTopology's control flow never branches on
// source beyond calling these three methods (see ADR 0002, REQ-003).
type querySource interface {
	// buildQuery renders the PromQL query to run for a namespaces/protocol
	// scope. classes governs how ProtocolHTTP/ProtocolGRPC are recognized
	// for a source that classifies by port rather than a native label
	// (Beyla); a source with a native application-protocol label (Istio)
	// may ignore it.
	buildQuery(namespaces []string, protocol string, classes ProtocolClasses) string

	// mapSample maps one result-vector sample's label set to its two
	// Workload endpoints, the protocol/port values BuildTopology groups
	// edges by, and which Metric kind (MetricBytes or MetricRequests) the
	// sample belongs to. ok=false means the sample lacks enough identity
	// to produce an edge and BuildTopology skips it. security is the
	// sample's connection security policy as the source reports it (Istio:
	// "mutual_tls", "none", or "unknown" for a missing/unrecognised value);
	// a source that doesn't observe connection security (Beyla) returns ""
	// for every sample, and BuildTopology then leaves Flow.Security unset
	// (see edgeSecurity).
	mapSample(metric model.Metric) (src, dst Workload, protocol, port, metricKind, security string, ok bool)

	// edgeQuery renders the drill-down PromQL for one aggregated edge
	// (src, dst, protocol, port as BuildTopology computed them).
	// cardinality scopes a MultiplePorts edge to the ports folded into it,
	// for a source with per-port detail (Beyla); a source without ports
	// (Istio) may ignore it.
	edgeQuery(src, dst Workload, protocol, port string, cardinality PortCardinality) string
}

// sourceFor resolves source to its querySource implementation. "" and
// SourceBeyla both resolve to the Beyla seam (see SourceBeyla's doc
// comment); any other unrecognized value also falls back to Beyla rather
// than panicking — callers are expected to reject an invalid source via
// IsValidSource before calling BuildTopology.
func sourceFor(source string) querySource {
	if source == SourceIstio {
		return istioSource{}
	}
	return beylaSource{}
}
