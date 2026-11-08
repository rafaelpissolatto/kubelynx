package api

import (
	"encoding/json"
	"log/slog"
	"net/http"

	promv1 "github.com/prometheus/client_golang/api/prometheus/v1"

	"github.com/rafaelpissolatto/kubelynx/internal/topology"
)

// sourcesResponse is the JSON shape served by /api/sources. Default is
// included so the frontend never hardcodes topology.SourceBeyla itself —
// it always echoes back whatever value /api/topology?source= defaults to.
type sourcesResponse struct {
	Sources []string `json:"sources"`
	Default string   `json:"default"`
}

// SourcesHandler serves GET /api/sources, reporting which telemetry
// source(s) (topology.ValidSources) currently have data in Prometheus —
// not a static list, so a Beyla-only or Istio-only cluster is reported
// accurately.
func SourcesHandler(prom promv1.API) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sources, err := topology.ListSources(r.Context(), prom)
		if err != nil {
			slog.ErrorContext(r.Context(), "listing sources", "error", err)
			http.Error(w, "failed to query prometheus", http.StatusBadGateway)
			return
		}

		// Always a JSON array, never null: the UI reads sources.length, and
		// a cluster with no telemetry yet has no sources at all.
		if sources == nil {
			sources = []string{}
		}

		w.Header().Set("Content-Type", "application/json")
		resp := sourcesResponse{Sources: sources, Default: topology.SourceBeyla}
		if err := json.NewEncoder(w).Encode(resp); err != nil {
			slog.ErrorContext(r.Context(), "encoding sources response", "error", err)
		}
	}
}
