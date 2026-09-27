package api_test

import (
	"net/http/httptest"
	"testing"
	"time"

	"github.com/rafaelpissolatto/kubelynx/internal/api"
)

func TestConfigHandler_ReturnsRefreshIntervalInMilliseconds(t *testing.T) {
	req := httptest.NewRequest("GET", "/api/config", nil)
	rec := httptest.NewRecorder()

	api.ConfigHandler(30*time.Second)(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200; body: %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
	if got, want := rec.Body.String(), "{\"refreshIntervalMs\":30000}\n"; got != want {
		t.Errorf("body = %q, want %q", got, want)
	}
}
