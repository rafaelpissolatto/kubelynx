package api

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/rafaelpissolatto/kubelynx/internal/topology"
)

// protocolsResponse is the JSON shape served by /api/protocols. Protocols is
// included so the frontend never hardcodes topology.ValidProtocols itself —
// it always echoes back whatever values /api/topology?protocol= accepts.
type protocolsResponse struct {
	Protocols []string `json:"protocols"`
}

// ProtocolsHandler serves GET /api/protocols, returning the protocol filter
// values /api/topology?protocol= accepts.
func ProtocolsHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		resp := protocolsResponse{Protocols: topology.ValidProtocols}
		if err := json.NewEncoder(w).Encode(resp); err != nil {
			slog.ErrorContext(r.Context(), "encoding protocols response", "error", err)
		}
	}
}
