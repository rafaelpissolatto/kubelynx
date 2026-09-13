package topology_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	promapi "github.com/prometheus/client_golang/api"
	promv1 "github.com/prometheus/client_golang/api/prometheus/v1"

	"github.com/rafaelpissolatto/kubelynx/internal/topology"
)

func newFakeAPI(t *testing.T, body string, status int) promv1.API {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		fmt.Fprint(w, body)
	}))
	t.Cleanup(srv.Close)

	client, err := promapi.NewClient(promapi.Config{Address: srv.URL})
	if err != nil {
		t.Fatalf("creating prometheus client: %v", err)
	}
	return promv1.NewAPI(client)
}

const fullAttributeResult = `{
  "status": "success",
  "data": {
    "resultType": "vector",
    "result": [
      {
        "metric": {
          "__name__": "beyla_network_flow_bytes_total",
          "k8s_src_owner_name": "frontend",
          "k8s_src_namespace": "demo-frontend",
          "k8s_src_owner_type": "Deployment",
          "k8s_dst_owner_name": "backend",
          "k8s_dst_namespace": "demo-backend",
          "k8s_dst_owner_type": "Deployment",
          "transport": "TCP",
          "dst_port": "8080",
          "direction": "outgoing"
        },
        "value": [1700000000, "1048576"]
      }
    ]
  }
}`

func TestBuildTopology_FullAttributeSeries(t *testing.T) {
	api := newFakeAPI(t, fullAttributeResult, http.StatusOK)

	graph, err := topology.BuildTopology(context.Background(), api, "demo-backend")
	if err != nil {
		t.Fatalf("BuildTopology: %v", err)
	}

	if len(graph.Nodes) != 2 {
		t.Fatalf("want 2 nodes, got %d: %+v", len(graph.Nodes), graph.Nodes)
	}
	if len(graph.Edges) != 1 {
		t.Fatalf("want 1 edge, got %d: %+v", len(graph.Edges), graph.Edges)
	}

	edge := graph.Edges[0]
	if edge.Protocol != "TCP" {
		t.Errorf("Protocol = %q, want TCP", edge.Protocol)
	}
	if edge.Port != "8080" {
		t.Errorf("Port = %q, want 8080", edge.Port)
	}
	if edge.BytesPerSecond != 1048576 {
		t.Errorf("BytesPerSecond = %v, want 1048576", edge.BytesPerSecond)
	}
	if edge.Query == "" {
		t.Error("Query is empty, want a PromQL string")
	}

	var srcNode, dstNode topology.Workload
	for _, n := range graph.Nodes {
		if n.ID == edge.Source {
			srcNode = n
		}
		if n.ID == edge.Target {
			dstNode = n
		}
	}
	if srcNode.Name != "frontend" || srcNode.Namespace != "demo-frontend" || srcNode.OwnerKind != "Deployment" {
		t.Errorf("source node = %+v, want frontend/demo-frontend/Deployment", srcNode)
	}
	if dstNode.Name != "backend" || dstNode.Namespace != "demo-backend" || dstNode.OwnerKind != "Deployment" {
		t.Errorf("dest node = %+v, want backend/demo-backend/Deployment", dstNode)
	}
}

const partialAttributeResult = `{
  "status": "success",
  "data": {
    "resultType": "vector",
    "result": [
      {
        "metric": {
          "__name__": "beyla_network_flow_bytes_total",
          "k8s_src_owner_name": "frontend",
          "k8s_src_namespace": "demo-frontend",
          "k8s_dst_owner_name": "backend",
          "k8s_dst_namespace": "demo-backend"
        },
        "value": [1700000000, "512"]
      }
    ]
  }
}`

func TestBuildTopology_PartialAttributeSeries_DegradesGracefully(t *testing.T) {
	api := newFakeAPI(t, partialAttributeResult, http.StatusOK)

	graph, err := topology.BuildTopology(context.Background(), api, "demo-backend")
	if err != nil {
		t.Fatalf("BuildTopology: %v", err)
	}

	if len(graph.Edges) != 1 {
		t.Fatalf("want 1 edge (rendered despite missing attrs), got %d", len(graph.Edges))
	}
	edge := graph.Edges[0]
	if edge.Protocol != "" {
		t.Errorf("Protocol = %q, want empty (missing from series)", edge.Protocol)
	}
	if edge.Port != "" {
		t.Errorf("Port = %q, want empty (missing from series)", edge.Port)
	}
	if edge.BytesPerSecond != 512 {
		t.Errorf("BytesPerSecond = %v, want 512", edge.BytesPerSecond)
	}

	if len(graph.Nodes) != 2 {
		t.Fatalf("want 2 nodes despite missing owner-type, got %d: %+v", len(graph.Nodes), graph.Nodes)
	}
	for _, n := range graph.Nodes {
		if n.OwnerKind != "" {
			t.Errorf("node %+v has OwnerKind set, want empty (missing from series)", n)
		}
	}
}

const emptyResult = `{
  "status": "success",
  "data": {
    "resultType": "vector",
    "result": []
  }
}`

func TestBuildTopology_EmptyResult(t *testing.T) {
	api := newFakeAPI(t, emptyResult, http.StatusOK)

	graph, err := topology.BuildTopology(context.Background(), api, "empty-namespace")
	if err != nil {
		t.Fatalf("BuildTopology: %v", err)
	}
	if len(graph.Nodes) != 0 {
		t.Errorf("want 0 nodes, got %d", len(graph.Nodes))
	}
	if len(graph.Edges) != 0 {
		t.Errorf("want 0 edges, got %d", len(graph.Edges))
	}
}

func TestBuildTopology_PrometheusUnreachable(t *testing.T) {
	client, err := promapi.NewClient(promapi.Config{Address: "http://127.0.0.1:1"})
	if err != nil {
		t.Fatalf("creating prometheus client: %v", err)
	}
	api := promv1.NewAPI(client)

	_, err = topology.BuildTopology(context.Background(), api, "demo-backend")
	if err == nil {
		t.Fatal("BuildTopology: want error for unreachable Prometheus, got nil")
	}
}

func TestBuildTopology_AllNamespaces_OmitsNamespaceFilter(t *testing.T) {
	var gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatalf("parsing form: %v", err)
		}
		gotQuery = r.FormValue("query")
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, emptyResult)
	}))
	t.Cleanup(srv.Close)
	client, err := promapi.NewClient(promapi.Config{Address: srv.URL})
	if err != nil {
		t.Fatalf("creating prometheus client: %v", err)
	}
	api := promv1.NewAPI(client)

	if _, err := topology.BuildTopology(context.Background(), api, topology.AllNamespaces); err != nil {
		t.Fatalf("BuildTopology: %v", err)
	}

	if strings.Contains(gotQuery, "k8s_src_namespace=") || strings.Contains(gotQuery, "k8s_dst_namespace=") {
		t.Errorf("query %q filters by namespace, want unfiltered for %q", gotQuery, topology.AllNamespaces)
	}
}

func TestBuildTopology_AllNamespaces_ReturnsWorkloadsAcrossNamespaces(t *testing.T) {
	api := newFakeAPI(t, fullAttributeResult, http.StatusOK)

	graph, err := topology.BuildTopology(context.Background(), api, topology.AllNamespaces)
	if err != nil {
		t.Fatalf("BuildTopology: %v", err)
	}
	if len(graph.Nodes) != 2 {
		t.Fatalf("want 2 nodes, got %d: %+v", len(graph.Nodes), graph.Nodes)
	}
}

func TestBuildTopology_ExcludesResponseDirection(t *testing.T) {
	var gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatalf("parsing form: %v", err)
		}
		gotQuery = r.FormValue("query")
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, emptyResult)
	}))
	t.Cleanup(srv.Close)
	client, err := promapi.NewClient(promapi.Config{Address: srv.URL})
	if err != nil {
		t.Fatalf("creating prometheus client: %v", err)
	}
	api := promv1.NewAPI(client)

	if _, err := topology.BuildTopology(context.Background(), api, "demo-backend"); err != nil {
		t.Fatalf("BuildTopology: %v", err)
	}

	if !strings.Contains(gotQuery, `direction!="response"`) {
		t.Errorf("query %q does not exclude response-direction series", gotQuery)
	}
}

const duplicateCaptureResult = `{
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
          "dst_port": "80",
          "instance": "10.0.0.1:9090"
        },
        "value": [1700000000, "100"]
      },
      {
        "metric": {
          "k8s_src_owner_name": "frontend",
          "k8s_src_namespace": "demo-frontend",
          "k8s_src_owner_type": "Deployment",
          "k8s_dst_owner_name": "backend",
          "k8s_dst_namespace": "demo-backend",
          "k8s_dst_owner_type": "Service",
          "transport": "TCP",
          "dst_port": "80",
          "instance": "10.0.0.2:9090"
        },
        "value": [1700000000, "50"]
      }
    ]
  }
}`

func TestBuildTopology_AggregatesDuplicateCapturePoints(t *testing.T) {
	api := newFakeAPI(t, duplicateCaptureResult, http.StatusOK)

	graph, err := topology.BuildTopology(context.Background(), api, "demo-backend")
	if err != nil {
		t.Fatalf("BuildTopology: %v", err)
	}

	if len(graph.Edges) != 1 {
		t.Fatalf("want 1 aggregated edge, got %d: %+v", len(graph.Edges), graph.Edges)
	}
	if got := graph.Edges[0].BytesPerSecond; got != 150 {
		t.Errorf("BytesPerSecond = %v, want 150 (100+50 summed across capture points)", got)
	}

	var dst topology.Workload
	for _, n := range graph.Nodes {
		if n.ID == graph.Edges[0].Target {
			dst = n
		}
	}
	if dst.OwnerKind != "Deployment" {
		t.Errorf("dst OwnerKind = %q, want Deployment (Service capture-artifact must not win)", dst.OwnerKind)
	}
}

func TestBuildTopology_PrometheusErrors(t *testing.T) {
	api := newFakeAPI(t, `{"status":"error","errorType":"internal","error":"boom"}`, http.StatusInternalServerError)

	_, err := topology.BuildTopology(context.Background(), api, "demo-backend")
	if err == nil {
		t.Fatal("BuildTopology: want error for erroring Prometheus, got nil")
	}
}
