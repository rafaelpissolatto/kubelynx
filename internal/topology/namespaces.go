package topology

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"time"

	promv1 "github.com/prometheus/client_golang/api/prometheus/v1"
)

// namespaceLabels are the labels beyla_network_flow_bytes_total reports
// namespace identity under — a namespace can appear as either a connection's
// source or destination, so both must be queried to find every namespace
// currently observed.
var namespaceLabels = []string{"k8s_src_namespace", "k8s_dst_namespace"}

// ListNamespaces returns the sorted, deduplicated set of namespaces observed
// in Beyla's flow metrics, via Prometheus label_values queries scoped to
// beyla_network_flow_bytes_total — no Kubernetes API access.
func ListNamespaces(ctx context.Context, api promv1.API) ([]string, error) {
	matches := []string{metricName}
	seen := map[string]struct{}{}

	for _, label := range namespaceLabels {
		values, warnings, err := api.LabelValues(ctx, label, matches, time.Time{}, time.Time{})
		if err != nil {
			return nil, fmt.Errorf("querying label values for %q: %w", label, err)
		}
		if len(warnings) > 0 {
			slog.WarnContext(ctx, "prometheus label_values query returned warnings", "label", label, "warnings", warnings)
		}
		for _, v := range values {
			if v == "" {
				continue
			}
			seen[string(v)] = struct{}{}
		}
	}

	namespaces := make([]string, 0, len(seen))
	for ns := range seen {
		namespaces = append(namespaces, ns)
	}
	sort.Strings(namespaces)
	return namespaces, nil
}
