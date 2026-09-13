package api

import (
	"encoding/json"
	"log/slog"
	"net/http"

	promv1 "github.com/prometheus/client_golang/api/prometheus/v1"

	"github.com/rafaelpissolatto/kubelynx/internal/topology"
)

// namespacesResponse is the JSON shape served by /api/namespaces. All and
// Max are included so the frontend never hardcodes topology.AllNamespaces
// or topology.MaxNamespaces itself — it always echoes back whatever values
// /api/topology expects and enforces.
type namespacesResponse struct {
	Namespaces []string `json:"namespaces"`
	All        string   `json:"all"`
	Max        int      `json:"max"`
}

// NamespacesHandler serves GET /api/namespaces, returning the sorted set of
// namespaces currently observed in Beyla's flow metrics, plus the sentinel
// value and selection cap /api/topology enforces.
func NamespacesHandler(prom promv1.API) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		namespaces, err := topology.ListNamespaces(r.Context(), prom)
		if err != nil {
			slog.ErrorContext(r.Context(), "listing namespaces", "error", err)
			http.Error(w, "failed to query prometheus", http.StatusBadGateway)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		resp := namespacesResponse{
			Namespaces: namespaces,
			All:        topology.AllNamespaces,
			Max:        topology.MaxNamespaces,
		}
		if err := json.NewEncoder(w).Encode(resp); err != nil {
			slog.ErrorContext(r.Context(), "encoding namespaces response", "error", err)
		}
	}
}
