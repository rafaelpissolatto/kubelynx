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

	api.TopologyHandler(prom, topology.DefaultProtocolClasses(), topology.DefaultPortCardinality())(rec, req)

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

	api.TopologyHandler(prom, topology.DefaultProtocolClasses(), topology.DefaultPortCardinality())(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rec.Code, rec.Body.String())
	}
}

func TestTopologyHandler_MultipleNamespaces(t *testing.T) {
	prom := fakePromAPI(t, `{"status":"success","data":{"resultType":"vector","result":[]}}`)

	req := httptest.NewRequest(http.MethodGet, "/api/topology?namespace=demo-frontend,demo-backend", nil)
	rec := httptest.NewRecorder()

	api.TopologyHandler(prom, topology.DefaultProtocolClasses(), topology.DefaultPortCardinality())(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rec.Code, rec.Body.String())
	}
}

// Issue #86: there's no per-request namespace cap; the UI warns about broad
// selections instead of the server rejecting them.
func TestTopologyHandler_ManyNamespaces_Accepted(t *testing.T) {
	prom := fakePromAPI(t, `{"status":"success","data":{"resultType":"vector","result":[]}}`)

	namespaces := make([]string, 50)
	for i := range namespaces {
		namespaces[i] = fmt.Sprintf("ns-%d", i)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/topology?namespace="+strings.Join(namespaces, ","), nil)
	rec := httptest.NewRecorder()

	api.TopologyHandler(prom, topology.DefaultProtocolClasses(), topology.DefaultPortCardinality())(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body: %s", rec.Code, rec.Body.String())
	}
}

func TestTopologyHandler_AllNamespaces_Accepted(t *testing.T) {
	prom := fakePromAPI(t, `{"status":"success","data":{"resultType":"vector","result":[]}}`)

	req := httptest.NewRequest(http.MethodGet, "/api/topology?namespace="+topology.AllNamespaces, nil)
	rec := httptest.NewRecorder()

	api.TopologyHandler(prom, topology.DefaultProtocolClasses(), topology.DefaultPortCardinality())(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rec.Code, rec.Body.String())
	}
}

func TestTopologyHandler_ProtocolFilter_PassedThroughToQuery(t *testing.T) {
	var gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatalf("parsing form: %v", err)
		}
		gotQuery = r.FormValue("query")
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"status":"success","data":{"resultType":"vector","result":[]}}`)
	}))
	t.Cleanup(srv.Close)
	client, err := promapi.NewClient(promapi.Config{Address: srv.URL})
	if err != nil {
		t.Fatalf("creating prometheus client: %v", err)
	}
	prom := promv1.NewAPI(client)

	req := httptest.NewRequest(http.MethodGet, "/api/topology?namespace=demo-backend&protocol=http", nil)
	rec := httptest.NewRecorder()

	api.TopologyHandler(prom, topology.DefaultProtocolClasses(), topology.DefaultPortCardinality())(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(gotQuery, "dst_port") {
		t.Errorf("query %q was not scoped by the requested protocol filter", gotQuery)
	}
}

func TestTopologyHandler_InvalidProtocol_Returns400(t *testing.T) {
	prom := fakePromAPI(t, `{"status":"success","data":{"resultType":"vector","result":[]}}`)

	req := httptest.NewRequest(http.MethodGet, "/api/topology?namespace=demo-backend&protocol=udp", nil)
	rec := httptest.NewRecorder()

	api.TopologyHandler(prom, topology.DefaultProtocolClasses(), topology.DefaultPortCardinality())(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400; body: %s", rec.Code, rec.Body.String())
	}
}

func TestTopologyHandler_DefaultsProtocolToAll(t *testing.T) {
	var gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatalf("parsing form: %v", err)
		}
		gotQuery = r.FormValue("query")
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"status":"success","data":{"resultType":"vector","result":[]}}`)
	}))
	t.Cleanup(srv.Close)
	client, err := promapi.NewClient(promapi.Config{Address: srv.URL})
	if err != nil {
		t.Fatalf("creating prometheus client: %v", err)
	}
	prom := promv1.NewAPI(client)

	req := httptest.NewRequest(http.MethodGet, "/api/topology?namespace=demo-backend", nil)
	rec := httptest.NewRecorder()

	api.TopologyHandler(prom, topology.DefaultProtocolClasses(), topology.DefaultPortCardinality())(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(gotQuery, "dst_port") {
		t.Errorf("query %q should not be scoped by dst_port when protocol is omitted", gotQuery)
	}
}

func TestTopologyHandler_SourceFilter_PassedThroughToQuery(t *testing.T) {
	var gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatalf("parsing form: %v", err)
		}
		gotQuery = r.FormValue("query")
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"status":"success","data":{"resultType":"vector","result":[]}}`)
	}))
	t.Cleanup(srv.Close)
	client, err := promapi.NewClient(promapi.Config{Address: srv.URL})
	if err != nil {
		t.Fatalf("creating prometheus client: %v", err)
	}
	prom := promv1.NewAPI(client)

	req := httptest.NewRequest(http.MethodGet, "/api/topology?namespace=mesh-backend&source=istio", nil)
	rec := httptest.NewRecorder()

	api.TopologyHandler(prom, topology.DefaultProtocolClasses(), topology.DefaultPortCardinality())(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(gotQuery, "istio_requests_total") {
		t.Errorf("query %q was not routed to the Istio source", gotQuery)
	}
}

func TestTopologyHandler_InvalidSource_Returns400(t *testing.T) {
	prom := fakePromAPI(t, `{"status":"success","data":{"resultType":"vector","result":[]}}`)

	req := httptest.NewRequest(http.MethodGet, "/api/topology?namespace=demo-backend&source=prometheus", nil)
	rec := httptest.NewRecorder()

	api.TopologyHandler(prom, topology.DefaultProtocolClasses(), topology.DefaultPortCardinality())(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400; body: %s", rec.Code, rec.Body.String())
	}
}

func TestTopologyHandler_DefaultsSourceToBeyla(t *testing.T) {
	var gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatalf("parsing form: %v", err)
		}
		gotQuery = r.FormValue("query")
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"status":"success","data":{"resultType":"vector","result":[]}}`)
	}))
	t.Cleanup(srv.Close)
	client, err := promapi.NewClient(promapi.Config{Address: srv.URL})
	if err != nil {
		t.Fatalf("creating prometheus client: %v", err)
	}
	prom := promv1.NewAPI(client)

	req := httptest.NewRequest(http.MethodGet, "/api/topology?namespace=demo-backend", nil)
	rec := httptest.NewRecorder()

	api.TopologyHandler(prom, topology.DefaultProtocolClasses(), topology.DefaultPortCardinality())(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(gotQuery, "beyla_network_flow_bytes_total") {
		t.Errorf("query %q was not routed to the default Beyla source", gotQuery)
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

	api.TopologyHandler(prom, topology.DefaultProtocolClasses(), topology.DefaultPortCardinality())(rec, req)

	if rec.Code != http.StatusBadGateway {
		t.Errorf("status = %d, want 502", rec.Code)
	}
}
