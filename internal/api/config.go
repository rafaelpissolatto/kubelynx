package api

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"time"
)

// configResponse is the JSON shape served by /api/config: backend settings
// the frontend needs but can't know on its own, e.g. the refresh interval
// set through the Helm chart.
type configResponse struct {
	RefreshIntervalMs int64 `json:"refreshIntervalMs"`
	// NamespaceWarnThreshold is how many namespaces from different prefix
	// groups the UI's namespace picker accepts before warning that the
	// graph may render slowly; 0 turns the warning off. UI behavior only:
	// the backend doesn't cap namespace selections.
	NamespaceWarnThreshold int `json:"namespaceWarnThreshold"`
}

// ConfigHandler serves GET /api/config, returning the UI polling interval
// (--refresh-interval) and the namespace-selection warning threshold
// (--namespace-warn-threshold) the backend was started with.
func ConfigHandler(refreshInterval time.Duration, namespaceWarnThreshold int) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		resp := configResponse{
			RefreshIntervalMs:      refreshInterval.Milliseconds(),
			NamespaceWarnThreshold: namespaceWarnThreshold,
		}
		if err := json.NewEncoder(w).Encode(resp); err != nil {
			slog.ErrorContext(r.Context(), "encoding config response", "error", err)
		}
	}
}
