// Package api exposes KubeLynx's HTTP surface.
package api

import (
	"encoding/json"
	"log/slog"
	"net/http"

	promv1 "github.com/prometheus/client_golang/api/prometheus/v1"

	"github.com/rafaelpissolatto/kubelynx/internal/topology"
)

// DefaultNamespace is used when a request to /api/topology omits ?namespace.
const DefaultNamespace = "default"

// TopologyHandler serves GET /api/topology?namespace=<ns>, returning the
// topology.Graph JSON shape for the requested namespace.
func TopologyHandler(prom promv1.API) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		namespace := r.URL.Query().Get("namespace")
		if namespace == "" {
			namespace = DefaultNamespace
		}

		graph, err := topology.BuildTopology(r.Context(), prom, namespace)
		if err != nil {
			slog.ErrorContext(r.Context(), "building topology", "namespace", namespace, "error", err)
			http.Error(w, "failed to query prometheus", http.StatusBadGateway)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(graph); err != nil {
			slog.ErrorContext(r.Context(), "encoding topology response", "error", err)
		}
	}
}
