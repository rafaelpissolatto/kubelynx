package topology

import (
	"context"
	"fmt"
	"log/slog"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	promv1 "github.com/prometheus/client_golang/api/prometheus/v1"
	"github.com/prometheus/common/model"
)

const metricName = "beyla_network_flow_bytes_total"

// window is the rolling rate() interval BuildTopology queries over.
const window = "1m"

// AllNamespaces is the BuildTopology namespaces value that requests every
// namespace observed, rather than filtering to a set.
const AllNamespaces = "all"

// MaxNamespaces caps how many namespaces a single BuildTopology call may
// scope to (AllNamespaces is exempt). Beyond this, the resulting node/edge
// count — and the swimlane bands the frontend renders one per namespace —
// risks overwhelming the browser; see issue #14.
const MaxNamespaces = 6

// IsAllNamespaces reports whether namespaces is the [AllNamespaces]
// sentinel value, rather than a set of specific namespaces.
func IsAllNamespaces(namespaces []string) bool {
	return len(namespaces) == 1 && namespaces[0] == AllNamespaces
}

// edgeKey identifies one logical edge: Beyla captures the same connection at
// multiple points (once per node's DaemonSet pod, and separately pre/post
// NAT for Service traffic), so several series can describe the same edge —
// those get summed into one Flow rather than rendered as duplicates.
type edgeKey struct {
	source, target, protocol, port string
}

// BuildTopology queries Prometheus for beyla_network_flow_bytes_total series
// (rate over a rolling 1m window) touching any of namespaces — as either
// source or destination — and assembles them into a Graph of Workload nodes
// and Flow edges. A series missing non-identity attributes (protocol, port,
// ...) still produces an edge, just without the missing label. protocol
// scopes the query to one of ValidProtocols (classes governs how ProtocolHTTP
// and ProtocolGRPC are recognized; see ProtocolClasses) — ProtocolAll applies
// no protocol scoping. cardinality bounds per-port detail: ports outside it
// are folded into a single MultiplePorts edge per (source, target, protocol)
// pair instead of one edge per port (see PortCardinality and boundedPort) —
// this keeps ephemeral/dynamic ports from exploding the returned edge count.
// Callers enforce MaxNamespaces and IsValidProtocol themselves (see
// internal/api); BuildTopology does not reject an oversized namespaces slice
// or invalid protocol on its own.
func BuildTopology(ctx context.Context, api promv1.API, namespaces []string, protocol string, classes ProtocolClasses, cardinality PortCardinality) (Graph, error) {
	query := buildTopologyQuery(namespaces, protocol, classes)

	result, warnings, err := api.Query(ctx, query, time.Now())
	if err != nil {
		return Graph{}, fmt.Errorf("querying prometheus for namespaces %v, protocol %q: %w", namespaces, protocol, err)
	}
	if len(warnings) > 0 {
		slog.WarnContext(ctx, "prometheus query returned warnings", "namespaces", namespaces, "warnings", warnings)
	}

	vector, ok := result.(model.Vector)
	if !ok {
		return Graph{}, fmt.Errorf("unexpected prometheus result type %T for namespaces %v, protocol %q", result, namespaces, protocol)
	}

	nodes := map[string]Workload{}
	edgeOrder := []edgeKey{}
	edgeBytes := map[edgeKey]float64{}

	for _, sample := range vector {
		metric := sample.Metric

		srcName := string(metric["k8s_src_owner_name"])
		srcNS := string(metric["k8s_src_namespace"])
		dstName := string(metric["k8s_dst_owner_name"])
		dstNS := string(metric["k8s_dst_namespace"])

		// Without both endpoints' identity there's no edge to draw.
		if srcName == "" || srcNS == "" || dstName == "" || dstNS == "" {
			continue
		}

		srcID := workloadID(srcNS, srcName)
		dstID := workloadID(dstNS, dstName)
		mergeWorkload(nodes, Workload{
			ID:        srcID,
			Name:      srcName,
			Namespace: srcNS,
			OwnerKind: normalizeOwnerKind(string(metric["k8s_src_owner_type"])),
		})
		mergeWorkload(nodes, Workload{
			ID:        dstID,
			Name:      dstName,
			Namespace: dstNS,
			OwnerKind: normalizeOwnerKind(string(metric["k8s_dst_owner_type"])),
		})

		flowProtocol := string(metric["transport"])
		key := edgeKey{
			source:   srcID,
			target:   dstID,
			protocol: flowProtocol,
			port:     boundedPort(flowProtocol, string(metric["dst_port"]), cardinality),
		}
		if _, seen := edgeBytes[key]; !seen {
			edgeOrder = append(edgeOrder, key)
		}
		edgeBytes[key] += float64(sample.Value)
	}

	nodeList := make([]Workload, 0, len(nodes))
	for _, n := range nodes {
		nodeList = append(nodeList, n)
	}
	sort.Slice(nodeList, func(i, j int) bool { return nodeList[i].ID < nodeList[j].ID })

	edges := make([]Flow, 0, len(edgeOrder))
	for _, key := range edgeOrder {
		edges = append(edges, Flow{
			Source:         key.source,
			Target:         key.target,
			Protocol:       key.protocol,
			Port:           key.port,
			BytesPerSecond: edgeBytes[key],
			Query:          edgeQuery(nodes[key.source], nodes[key.target], key.protocol, key.port, cardinality),
		})
	}
	sort.Slice(edges, func(i, j int) bool {
		if edges[i].Source != edges[j].Source {
			return edges[i].Source < edges[j].Source
		}
		return edges[i].Target < edges[j].Target
	})

	return Graph{Nodes: nodeList, Edges: edges}, nil
}

// buildTopologyQuery renders the PromQL query for BuildTopology.
// direction!="response" drops the reverse-traffic half of each connection,
// which Beyla reports on a fresh ephemeral dst_port per connection — without
// this a single logical flow explodes into one series per connection
// instead of settling on the server's port. namespaces == [AllNamespaces]
// omits the namespace filter entirely, matching every namespace observed;
// otherwise the query matches a series touching any namespace in the set.
// protocol adds the ProtocolClasses-derived scoping from protocolMatcher, or
// nothing for ProtocolAll.
func buildTopologyQuery(namespaces []string, protocol string, classes ProtocolClasses) string {
	protoMatcher := commaSuffixed(protocolMatcher(protocol, classes))

	if IsAllNamespaces(namespaces) {
		return fmt.Sprintf(`rate(%s{%sdirection!="response"}[%s])`, metricName, protoMatcher, window)
	}
	pattern := namespaceRegexPattern(namespaces)
	return fmt.Sprintf(
		`rate(%s{k8s_src_namespace=~%q,%sdirection!="response"}[%s]) or rate(%s{k8s_dst_namespace=~%q,%sdirection!="response"}[%s])`,
		metricName, pattern, protoMatcher, window, metricName, pattern, protoMatcher, window,
	)
}

// protocolMatcher renders the PromQL matcher fragment (without enclosing
// braces or a trailing comma) that scopes a query to protocol, or "" for
// ProtocolAll — no application-protocol label exists on
// beyla_network_flow_bytes_total, so ProtocolHTTP and ProtocolGRPC are
// approximated via classes' dst_port lists, and ProtocolTCP is transport
// "TCP" traffic on neither list.
func protocolMatcher(protocol string, classes ProtocolClasses) string {
	switch protocol {
	case ProtocolHTTP:
		return fmt.Sprintf(`dst_port=~%q`, portPattern(classes.HTTPPorts))
	case ProtocolGRPC:
		return fmt.Sprintf(`dst_port=~%q`, portPattern(classes.GRPCPorts))
	case ProtocolTCP:
		excluded := portPattern(append(append([]string{}, classes.HTTPPorts...), classes.GRPCPorts...))
		if excluded == "" {
			return `transport="TCP"`
		}
		return fmt.Sprintf(`transport="TCP",dst_port!~%q`, excluded)
	default:
		return ""
	}
}

// portPattern renders ports as a PromQL regex-matcher alternation, escaping
// each value the same way namespaceRegexPattern does for namespaces.
func portPattern(ports []string) string {
	escaped := make([]string, len(ports))
	for i, p := range ports {
		escaped[i] = regexp.QuoteMeta(p)
	}
	return strings.Join(escaped, "|")
}

// commaSuffixed appends a trailing comma to matcher so it can be spliced in
// front of another matcher inside a PromQL selector, or returns "" unchanged.
func commaSuffixed(matcher string) string {
	if matcher == "" {
		return ""
	}
	return matcher + ","
}

// namespaceRegexPattern renders namespaces as a PromQL regex-matcher
// alternation, escaping each name so a namespace containing a regex
// metacharacter can't widen the match beyond an exact namespace name.
func namespaceRegexPattern(namespaces []string) string {
	escaped := make([]string, len(namespaces))
	for i, ns := range namespaces {
		escaped[i] = regexp.QuoteMeta(ns)
	}
	return strings.Join(escaped, "|")
}

// workloadID identifies a Workload by namespace + owner name, matching what
// Beyla's k8s.owner.name + k8s.namespace attributes report.
func workloadID(namespace, name string) string {
	return namespace + "/" + name
}

// mergeWorkload records w in nodes, preferring an existing entry's OwnerKind
// only when w doesn't have one — so one capture point's degraded attributes
// don't blank out a kind another capture point already resolved.
func mergeWorkload(nodes map[string]Workload, w Workload) {
	existing, ok := nodes[w.ID]
	if !ok || existing.OwnerKind == "" {
		nodes[w.ID] = w
		return
	}
	if w.OwnerKind == "" {
		w.OwnerKind = existing.OwnerKind
		nodes[w.ID] = w
	}
}

// normalizeOwnerKind treats Beyla's "Service" owner type as unknown: per
// CONTEXT.md, KubeLynx never labels a graph node "Service" — that value
// shows up on Beyla's pre-NAT capture of Service-fronted traffic, not a
// genuine Workload owner kind.
func normalizeOwnerKind(kind string) string {
	if kind == "Service" {
		return ""
	}
	return kind
}

// edgeQuery renders the PromQL query for one aggregated edge: a sum() over
// every capture point sharing this edge's endpoint identity, protocol, and
// port (owner-kind and instance/pod labels are deliberately excluded, since
// those vary by capture point for what's the same logical edge). For a
// MultiplePorts edge, port narrows to the ports cardinality folded into it
// (via portExclusionMatcher) rather than matching a literal "multiple" port.
func edgeQuery(src, dst Workload, protocol, port string, cardinality PortCardinality) string {
	matchers := []string{
		fmt.Sprintf("k8s_src_owner_name=%s", strconv.Quote(src.Name)),
		fmt.Sprintf("k8s_src_namespace=%s", strconv.Quote(src.Namespace)),
		fmt.Sprintf("k8s_dst_owner_name=%s", strconv.Quote(dst.Name)),
		fmt.Sprintf("k8s_dst_namespace=%s", strconv.Quote(dst.Namespace)),
	}
	if protocol != "" {
		matchers = append(matchers, fmt.Sprintf("transport=%s", strconv.Quote(protocol)))
	}
	switch port {
	case "":
		// No port attribute to scope by (attribute-degraded series).
	case MultiplePorts:
		if m := portExclusionMatcher(protocol, cardinality); m != "" {
			matchers = append(matchers, m)
		}
	default:
		matchers = append(matchers, fmt.Sprintf("dst_port=%s", strconv.Quote(port)))
	}
	return fmt.Sprintf("sum(rate(%s{%s}[%s]))", metricName, strings.Join(matchers, ","), window)
}
