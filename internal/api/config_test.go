package api_test

import (
	"net/http/httptest"
	"testing"
	"time"

	"github.com/rafaelpissolatto/kubelynx/internal/api"
)

func TestConfigHandler_ReturnsRefreshIntervalAndNamespaceWarnThreshold(t *testing.T) {
	req := httptest.NewRequest("GET", "/api/config", nil)
	rec := httptest.NewRecorder()

	api.ConfigHandler(30*time.Second, 6)(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200; body: %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
	if got, want := rec.Body.String(), "{\"refreshIntervalMs\":30000,\"namespaceWarnThreshold\":6}\n"; got != want {
		t.Errorf("body = %q, want %q", got, want)
	}
}

func TestConfigHandler_NamespaceWarnThresholdZeroMeansOff(t *testing.T) {
	req := httptest.NewRequest("GET", "/api/config", nil)
	rec := httptest.NewRecorder()

	api.ConfigHandler(15*time.Second, 0)(rec, req)

	// Still sent explicitly (no omitempty), so the UI can tell "off" apart
	// from an older backend that doesn't know the field.
	if got, want := rec.Body.String(), "{\"refreshIntervalMs\":15000,\"namespaceWarnThreshold\":0}\n"; got != want {
		t.Errorf("body = %q, want %q", got, want)
	}
}
