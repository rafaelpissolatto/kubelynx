package topology

import (
	"context"
	"fmt"
	"log/slog"
	"math"
	"time"

	promv1 "github.com/prometheus/client_golang/api/prometheus/v1"
	"github.com/prometheus/common/model"
)

// flowSeriesDocs points operators at the cardinality profile that brings an
// over-budget series count back down (ADR 0003, issue #63).
const flowSeriesDocs = "docs/flow-cardinality.md"

// FlowSeriesCount returns how many beyla_network_flow_bytes_total series
// Prometheus currently holds. ok is false when the query returns an empty
// vector, i.e. no Beyla flow series exist at all (an Istio-only cluster).
func FlowSeriesCount(ctx context.Context, api promv1.API) (count int, ok bool, err error) {
	result, warnings, err := api.Query(ctx, fmt.Sprintf("count(%s)", metricName), time.Now())
	if err != nil {
		return 0, false, fmt.Errorf("counting %s series: %w", metricName, err)
	}
	if len(warnings) > 0 {
		slog.WarnContext(ctx, "prometheus query returned warnings", "metric", metricName, "warnings", warnings)
	}

	vector, isVector := result.(model.Vector)
	if !isVector {
		return 0, false, fmt.Errorf("counting %s series: unexpected result type %s", metricName, result.Type())
	}
	if len(vector) == 0 {
		return 0, false, nil
	}
	v := float64(vector[0].Value)
	if math.IsNaN(v) || math.IsInf(v, 0) || v < 0 {
		return 0, false, fmt.Errorf("counting %s series: invalid count %v", metricName, v)
	}
	return int(v), true, nil
}

// FlowSeriesBudget warns operators when the Beyla flow metric's series
// count exceeds Budget — the sign that the recommended cardinality profile
// (ADR 0003) isn't applied. It logs on state transitions only: one Warn when
// the count goes over, one Info when it drops back under, and nothing while
// the state holds, so a cluster stuck over budget doesn't spam logs.
type FlowSeriesBudget struct {
	API    promv1.API
	Budget int
	Logger *slog.Logger

	over bool
}

// Check runs one count query and logs a state transition if there is one.
// A query error is logged and leaves the previous state untouched, so the
// next successful check decides. An empty result (no Beyla series) is
// "nothing to check" and also leaves the state alone.
func (b *FlowSeriesBudget) Check(ctx context.Context) {
	logger := b.logger()
	count, ok, err := FlowSeriesCount(ctx, b.API)
	if err != nil {
		if ctx.Err() != nil {
			return // shutting down; a cancelled query isn't a Prometheus problem
		}
		logger.WarnContext(ctx, "flow series budget check failed", "metric", metricName, "error", err)
		return
	}
	if !ok {
		logger.DebugContext(ctx, "no flow series to budget", "metric", metricName)
		return
	}

	switch over := count > b.Budget; {
	case over && !b.over:
		logger.WarnContext(ctx, "flow series over budget",
			"series", count, "budget", b.Budget, "metric", metricName, "docs", flowSeriesDocs)
	case !over && b.over:
		logger.InfoContext(ctx, "flow series back under budget",
			"series", count, "budget", b.Budget, "metric", metricName)
	}
	b.over = count > b.Budget
}

// Run calls Check immediately and then every interval until ctx is done.
func (b *FlowSeriesBudget) Run(ctx context.Context, interval time.Duration) {
	b.Check(ctx)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			b.Check(ctx)
		}
	}
}

func (b *FlowSeriesBudget) logger() *slog.Logger {
	if b.Logger != nil {
		return b.Logger
	}
	return slog.Default()
}
