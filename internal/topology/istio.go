package topology

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/prometheus/common/model"
)

// Istio's default telemetry (verified against a real ambient-mode mesh —
// ztunnel + waypoint, no sidecars — see VERIFY-001 and ENV-001 in
// plan/feature-istio-source-1.md): istio_requests_total reports one series
// per HTTP/gRPC request stream, scoped by request_protocol ("http" or
// "grpc"); istio_tcp_sent_bytes_total and istio_tcp_received_bytes_total
// report raw TCP byte counters (request_protocol="tcp" on both). Endpoint
// identity on every one of these metrics lives in source_workload /
// source_workload_namespace / destination_workload /
// destination_workload_namespace; destination_service_name also exists but
// is deliberately not used for node identity, per ADR 0002. None of these
// metrics carries a destination-port label — confirmed against the lab
// cluster's live series, not assumed — so Flow.Port is always "" for
// source=istio.
const (
	istioRequestsMetric    = "istio_requests_total"
	istioTCPSentMetric     = "istio_tcp_sent_bytes_total"
	istioTCPReceivedMetric = "istio_tcp_received_bytes_total"

	istioSrcWorkloadLabel = "source_workload"
	istioSrcNSLabel       = "source_workload_namespace"
	istioDstWorkloadLabel = "destination_workload"
	istioDstNSLabel       = "destination_workload_namespace"
	istioProtocolLabel    = "request_protocol"

	// istioProtocolTCP is the request_protocol value istio_tcp_sent_bytes_total
	// and istio_tcp_received_bytes_total both carry, confirmed against the
	// lab cluster — it's what distinguishes a TCP (MetricBytes) sample from
	// an HTTP/gRPC (MetricRequests) one once both are unioned into a single
	// query result.
	istioProtocolTCP = "tcp"
)

// istioSource is the querySource implementation for SourceIstio.
type istioSource struct{}

// buildQuery renders the PromQL for one BuildTopology call's namespaces/
// protocol scope. protocol routes to only the matching metric family —
// ProtocolHTTP/ProtocolGRPC scope istio_requests_total by its native
// request_protocol label (no port-based heuristic needed, unlike Beyla);
// ProtocolTCP selects only the TCP byte counters; ProtocolAll unions both
// families via "or". classes is accepted for querySource symmetry with
// beylaSource but unused — Istio's request_protocol label makes Beyla's
// port-based ProtocolClasses heuristic unnecessary.
func (istioSource) buildQuery(namespaces []string, protocol string, _ ProtocolClasses) string {
	switch protocol {
	case ProtocolHTTP:
		return istioRequestsQuery(namespaces, "http")
	case ProtocolGRPC:
		return istioRequestsQuery(namespaces, "grpc")
	case ProtocolTCP:
		return istioTCPQuery(namespaces)
	default: // ProtocolAll
		return istioRequestsQuery(namespaces, "") + " or " + istioTCPQuery(namespaces)
	}
}

// istioRequestsQuery renders the rate() query over istio_requests_total,
// scoped to namespaces (src-or-dst match, matching buildTopologyQuery's
// namespace-matching convention) and optionally to one request_protocol
// value ("" applies no request_protocol scoping, for ProtocolAll).
func istioRequestsQuery(namespaces []string, requestProtocol string) string {
	var extra string
	if requestProtocol != "" {
		extra = fmt.Sprintf(`%s=%q`, istioProtocolLabel, requestProtocol)
	}
	return istioMetricQuery(istioRequestsMetric, namespaces, extra)
}

// istioTCPQuery renders the summed rate() query over
// istio_tcp_sent_bytes_total + istio_tcp_received_bytes_total, per REQ-004.
// Both metrics carry identical labels per connection (verified against the
// lab cluster), so the "+" vector-matches each sent series to its received
// counterpart.
func istioTCPQuery(namespaces []string) string {
	sent := istioMetricQuery(istioTCPSentMetric, namespaces, "")
	received := istioMetricQuery(istioTCPReceivedMetric, namespaces, "")
	return fmt.Sprintf("(%s) + (%s)", sent, received)
}

// istioMetricQuery renders `rate(metric{...}[1m])`, scoped to namespaces
// (an "or" of source- and destination-namespace matches, omitted entirely
// for AllNamespaces) plus extraMatcher (a bare "label=value" fragment, or
// "" for none).
func istioMetricQuery(metricName string, namespaces []string, extraMatcher string) string {
	if IsAllNamespaces(namespaces) {
		return fmt.Sprintf(`rate(%s{%s}[%s])`, metricName, extraMatcher, window)
	}
	pattern := namespaceRegexPattern(namespaces)
	extra := commaSuffixed(extraMatcher)
	return fmt.Sprintf(
		`rate(%s{%s=~%q,%s}[%s]) or rate(%s{%s=~%q,%s}[%s])`,
		metricName, istioSrcNSLabel, pattern, extra, window,
		metricName, istioDstNSLabel, pattern, extra, window,
	)
}

// mapSample maps one istio_requests_total or istio_tcp_*_bytes_total
// sample to its two Workload endpoints and flow-shape data. ok=false for a
// sample missing or carrying "unknown" for any endpoint-identity label —
// "unknown" is Istio's own placeholder for an endpoint ztunnel/the waypoint
// couldn't resolve (observed on the lab cluster for traffic leaving the
// mesh), not a real Workload, so it's treated the same as Beyla's "missing
// attribute" case: no edge drawn.
func (istioSource) mapSample(metric model.Metric) (src, dst Workload, protocol, port, metricKind string, ok bool) {
	srcName := string(metric[istioSrcWorkloadLabel])
	srcNS := string(metric[istioSrcNSLabel])
	dstName := string(metric[istioDstWorkloadLabel])
	dstNS := string(metric[istioDstNSLabel])

	if !isResolvedIstioIdentity(srcName) || !isResolvedIstioIdentity(srcNS) ||
		!isResolvedIstioIdentity(dstName) || !isResolvedIstioIdentity(dstNS) {
		return Workload{}, Workload{}, "", "", "", false
	}

	src = Workload{ID: workloadID(srcNS, srcName), Name: srcName, Namespace: srcNS}
	dst = Workload{ID: workloadID(dstNS, dstName), Name: dstName, Namespace: dstNS}

	protocol = string(metric[istioProtocolLabel])
	metricKind = MetricRequests
	if protocol == istioProtocolTCP {
		metricKind = MetricBytes
	}
	// No destination-port label exists on any of these metrics (VERIFY-001).
	port = ""
	return src, dst, protocol, port, metricKind, true
}

// isResolvedIstioIdentity reports whether v is a usable workload/namespace
// identity value — neither missing nor Istio's literal "unknown" sentinel.
func isResolvedIstioIdentity(v string) bool {
	return v != "" && v != "unknown"
}

// edgeQuery renders the drill-down PromQL for one aggregated Istio edge.
// cardinality is accepted for querySource symmetry with beylaSource but
// unused — Istio flows never carry a port (see mapSample), so there's
// nothing for port-cardinality folding to bound.
func (istioSource) edgeQuery(src, dst Workload, protocol, port string, _ PortCardinality) string {
	matchers := []string{
		fmt.Sprintf("%s=%s", istioSrcWorkloadLabel, strconv.Quote(src.Name)),
		fmt.Sprintf("%s=%s", istioSrcNSLabel, strconv.Quote(src.Namespace)),
		fmt.Sprintf("%s=%s", istioDstWorkloadLabel, strconv.Quote(dst.Name)),
		fmt.Sprintf("%s=%s", istioDstNSLabel, strconv.Quote(dst.Namespace)),
	}
	joined := strings.Join(matchers, ",")

	if protocol == istioProtocolTCP {
		return fmt.Sprintf(
			"sum(rate(%s{%s}[%s]) + rate(%s{%s}[%s]))",
			istioTCPSentMetric, joined, window, istioTCPReceivedMetric, joined, window,
		)
	}
	if protocol != "" {
		matchers = append(matchers, fmt.Sprintf("%s=%s", istioProtocolLabel, strconv.Quote(protocol)))
		joined = strings.Join(matchers, ",")
	}
	return fmt.Sprintf("sum(rate(%s{%s}[%s]))", istioRequestsMetric, joined, window)
}
