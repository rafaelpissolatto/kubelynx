package api

import (
	"encoding/json"
	"log/slog"
	"net/http"

	promv1 "github.com/prometheus/client_golang/api/prometheus/v1"

	"github.com/rafaelpissolatto/kubelynx/internal/topology"
)

// namespacesResponse is the JSON shape served by /api/namespaces. All is
// included so the frontend never hardcodes topology.AllNamespaces itself —
// it always echoes back whatever value the backend expects on
// /api/topology?namespace= to mean "every namespace".
type namespacesResponse struct {
	Namespaces []string `json:"namespaces"`
	All        string   `json:"all"`
}

// NamespacesHandler serves GET /api/namespaces, returning the sorted set of
// namespaces currently observed in Beyla's flow metrics, plus the sentinel
// value /api/topology accepts to mean "every namespace".
func NamespacesHandler(prom promv1.API) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		namespaces, err := topology.ListNamespaces(r.Context(), prom)
		if err != nil {
			slog.ErrorContext(r.Context(), "listing namespaces", "error", err)
			http.Error(w, "failed to query prometheus", http.StatusBadGateway)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		resp := namespacesResponse{Namespaces: namespaces, All: topology.AllNamespaces}
		if err := json.NewEncoder(w).Encode(resp); err != nil {
			slog.ErrorContext(r.Context(), "encoding namespaces response", "error", err)
		}
	}
}
