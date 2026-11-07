package api_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	promapi "github.com/prometheus/client_golang/api"
	promv1 "github.com/prometheus/client_golang/api/prometheus/v1"

	"github.com/rafaelpissolatto/kubelynx/internal/api"
	"github.com/rafaelpissolatto/kubelynx/internal/topology"
)

// fakeSourcesPromAPI returns a fake Prometheus whose count() query results
// are driven by which metric name(s) the query text mentions, mirroring
// internal/topology's own ListSources fakes but kept local to this
// package's test convention.
func fakeSourcesPromAPI(t *testing.T, present ...string) promv1.API {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatalf("parsing form: %v", err)
		}
		query := r.FormValue("query")
		w.Header().Set("Content-Type", "application/json")
		for _, metric := range present {
			if strings.Contains(query, metric) {
				fmt.Fprint(w, `{"status":"success","data":{"resultType":"vector","result":[{"metric":{},"value":[1700000000,"1"]}]}}`)
				return
			}
		}
		fmt.Fprint(w, `{"status":"success","data":{"resultType":"vector","result":[]}}`)
	}))
	t.Cleanup(srv.Close)

	client, err := promapi.NewClient(promapi.Config{Address: srv.URL})
	if err != nil {
		t.Fatalf("creating prometheus client: %v", err)
	}
	return promv1.NewAPI(client)
}

func TestSourcesHandler_BothPresent(t *testing.T) {
	prom := fakeSourcesPromAPI(t, "beyla_network_flow_bytes_total", "istio_requests_total")

	req := httptest.NewRequest(http.MethodGet, "/api/sources", nil)
	rec := httptest.NewRecorder()

	api.SourcesHandler(prom)(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}

	var resp struct {
		Sources []string `json:"sources"`
		Default string   `json:"default"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decoding response: %v", err)
	}
	want := []string{topology.SourceBeyla, topology.SourceIstio}
	if len(resp.Sources) != len(want) {
		t.Fatalf("sources = %v, want %v", resp.Sources, want)
	}
	for i, s := range want {
		if resp.Sources[i] != s {
			t.Errorf("sources[%d] = %q, want %q", i, resp.Sources[i], s)
		}
	}
	if resp.Default != topology.SourceBeyla {
		t.Errorf("Default = %q, want %q", resp.Default, topology.SourceBeyla)
	}
}

func TestSourcesHandler_OnlyBeylaPresent(t *testing.T) {
	prom := fakeSourcesPromAPI(t, "beyla_network_flow_bytes_total")

	req := httptest.NewRequest(http.MethodGet, "/api/sources", nil)
	rec := httptest.NewRecorder()

	api.SourcesHandler(prom)(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rec.Code, rec.Body.String())
	}

	var resp struct {
		Sources []string `json:"sources"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decoding response: %v", err)
	}
	if len(resp.Sources) != 1 || resp.Sources[0] != topology.SourceBeyla {
		t.Errorf("sources = %v, want [%q]", resp.Sources, topology.SourceBeyla)
	}
}

func TestSourcesHandler_NeitherPresent(t *testing.T) {
	prom := fakeSourcesPromAPI(t)

	req := httptest.NewRequest(http.MethodGet, "/api/sources", nil)
	rec := httptest.NewRecorder()

	api.SourcesHandler(prom)(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rec.Code, rec.Body.String())
	}

	var resp struct {
		Sources []string `json:"sources"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decoding response: %v", err)
	}
	if len(resp.Sources) != 0 {
		t.Errorf("sources = %v, want empty", resp.Sources)
	}
}

func TestSourcesHandler_PrometheusError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		fmt.Fprint(w, `{"status":"error","errorType":"internal","error":"boom"}`)
	}))
	t.Cleanup(srv.Close)
	client, err := promapi.NewClient(promapi.Config{Address: srv.URL})
	if err != nil {
		t.Fatalf("creating prometheus client: %v", err)
	}
	prom := promv1.NewAPI(client)

	req := httptest.NewRequest(http.MethodGet, "/api/sources", nil)
	rec := httptest.NewRecorder()

	api.SourcesHandler(prom)(rec, req)

	if rec.Code != http.StatusBadGateway {
		t.Errorf("status = %d, want 502", rec.Code)
	}
}
