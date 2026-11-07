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

// TopologyHandler serves GET /api/topology?namespace=<ns>[,<ns>...]&protocol=<p>&source=<s>,
// returning the topology.Graph JSON shape scoped to the requested
// namespaces, protocol, and telemetry source. More than
// topology.MaxNamespaces namespaces (topology.AllNamespaces excepted) is
// rejected — a request that large risks a graph too big for the browser to
// lay out and render. protocol defaults to topology.ProtocolAll and must
// otherwise be one of topology.ValidProtocols; classes governs how
// topology.ProtocolHTTP and topology.ProtocolGRPC are recognized (see
// topology.ProtocolClasses). cardinality governs which TCP ports get
// individual edges vs. folding into topology.MultiplePorts (see
// topology.PortCardinality). source defaults to topology.SourceBeyla and
// must otherwise be one of topology.ValidSources.
func TopologyHandler(prom promv1.API, classes topology.ProtocolClasses, cardinality topology.PortCardinality) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		namespaces := parseNamespaces(r.URL.Query().Get("namespace"))

		if !topology.IsAllNamespaces(namespaces) && len(namespaces) > topology.MaxNamespaces {
			http.Error(w, fmt.Sprintf("too many namespaces requested (max %d)", topology.MaxNamespaces), http.StatusBadRequest)
			return
		}

		protocol := parseProtocol(r.URL.Query().Get("protocol"))
		if !topology.IsValidProtocol(protocol) {
			http.Error(w, fmt.Sprintf("invalid protocol %q (valid: %s)", protocol, strings.Join(topology.ValidProtocols, ", ")), http.StatusBadRequest)
			return
		}

		source := parseSource(r.URL.Query().Get("source"))
		if !topology.IsValidSource(source) {
			http.Error(w, fmt.Sprintf("invalid source %q (valid: %s)", source, strings.Join(topology.ValidSources, ", ")), http.StatusBadRequest)
			return
		}

		graph, err := topology.BuildTopology(r.Context(), prom, namespaces, protocol, classes, cardinality, source)
		if err != nil {
			slog.ErrorContext(r.Context(), "building topology", "namespaces", namespaces, "protocol", protocol, "source", source, "error", err)
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

// parseProtocol defaults an absent ?protocol= to topology.ProtocolAll,
// leaving validation of the result to the caller (topology.IsValidProtocol).
func parseProtocol(raw string) string {
	if raw == "" {
		return topology.ProtocolAll
	}
	return raw
}

// parseSource defaults an absent ?source= to topology.SourceBeyla, leaving
// validation of the result to the caller (topology.IsValidSource).
func parseSource(raw string) string {
	if raw == "" {
		return topology.SourceBeyla
	}
	return raw
}
