// Package api exposes KubeLynx's HTTP surface.
package api

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	promv1 "github.com/prometheus/client_golang/api/prometheus/v1"

	"github.com/rafaelpissolatto/kubelynx/internal/topology"
)

// DefaultNamespace is used when a request to /api/topology omits ?namespace.
const DefaultNamespace = "default"

// TopologyHandler serves GET /api/topology?namespace=<ns>[,<ns>...], returning
// the topology.Graph JSON shape scoped to the requested namespaces. More than
// topology.MaxNamespaces namespaces (topology.AllNamespaces excepted) is
// rejected — a request that large risks a graph too big for the browser to
// lay out and render.
func TopologyHandler(prom promv1.API) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		namespaces := parseNamespaces(r.URL.Query().Get("namespace"))

		if !isAllNamespaces(namespaces) && len(namespaces) > topology.MaxNamespaces {
			http.Error(w, fmt.Sprintf("too many namespaces requested (max %d)", topology.MaxNamespaces), http.StatusBadRequest)
			return
		}

		graph, err := topology.BuildTopology(r.Context(), prom, namespaces)
		if err != nil {
			slog.ErrorContext(r.Context(), "building topology", "namespaces", namespaces, "error", err)
			http.Error(w, "failed to query prometheus", http.StatusBadGateway)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(graph); err != nil {
			slog.ErrorContext(r.Context(), "encoding topology response", "error", err)
		}
	}
}

// parseNamespaces splits ?namespace= on commas, trimming whitespace and
// dropping empty segments, defaulting to DefaultNamespace when the
// parameter is absent or empty.
func parseNamespaces(raw string) []string {
	if raw == "" {
		return []string{DefaultNamespace}
	}

	var namespaces []string
	for part := range strings.SplitSeq(raw, ",") {
		if part = strings.TrimSpace(part); part != "" {
			namespaces = append(namespaces, part)
		}
	}
	if len(namespaces) == 0 {
		return []string{DefaultNamespace}
	}
	return namespaces
}

func isAllNamespaces(namespaces []string) bool {
	return len(namespaces) == 1 && namespaces[0] == topology.AllNamespaces
}
