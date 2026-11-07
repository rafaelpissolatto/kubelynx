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

	graph, err := topology.BuildTopology(context.Background(), api, []string{"demo-backend"}, topology.ProtocolAll, topology.DefaultProtocolClasses(), topology.DefaultPortCardinality(), topology.SourceBeyla)
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
	if edge.Rate != 1048576 {
		t.Errorf("Rate = %v, want 1048576", edge.Rate)
	}
	if edge.Metric != topology.MetricBytes {
		t.Errorf("Metric = %q, want %q", edge.Metric, topology.MetricBytes)
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

	graph, err := topology.BuildTopology(context.Background(), api, []string{"demo-backend"}, topology.ProtocolAll, topology.DefaultProtocolClasses(), topology.DefaultPortCardinality(), topology.SourceBeyla)
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
	if edge.Rate != 512 {
		t.Errorf("Rate = %v, want 512", edge.Rate)
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

	graph, err := topology.BuildTopology(context.Background(), api, []string{"empty-namespace"}, topology.ProtocolAll, topology.DefaultProtocolClasses(), topology.DefaultPortCardinality(), topology.SourceBeyla)
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

	_, err = topology.BuildTopology(context.Background(), api, []string{"demo-backend"}, topology.ProtocolAll, topology.DefaultProtocolClasses(), topology.DefaultPortCardinality(), topology.SourceBeyla)
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

	if _, err := topology.BuildTopology(context.Background(), api, []string{topology.AllNamespaces}, topology.ProtocolAll, topology.DefaultProtocolClasses(), topology.DefaultPortCardinality(), topology.SourceBeyla); err != nil {
		t.Fatalf("BuildTopology: %v", err)
	}

	if strings.Contains(gotQuery, "k8s_src_namespace=") || strings.Contains(gotQuery, "k8s_dst_namespace=") {
		t.Errorf("query %q filters by namespace, want unfiltered for %q", gotQuery, topology.AllNamespaces)
	}
}

func TestBuildTopology_AllNamespaces_ReturnsWorkloadsAcrossNamespaces(t *testing.T) {
	api := newFakeAPI(t, fullAttributeResult, http.StatusOK)

	graph, err := topology.BuildTopology(context.Background(), api, []string{topology.AllNamespaces}, topology.ProtocolAll, topology.DefaultProtocolClasses(), topology.DefaultPortCardinality(), topology.SourceBeyla)
	if err != nil {
		t.Fatalf("BuildTopology: %v", err)
	}
	if len(graph.Nodes) != 2 {
		t.Fatalf("want 2 nodes, got %d: %+v", len(graph.Nodes), graph.Nodes)
	}
}

func TestBuildTopology_MultipleNamespaces_MatchesAny(t *testing.T) {
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

	if _, err := topology.BuildTopology(context.Background(), api, []string{"demo-frontend", "demo-backend"}, topology.ProtocolAll, topology.DefaultProtocolClasses(), topology.DefaultPortCardinality(), topology.SourceBeyla); err != nil {
		t.Fatalf("BuildTopology: %v", err)
	}

	if !strings.Contains(gotQuery, `k8s_src_namespace=~"demo-frontend|demo-backend"`) {
		t.Errorf("query %q does not match on either requested namespace via src", gotQuery)
	}
	if !strings.Contains(gotQuery, `k8s_dst_namespace=~"demo-frontend|demo-backend"`) {
		t.Errorf("query %q does not match on either requested namespace via dst", gotQuery)
	}
}

func TestBuildTopology_MultipleNamespaces_ReturnsWorkloadsFromEither(t *testing.T) {
	api := newFakeAPI(t, fullAttributeResult, http.StatusOK)

	graph, err := topology.BuildTopology(context.Background(), api, []string{"demo-frontend", "demo-backend"}, topology.ProtocolAll, topology.DefaultProtocolClasses(), topology.DefaultPortCardinality(), topology.SourceBeyla)
	if err != nil {
		t.Fatalf("BuildTopology: %v", err)
	}
	if len(graph.Nodes) != 2 {
		t.Fatalf("want 2 nodes, got %d: %+v", len(graph.Nodes), graph.Nodes)
	}
}

func TestBuildTopology_NamespaceWithRegexMetacharacters_IsEscaped(t *testing.T) {
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

	if _, err := topology.BuildTopology(context.Background(), api, []string{"weird.ns", "another+ns"}, topology.ProtocolAll, topology.DefaultProtocolClasses(), topology.DefaultPortCardinality(), topology.SourceBeyla); err != nil {
		t.Fatalf("BuildTopology: %v", err)
	}

	// regexp.QuoteMeta escapes "." to `\.`; embedding that in the PromQL
	// query text via %q escapes the backslash again, so the wire text
	// carries two backslashes — which Prometheus's own string parsing
	// collapses back to the single literal `\.` regexp.QuoteMeta intended.
	if !strings.Contains(gotQuery, `weird\\.ns`) || !strings.Contains(gotQuery, `another\\+ns`) {
		t.Errorf("query %q does not escape regex metacharacters in namespace names", gotQuery)
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

	if _, err := topology.BuildTopology(context.Background(), api, []string{"demo-backend"}, topology.ProtocolAll, topology.DefaultProtocolClasses(), topology.DefaultPortCardinality(), topology.SourceBeyla); err != nil {
		t.Fatalf("BuildTopology: %v", err)
	}

	if !strings.Contains(gotQuery, `direction!="response"`) {
		t.Errorf("query %q does not exclude response-direction series", gotQuery)
	}
}

func TestBuildTopology_Istio_ProtocolFilter_ScopesQuery(t *testing.T) {
	tests := []struct {
		name     string
		protocol string
		want     []string
		notWant  []string
	}{
		{"all", topology.ProtocolAll, []string{"istio_requests_total", "istio_tcp_sent_bytes_total", "istio_tcp_received_bytes_total"}, nil},
		{"http", topology.ProtocolHTTP, []string{`istio_requests_total`, `request_protocol="http"`}, []string{"istio_tcp_sent_bytes_total"}},
		{"grpc", topology.ProtocolGRPC, []string{`istio_requests_total`, `request_protocol="grpc"`}, []string{"istio_tcp_sent_bytes_total"}},
		{"tcp", topology.ProtocolTCP, []string{"istio_tcp_sent_bytes_total", "istio_tcp_received_bytes_total"}, []string{"istio_requests_total"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
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

			if _, err := topology.BuildTopology(context.Background(), api, []string{"mesh-backend"}, tt.protocol, topology.DefaultProtocolClasses(), topology.DefaultPortCardinality(), topology.SourceIstio); err != nil {
				t.Fatalf("BuildTopology: %v", err)
			}

			for _, want := range tt.want {
				if !strings.Contains(gotQuery, want) {
					t.Errorf("query %q does not contain %q", gotQuery, want)
				}
			}
			for _, notWant := range tt.notWant {
				if strings.Contains(gotQuery, notWant) {
					t.Errorf("query %q unexpectedly contains %q", gotQuery, notWant)
				}
			}
			if !strings.Contains(gotQuery, `source_workload_namespace=~"mesh-backend"`) {
				t.Errorf("query %q does not scope by the requested namespace via source_workload_namespace", gotQuery)
			}
		})
	}
}

func TestBuildTopology_Istio_AllNamespaces_OmitsNamespaceFilter(t *testing.T) {
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

	if _, err := topology.BuildTopology(context.Background(), api, []string{topology.AllNamespaces}, topology.ProtocolAll, topology.DefaultProtocolClasses(), topology.DefaultPortCardinality(), topology.SourceIstio); err != nil {
		t.Fatalf("BuildTopology: %v", err)
	}

	if strings.Contains(gotQuery, "source_workload_namespace=") || strings.Contains(gotQuery, "destination_workload_namespace=") {
		t.Errorf("query %q filters by namespace, want unfiltered for %q", gotQuery, topology.AllNamespaces)
	}
}

func TestBuildTopology_ProtocolFilter_ScopesQuery(t *testing.T) {
	classes := topology.ProtocolClasses{HTTPPorts: []string{"80", "8080"}, GRPCPorts: []string{"50051"}}

	tests := []struct {
		name     string
		protocol string
		want     []string
	}{
		{"all", topology.ProtocolAll, nil},
		{"http", topology.ProtocolHTTP, []string{`dst_port=~"80|8080"`}},
		{"grpc", topology.ProtocolGRPC, []string{`dst_port=~"50051"`}},
		{"tcp", topology.ProtocolTCP, []string{`transport="TCP"`, `dst_port!~"80|8080|50051"`}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
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

			if _, err := topology.BuildTopology(context.Background(), api, []string{"demo-backend"}, tt.protocol, classes, topology.DefaultPortCardinality(), topology.SourceBeyla); err != nil {
				t.Fatalf("BuildTopology: %v", err)
			}

			for _, want := range tt.want {
				if !strings.Contains(gotQuery, want) {
					t.Errorf("query %q does not contain %q", gotQuery, want)
				}
			}
			if tt.protocol == topology.ProtocolAll {
				if strings.Contains(gotQuery, "dst_port") {
					t.Errorf("query %q for ProtocolAll should not scope by dst_port", gotQuery)
				}
			}
		})
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

	graph, err := topology.BuildTopology(context.Background(), api, []string{"demo-backend"}, topology.ProtocolAll, topology.DefaultProtocolClasses(), topology.DefaultPortCardinality(), topology.SourceBeyla)
	if err != nil {
		t.Fatalf("BuildTopology: %v", err)
	}

	if len(graph.Edges) != 1 {
		t.Fatalf("want 1 aggregated edge, got %d: %+v", len(graph.Edges), graph.Edges)
	}
	if got := graph.Edges[0].Rate; got != 150 {
		t.Errorf("Rate = %v, want 150 (100+50 summed across capture points)", got)
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

	_, err := topology.BuildTopology(context.Background(), api, []string{"demo-backend"}, topology.ProtocolAll, topology.DefaultProtocolClasses(), topology.DefaultPortCardinality(), topology.SourceBeyla)
	if err == nil {
		t.Fatal("BuildTopology: want error for erroring Prometheus, got nil")
	}
}

// portCardinalityResult synthesizes one TCP series on an allow-listed port,
// two TCP series on distinct non-allow-listed (ephemeral) ports, one UDP
// series on DNS's port 53, and two UDP series on distinct non-DNS
// (ephemeral) ports — all for the same source/target pair, so
// BuildTopology's port-cardinality bounding is exercised end to end.
const portCardinalityResult = `{
  "status": "success",
  "data": {
    "resultType": "vector",
    "result": [
      {
        "metric": {
          "k8s_src_owner_name": "frontend", "k8s_src_namespace": "demo",
          "k8s_dst_owner_name": "backend", "k8s_dst_namespace": "demo",
          "transport": "TCP", "dst_port": "8080"
        },
        "value": [1700000000, "100"]
      },
      {
        "metric": {
          "k8s_src_owner_name": "frontend", "k8s_src_namespace": "demo",
          "k8s_dst_owner_name": "backend", "k8s_dst_namespace": "demo",
          "transport": "TCP", "dst_port": "54001"
        },
        "value": [1700000000, "10"]
      },
      {
        "metric": {
          "k8s_src_owner_name": "frontend", "k8s_src_namespace": "demo",
          "k8s_dst_owner_name": "backend", "k8s_dst_namespace": "demo",
          "transport": "TCP", "dst_port": "54002"
        },
        "value": [1700000000, "20"]
      },
      {
        "metric": {
          "k8s_src_owner_name": "frontend", "k8s_src_namespace": "demo",
          "k8s_dst_owner_name": "backend", "k8s_dst_namespace": "demo",
          "transport": "UDP", "dst_port": "53"
        },
        "value": [1700000000, "5"]
      },
      {
        "metric": {
          "k8s_src_owner_name": "frontend", "k8s_src_namespace": "demo",
          "k8s_dst_owner_name": "backend", "k8s_dst_namespace": "demo",
          "transport": "UDP", "dst_port": "61000"
        },
        "value": [1700000000, "1"]
      },
      {
        "metric": {
          "k8s_src_owner_name": "frontend", "k8s_src_namespace": "demo",
          "k8s_dst_owner_name": "backend", "k8s_dst_namespace": "demo",
          "transport": "UDP", "dst_port": "61001"
        },
        "value": [1700000000, "2"]
      }
    ]
  }
}`

func TestBuildTopology_TCPAllowedPort_KeepsIndividualEdge(t *testing.T) {
	api := newFakeAPI(t, portCardinalityResult, http.StatusOK)

	graph, err := topology.BuildTopology(context.Background(), api, []string{"demo"}, topology.ProtocolAll, topology.DefaultProtocolClasses(), topology.DefaultPortCardinality(), topology.SourceBeyla)
	if err != nil {
		t.Fatalf("BuildTopology: %v", err)
	}

	edge := findEdge(t, graph, "TCP", "8080")
	if edge.Rate != 100 {
		t.Errorf("Rate = %v, want 100 (allow-listed port kept unaggregated)", edge.Rate)
	}
}

func TestBuildTopology_TCPDisallowedPorts_AggregateIntoMultiple(t *testing.T) {
	api := newFakeAPI(t, portCardinalityResult, http.StatusOK)

	graph, err := topology.BuildTopology(context.Background(), api, []string{"demo"}, topology.ProtocolAll, topology.DefaultProtocolClasses(), topology.DefaultPortCardinality(), topology.SourceBeyla)
	if err != nil {
		t.Fatalf("BuildTopology: %v", err)
	}

	edge := findEdge(t, graph, "TCP", topology.MultiplePorts)
	if edge.Rate != 30 {
		t.Errorf("Rate = %v, want 30 (10+20 summed across non-allow-listed ports)", edge.Rate)
	}
	if edge.Query == "" {
		t.Error("Query is empty, want a PromQL string scoping to the aggregated ports")
	}

	for _, e := range graph.Edges {
		if e.Protocol == "TCP" && e.Port != "8080" && e.Port != topology.MultiplePorts {
			t.Errorf("unexpected individual TCP edge for non-allow-listed port %q, want it folded into %q", e.Port, topology.MultiplePorts)
		}
	}
}

func TestBuildTopology_UDPDNSPort_KeepsIndividualEdge(t *testing.T) {
	api := newFakeAPI(t, portCardinalityResult, http.StatusOK)

	graph, err := topology.BuildTopology(context.Background(), api, []string{"demo"}, topology.ProtocolAll, topology.DefaultProtocolClasses(), topology.DefaultPortCardinality(), topology.SourceBeyla)
	if err != nil {
		t.Fatalf("BuildTopology: %v", err)
	}

	edge := findEdge(t, graph, "UDP", "53")
	if edge.Rate != 5 {
		t.Errorf("Rate = %v, want 5 (DNS port kept unaggregated)", edge.Rate)
	}
}

func TestBuildTopology_UDPNonDNSPorts_AggregateIntoMultiple(t *testing.T) {
	api := newFakeAPI(t, portCardinalityResult, http.StatusOK)

	graph, err := topology.BuildTopology(context.Background(), api, []string{"demo"}, topology.ProtocolAll, topology.DefaultProtocolClasses(), topology.DefaultPortCardinality(), topology.SourceBeyla)
	if err != nil {
		t.Fatalf("BuildTopology: %v", err)
	}

	edge := findEdge(t, graph, "UDP", topology.MultiplePorts)
	if edge.Rate != 3 {
		t.Errorf("Rate = %v, want 3 (1+2 summed across non-DNS UDP ports)", edge.Rate)
	}

	for _, e := range graph.Edges {
		if e.Protocol == "UDP" && e.Port != "53" && e.Port != topology.MultiplePorts {
			t.Errorf("unexpected individual UDP edge for non-DNS port %q, want it folded into %q", e.Port, topology.MultiplePorts)
		}
	}
}

func TestBuildTopology_CustomTCPAllowlist_ChangesWhatStaysIndividual(t *testing.T) {
	api := newFakeAPI(t, portCardinalityResult, http.StatusOK)

	narrowAllowlist := topology.PortCardinality{AllowedTCPPorts: []string{"54001"}}
	graph, err := topology.BuildTopology(context.Background(), api, []string{"demo"}, topology.ProtocolAll, topology.DefaultProtocolClasses(), narrowAllowlist, topology.SourceBeyla)
	if err != nil {
		t.Fatalf("BuildTopology: %v", err)
	}

	edge := findEdge(t, graph, "TCP", "54001")
	if edge.Rate != 10 {
		t.Errorf("Rate = %v, want 10 (port allow-listed by the custom config kept unaggregated)", edge.Rate)
	}

	multi := findEdge(t, graph, "TCP", topology.MultiplePorts)
	if multi.Rate != 120 {
		t.Errorf("Rate = %v, want 120 (8080+54002 folded in once 8080 is no longer allow-listed)", multi.Rate)
	}
}

// findEdge returns the graph edge matching protocol and port, failing the
// test if none (or more than one) does.
func findEdge(t *testing.T, graph topology.Graph, protocol, port string) topology.Flow {
	t.Helper()
	var found []topology.Flow
	for _, e := range graph.Edges {
		if e.Protocol == protocol && e.Port == port {
			found = append(found, e)
		}
	}
	if len(found) != 1 {
		t.Fatalf("want exactly 1 edge with protocol %q port %q, got %d: %+v", protocol, port, len(found), graph.Edges)
	}
	return found[0]
}

// Istio label values below (source_workload, source_workload_namespace,
// destination_workload, destination_workload_namespace, request_protocol)
// are verified against a real ambient-mode mesh (ztunnel + a waypoint in
// front of mesh-backend only, no sidecars) — the lab cluster at
// /home/rafael/local/k8s/openobserve — not assumed from the issue/ADR
// alone (VERIFY-001, plan/feature-istio-source-1.md). Neither
// istio_requests_total nor istio_tcp_{sent,received}_bytes_total carries a
// destination-port label on that mesh.

const istioHTTPResult = `{
  "status": "success",
  "data": {
    "resultType": "vector",
    "result": [
      {
        "metric": {
          "__name__": "istio_requests_total",
          "source_workload": "frontend",
          "source_workload_namespace": "mesh-frontend",
          "destination_workload": "backend",
          "destination_workload_namespace": "mesh-backend",
          "destination_service_name": "backend",
          "request_protocol": "http",
          "response_code": "200"
        },
        "value": [1700000000, "12.5"]
      }
    ]
  }
}`

func TestBuildTopology_Istio_HTTPFlow(t *testing.T) {
	api := newFakeAPI(t, istioHTTPResult, http.StatusOK)

	graph, err := topology.BuildTopology(context.Background(), api, []string{topology.AllNamespaces}, topology.ProtocolAll, topology.DefaultProtocolClasses(), topology.DefaultPortCardinality(), topology.SourceIstio)
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
	if edge.Protocol != "http" {
		t.Errorf("Protocol = %q, want http", edge.Protocol)
	}
	if edge.Port != "" {
		t.Errorf("Port = %q, want empty (no port label on istio_requests_total)", edge.Port)
	}
	if edge.Rate != 12.5 {
		t.Errorf("Rate = %v, want 12.5", edge.Rate)
	}
	if edge.Metric != topology.MetricRequests {
		t.Errorf("Metric = %q, want %q (HTTP has no standard byte-rate metric in Istio's default telemetry)", edge.Metric, topology.MetricRequests)
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
	if srcNode.Name != "frontend" || srcNode.Namespace != "mesh-frontend" {
		t.Errorf("source node = %+v, want frontend/mesh-frontend", srcNode)
	}
	// destination_service_name is deliberately not used for node identity,
	// per ADR 0002: node identity stays Workload-only.
	if dstNode.Name != "backend" || dstNode.Namespace != "mesh-backend" {
		t.Errorf("dest node = %+v, want backend/mesh-backend", dstNode)
	}
}

const istioGRPCResult = `{
  "status": "success",
  "data": {
    "resultType": "vector",
    "result": [
      {
        "metric": {
          "source_workload": "frontend",
          "source_workload_namespace": "mesh-frontend",
          "destination_workload": "backend",
          "destination_workload_namespace": "mesh-backend",
          "request_protocol": "grpc",
          "response_code": "0"
        },
        "value": [1700000000, "7"]
      }
    ]
  }
}`

func TestBuildTopology_Istio_GRPCFlow(t *testing.T) {
	api := newFakeAPI(t, istioGRPCResult, http.StatusOK)

	graph, err := topology.BuildTopology(context.Background(), api, []string{topology.AllNamespaces}, topology.ProtocolAll, topology.DefaultProtocolClasses(), topology.DefaultPortCardinality(), topology.SourceIstio)
	if err != nil {
		t.Fatalf("BuildTopology: %v", err)
	}

	if len(graph.Edges) != 1 {
		t.Fatalf("want 1 edge, got %d: %+v", len(graph.Edges), graph.Edges)
	}
	edge := graph.Edges[0]
	if edge.Protocol != "grpc" {
		t.Errorf("Protocol = %q, want grpc", edge.Protocol)
	}
	if edge.Metric != topology.MetricRequests {
		t.Errorf("Metric = %q, want %q", edge.Metric, topology.MetricRequests)
	}
	if edge.Rate != 7 {
		t.Errorf("Rate = %v, want 7", edge.Rate)
	}
}

// istioTCPResult mirrors what rate(istio_tcp_sent_bytes_total[...]) +
// rate(istio_tcp_received_bytes_total[...]) resolves to for one connection
// once PromQL's vector addition has already merged the two metrics'
// identically-labeled series into one sample (see istioTCPQuery) — the
// fake Prometheus here returns the post-addition shape, same as a real one
// would for this query.
const istioTCPResult = `{
  "status": "success",
  "data": {
    "resultType": "vector",
    "result": [
      {
        "metric": {
          "source_workload": "loadgen",
          "source_workload_namespace": "mesh-frontend",
          "destination_workload": "gateway-nginx",
          "destination_workload_namespace": "nginx-gateway",
          "request_protocol": "tcp",
          "response_flags": "-"
        },
        "value": [1700000000, "2048"]
      }
    ]
  }
}`

func TestBuildTopology_Istio_TCPFlow(t *testing.T) {
	api := newFakeAPI(t, istioTCPResult, http.StatusOK)

	graph, err := topology.BuildTopology(context.Background(), api, []string{topology.AllNamespaces}, topology.ProtocolAll, topology.DefaultProtocolClasses(), topology.DefaultPortCardinality(), topology.SourceIstio)
	if err != nil {
		t.Fatalf("BuildTopology: %v", err)
	}

	if len(graph.Edges) != 1 {
		t.Fatalf("want 1 edge, got %d: %+v", len(graph.Edges), graph.Edges)
	}
	edge := graph.Edges[0]
	if edge.Protocol != "tcp" {
		t.Errorf("Protocol = %q, want tcp", edge.Protocol)
	}
	if edge.Port != "" {
		t.Errorf("Port = %q, want empty", edge.Port)
	}
	if edge.Rate != 2048 {
		t.Errorf("Rate = %v, want 2048", edge.Rate)
	}
	if edge.Metric != topology.MetricBytes {
		t.Errorf("Metric = %q, want %q (TCP byte counters match Beyla's shape)", edge.Metric, topology.MetricBytes)
	}
}

// istioUnresolvedIdentityResult mirrors a real series observed on the lab
// cluster: ztunnel reports "unknown" for an endpoint it can't resolve
// (traffic leaving the mesh), not an empty label — this must be treated
// the same as a missing attribute, not a literal Workload named "unknown".
const istioUnresolvedIdentityResult = `{
  "status": "success",
  "data": {
    "resultType": "vector",
    "result": [
      {
        "metric": {
          "source_workload": "frontend",
          "source_workload_namespace": "mesh-frontend",
          "destination_workload": "unknown",
          "destination_workload_namespace": "unknown",
          "request_protocol": "tcp"
        },
        "value": [1700000000, "99"]
      }
    ]
  }
}`

func TestBuildTopology_Istio_UnresolvedDestination_DropsSample(t *testing.T) {
	api := newFakeAPI(t, istioUnresolvedIdentityResult, http.StatusOK)

	graph, err := topology.BuildTopology(context.Background(), api, []string{topology.AllNamespaces}, topology.ProtocolAll, topology.DefaultProtocolClasses(), topology.DefaultPortCardinality(), topology.SourceIstio)
	if err != nil {
		t.Fatalf("BuildTopology: %v", err)
	}

	if len(graph.Nodes) != 0 {
		t.Errorf("want 0 nodes (unresolved destination must not render as a node), got %d: %+v", len(graph.Nodes), graph.Nodes)
	}
	if len(graph.Edges) != 0 {
		t.Errorf("want 0 edges, got %d: %+v", len(graph.Edges), graph.Edges)
	}
}

func TestBuildTopology_Istio_EmptyResult(t *testing.T) {
	api := newFakeAPI(t, emptyResult, http.StatusOK)

	graph, err := topology.BuildTopology(context.Background(), api, []string{"mesh-frontend"}, topology.ProtocolAll, topology.DefaultProtocolClasses(), topology.DefaultPortCardinality(), topology.SourceIstio)
	if err != nil {
		t.Fatalf("BuildTopology: %v", err)
	}
	if len(graph.Nodes) != 0 || len(graph.Edges) != 0 {
		t.Errorf("want empty graph, got %+v", graph)
	}
}
