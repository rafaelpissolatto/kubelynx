package api_test

import (
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/rafaelpissolatto/kubelynx/internal/api"
	"github.com/rafaelpissolatto/kubelynx/internal/topology"
)

func TestProtocolsHandler_ReturnsValidProtocols(t *testing.T) {
	req := httptest.NewRequest("GET", "/api/protocols", nil)
	rec := httptest.NewRecorder()

	api.ProtocolsHandler()(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200; body: %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}

	var resp struct {
		Protocols []string `json:"protocols"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decoding response: %v", err)
	}
	if len(resp.Protocols) != len(topology.ValidProtocols) {
		t.Errorf("protocols = %v, want %v", resp.Protocols, topology.ValidProtocols)
	}
}
