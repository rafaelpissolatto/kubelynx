package api_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	promapi "github.com/prometheus/client_golang/api"
	promv1 "github.com/prometheus/client_golang/api/prometheus/v1"

	"github.com/rafaelpissolatto/kubelynx/internal/api"
	"github.com/rafaelpissolatto/kubelynx/internal/topology"
)

func fakePromAPI(t *testing.T, body string) promv1.API {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, body)
	}))
	t.Cleanup(srv.Close)

	client, err := promapi.NewClient(promapi.Config{Address: srv.URL})
	if err != nil {
		t.Fatalf("creating prometheus client: %v", err)
	}
	return promv1.NewAPI(client)
}

func TestTopologyHandler_ReturnsGraphJSON(t *testing.T) {
	prom := fakePromAPI(t, `{
	  "status": "success",
	  "data": {
	    "resultType": "vector",
	    "result": [
	      {
	        "metric": {
	          "k8s_src_owner_name": "frontend",
	          "k8s_src_namespace": "demo-frontend",
	          "k8s_src_owner_type": "Deployment",
	          "k8s_dst_owner_name": "backend",
	          "k8s_dst_namespace": "demo-backend",
	          "k8s_dst_owner_type": "Deployment",
	          "transport": "TCP",
	          "dst_port": "8080"
	        },
	        "value": [1700000000, "1024"]
	      }
	    ]
	  }
	}`)

	req := httptest.NewRequest(http.MethodGet, "/api/topology?namespace=demo-backend", nil)
	rec := httptest.NewRecorder()

	api.TopologyHandler(prom)(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}

	var graph topology.Graph
	if err := json.Unmarshal(rec.Body.Bytes(), &graph); err != nil {
		t.Fatalf("decoding response: %v", err)
	}
	if len(graph.Nodes) != 2 {
		t.Errorf("want 2 nodes, got %d", len(graph.Nodes))
	}
	if len(graph.Edges) != 1 {
		t.Errorf("want 1 edge, got %d", len(graph.Edges))
	}
}

func TestTopologyHandler_DefaultsNamespace(t *testing.T) {
	prom := fakePromAPI(t, `{"status":"success","data":{"resultType":"vector","result":[]}}`)

	req := httptest.NewRequest(http.MethodGet, "/api/topology", nil)
	rec := httptest.NewRecorder()

	api.TopologyHandler(prom)(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rec.Code, rec.Body.String())
	}
}

func TestTopologyHandler_PrometheusError(t *testing.T) {
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

	req := httptest.NewRequest(http.MethodGet, "/api/topology?namespace=demo-backend", nil)
	rec := httptest.NewRecorder()

	api.TopologyHandler(prom)(rec, req)

	if rec.Code != http.StatusBadGateway {
		t.Errorf("status = %d, want 502", rec.Code)
	}
}
