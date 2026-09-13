package api_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	promapi "github.com/prometheus/client_golang/api"
	promv1 "github.com/prometheus/client_golang/api/prometheus/v1"

	"github.com/rafaelpissolatto/kubelynx/internal/api"
)

func TestNamespacesHandler_ReturnsSortedNamespaces(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/api/v1/label/k8s_src_namespace/values" {
			w.Write([]byte(`{"status":"success","data":["demo-frontend"]}`))
			return
		}
		w.Write([]byte(`{"status":"success","data":["demo-backend"]}`))
	}))
	t.Cleanup(srv.Close)
	client, err := promapi.NewClient(promapi.Config{Address: srv.URL})
	if err != nil {
		t.Fatalf("creating prometheus client: %v", err)
	}
	prom := promv1.NewAPI(client)

	req := httptest.NewRequest(http.MethodGet, "/api/namespaces", nil)
	rec := httptest.NewRecorder()

	api.NamespacesHandler(prom)(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}

	var namespaces []string
	if err := json.Unmarshal(rec.Body.Bytes(), &namespaces); err != nil {
		t.Fatalf("decoding response: %v", err)
	}
	want := []string{"demo-backend", "demo-frontend"}
	if len(namespaces) != len(want) {
		t.Fatalf("namespaces = %v, want %v", namespaces, want)
	}
	for i, ns := range want {
		if namespaces[i] != ns {
			t.Errorf("namespaces[%d] = %q, want %q", i, namespaces[i], ns)
		}
	}
}

func TestNamespacesHandler_PrometheusError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"status":"error","errorType":"internal","error":"boom"}`))
	}))
	t.Cleanup(srv.Close)
	client, err := promapi.NewClient(promapi.Config{Address: srv.URL})
	if err != nil {
		t.Fatalf("creating prometheus client: %v", err)
	}
	prom := promv1.NewAPI(client)

	req := httptest.NewRequest(http.MethodGet, "/api/namespaces", nil)
	rec := httptest.NewRecorder()

	api.NamespacesHandler(prom)(rec, req)

	if rec.Code != http.StatusBadGateway {
		t.Errorf("status = %d, want 502", rec.Code)
	}
}
