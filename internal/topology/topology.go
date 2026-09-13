package topology

import (
	"context"
	"fmt"
	"log/slog"
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

// AllNamespaces is the BuildTopology namespace value that requests every
// namespace observed, rather than filtering to one.
const AllNamespaces = "all"

// edgeKey identifies one logical edge: Beyla captures the same connection at
// multiple points (once per node's DaemonSet pod, and separately pre/post
// NAT for Service traffic), so several series can describe the same edge —
// those get summed into one Flow rather than rendered as duplicates.
type edgeKey struct {
	source, target, protocol, port string
}

// BuildTopology queries Prometheus for beyla_network_flow_bytes_total series
// (rate over a rolling 1m window) touching namespace — as either source or
// destination — and assembles them into a Graph of Workload nodes and Flow
// edges. A series missing non-identity attributes (protocol, port, ...)
// still produces an edge, just without the missing label.
func BuildTopology(ctx context.Context, api promv1.API, namespace string) (Graph, error) {
	query := buildTopologyQuery(namespace)

	result, warnings, err := api.Query(ctx, query, time.Now())
	if err != nil {
		return Graph{}, fmt.Errorf("querying prometheus for namespace %q: %w", namespace, err)
	}
	if len(warnings) > 0 {
		slog.WarnContext(ctx, "prometheus query returned warnings", "namespace", namespace, "warnings", warnings)
	}

	vector, ok := result.(model.Vector)
	if !ok {
		return Graph{}, fmt.Errorf("unexpected prometheus result type %T for namespace %q", result, namespace)
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

		key := edgeKey{
			source:   srcID,
			target:   dstID,
			protocol: string(metric["transport"]),
			port:     string(metric["dst_port"]),
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
			Query:          edgeQuery(nodes[key.source], nodes[key.target], key.protocol, key.port),
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
// instead of settling on the server's port. namespace == AllNamespaces omits
// the namespace filter entirely, matching every namespace observed.
func buildTopologyQuery(namespace string) string {
	if namespace == AllNamespaces {
		return fmt.Sprintf(`rate(%s{direction!="response"}[%s])`, metricName, window)
	}
	return fmt.Sprintf(
		`rate(%s{k8s_src_namespace=%q,direction!="response"}[%s]) or rate(%s{k8s_dst_namespace=%q,direction!="response"}[%s])`,
		metricName, namespace, window, metricName, namespace, window,
	)
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
// those vary by capture point for what's the same logical edge).
func edgeQuery(src, dst Workload, protocol, port string) string {
	matchers := []string{
		fmt.Sprintf("k8s_src_owner_name=%s", strconv.Quote(src.Name)),
		fmt.Sprintf("k8s_src_namespace=%s", strconv.Quote(src.Namespace)),
		fmt.Sprintf("k8s_dst_owner_name=%s", strconv.Quote(dst.Name)),
		fmt.Sprintf("k8s_dst_namespace=%s", strconv.Quote(dst.Namespace)),
	}
	if protocol != "" {
		matchers = append(matchers, fmt.Sprintf("transport=%s", strconv.Quote(protocol)))
	}
	if port != "" {
		matchers = append(matchers, fmt.Sprintf("dst_port=%s", strconv.Quote(port)))
	}
	return fmt.Sprintf("sum(rate(%s{%s}[%s]))", metricName, strings.Join(matchers, ","), window)
}
