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
}

// ConfigHandler serves GET /api/config, returning the UI polling interval the
// backend was started with (--refresh-interval).
func ConfigHandler(refreshInterval time.Duration) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		resp := configResponse{RefreshIntervalMs: refreshInterval.Milliseconds()}
		if err := json.NewEncoder(w).Encode(resp); err != nil {
			slog.ErrorContext(r.Context(), "encoding config response", "error", err)
		}
	}
}
