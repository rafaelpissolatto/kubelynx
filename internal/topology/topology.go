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

// labelOrder fixes the order labels appear in a Flow's Query string, so the
// same series always produces the same PromQL text.
var labelOrder = []string{
	"k8s_src_owner_name", "k8s_src_namespace", "k8s_src_owner_type",
	"k8s_dst_owner_name", "k8s_dst_namespace", "k8s_dst_owner_type",
	"transport", "dst_port",
}

// BuildTopology queries Prometheus for beyla_network_flow_bytes_total series
// (rate over a rolling 1m window) touching namespace — as either source or
// destination — and assembles them into a Graph of Workload nodes and Flow
// edges. A series missing non-identity attributes (protocol, port, ...)
// still produces an edge, just without the missing label.
func BuildTopology(ctx context.Context, api promv1.API, namespace string) (Graph, error) {
	query := fmt.Sprintf(
		`rate(%s{k8s_src_namespace=%q}[%s]) or rate(%s{k8s_dst_namespace=%q}[%s])`,
		metricName, namespace, window, metricName, namespace, window,
	)

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
	edges := make([]Flow, 0, len(vector))

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

		src := Workload{
			ID:        workloadID(srcNS, srcName),
			Name:      srcName,
			Namespace: srcNS,
			OwnerKind: string(metric["k8s_src_owner_type"]),
		}
		dst := Workload{
			ID:        workloadID(dstNS, dstName),
			Name:      dstName,
			Namespace: dstNS,
			OwnerKind: string(metric["k8s_dst_owner_type"]),
		}
		nodes[src.ID] = src
		nodes[dst.ID] = dst

		edges = append(edges, Flow{
			Source:         src.ID,
			Target:         dst.ID,
			Protocol:       string(metric["transport"]),
			Port:           string(metric["dst_port"]),
			BytesPerSecond: float64(sample.Value),
			Query:          edgeQuery(metric),
		})
	}

	nodeList := make([]Workload, 0, len(nodes))
	for _, n := range nodes {
		nodeList = append(nodeList, n)
	}
	sort.Slice(nodeList, func(i, j int) bool { return nodeList[i].ID < nodeList[j].ID })
	sort.Slice(edges, func(i, j int) bool {
		if edges[i].Source != edges[j].Source {
			return edges[i].Source < edges[j].Source
		}
		return edges[i].Target < edges[j].Target
	})

	return Graph{Nodes: nodeList, Edges: edges}, nil
}

// workloadID identifies a Workload by namespace + owner name, matching what
// Beyla's k8s.owner.name + k8s.namespace attributes report.
func workloadID(namespace, name string) string {
	return namespace + "/" + name
}

// edgeQuery renders the PromQL query string for a single edge, from
// whichever of labelOrder's labels the series actually carries.
func edgeQuery(metric model.Metric) string {
	matchers := make([]string, 0, len(labelOrder))
	for _, label := range labelOrder {
		if v := metric[model.LabelName(label)]; v != "" {
			matchers = append(matchers, fmt.Sprintf("%s=%s", label, strconv.Quote(string(v))))
		}
	}
	return fmt.Sprintf("rate(%s{%s}[%s])", metricName, strings.Join(matchers, ","), window)
}
