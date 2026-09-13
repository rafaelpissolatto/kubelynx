package api

import (
	"encoding/json"
	"log/slog"
	"net/http"

	promv1 "github.com/prometheus/client_golang/api/prometheus/v1"

	"github.com/rafaelpissolatto/kubelynx/internal/topology"
)

// NamespacesHandler serves GET /api/namespaces, returning the sorted JSON
// array of namespaces currently observed in Beyla's flow metrics.
func NamespacesHandler(prom promv1.API) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		namespaces, err := topology.ListNamespaces(r.Context(), prom)
		if err != nil {
			slog.ErrorContext(r.Context(), "listing namespaces", "error", err)
			http.Error(w, "failed to query prometheus", http.StatusBadGateway)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(namespaces); err != nil {
			slog.ErrorContext(r.Context(), "encoding namespaces response", "error", err)
		}
	}
}
