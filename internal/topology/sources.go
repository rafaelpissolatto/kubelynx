package topology

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	promv1 "github.com/prometheus/client_golang/api/prometheus/v1"
	"github.com/prometheus/common/model"
)

// sourcePresenceQuery is the cheap Prometheus query ListSources runs to
// decide whether each ValidSources entry currently has any data — a
// count() over the source's own metric(s), not a static assumption (see
// REQ-006/REQ-007, plan/feature-istio-source-1.md).
var sourcePresenceQuery = map[string]string{
	SourceBeyla: fmt.Sprintf("count(%s)", metricName),
	SourceIstio: fmt.Sprintf("count(%s) or count(%s) or count(%s)", istioRequestsMetric, istioTCPSentMetric, istioTCPReceivedMetric),
}

// ListSources returns the subset of ValidSources that currently have any
// data in Prometheus, in ValidSources order — so a Beyla-only or
// Istio-only cluster is reported accurately instead of offering a source
// selector value that would silently render an empty Graph.
func ListSources(ctx context.Context, api promv1.API) ([]string, error) {
	var observed []string
	for _, source := range ValidSources {
		query, ok := sourcePresenceQuery[source]
		if !ok {
			continue
		}

		result, warnings, err := api.Query(ctx, query, time.Now())
		if err != nil {
			return nil, fmt.Errorf("querying presence for source %q: %w", source, err)
		}
		if len(warnings) > 0 {
			slog.WarnContext(ctx, "prometheus query returned warnings", "source", source, "warnings", warnings)
		}

		vector, ok := result.(model.Vector)
		if !ok || len(vector) == 0 {
			continue
		}
		observed = append(observed, source)
	}
	return observed, nil
}
