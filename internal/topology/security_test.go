package topology_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/rafaelpissolatto/kubelynx/internal/topology"
)

// istioSample is one canned istio_requests_total sample on the
// mesh-frontend/frontend -> mesh-backend/backend edge. policy "" omits the
// connection_security_policy label entirely.
type istioSample struct {
	policy string
	rate   string
}

// istioSecurityResult renders a Prometheus vector response holding samples,
// all on the same edge (same endpoints and request_protocol), so
// BuildTopology sums them into a single Flow.
func istioSecurityResult(t *testing.T, samples []istioSample) string {
	t.Helper()
	type result struct {
		Metric map[string]string `json:"metric"`
		Value  []any             `json:"value"`
	}
	results := make([]result, 0, len(samples))
	for i, s := range samples {
		metric := map[string]string{
			"__name__":                       "istio_requests_total",
			"source_workload":                "frontend",
			"source_workload_namespace":      "mesh-frontend",
			"destination_workload":           "backend",
			"destination_workload_namespace": "mesh-backend",
			"request_protocol":               "http",
			// Distinct per sample so each is its own series, as a real
			// result with differing response codes/policies would be.
			"response_code": fmt.Sprintf("%d", 200+i),
		}
		if s.policy != "" {
			metric["connection_security_policy"] = s.policy
		}
		results = append(results, result{Metric: metric, Value: []any{1700000000, s.rate}})
	}
	body, err := json.Marshal(map[string]any{
		"status": "success",
		"data":   map[string]any{"resultType": "vector", "result": results},
	})
	if err != nil {
		t.Fatalf("marshalling canned response: %v", err)
	}
	return string(body)
}

func TestBuildTopology_Istio_Security(t *testing.T) {
	tests := []struct {
		name         string
		samples      []istioSample
		wantSecurity string
		wantRatio    float64
		wantRate     float64
	}{
		{
			name:         "only mutual_tls",
			samples:      []istioSample{{"mutual_tls", "3"}, {"mutual_tls", "2"}},
			wantSecurity: topology.SecurityMutualTLS,
			wantRate:     5,
		},
		{
			name:         "only none",
			samples:      []istioSample{{"none", "4"}},
			wantSecurity: topology.SecurityNone,
			wantRate:     4,
		},
		{
			name:         "mutual_tls and none is mixed",
			samples:      []istioSample{{"mutual_tls", "8"}, {"none", "2"}},
			wantSecurity: topology.SecurityMixed,
			wantRatio:    0.8,
			wantRate:     10,
		},
		{
			name:         "label missing on all samples",
			samples:      []istioSample{{"", "1"}, {"", "2"}},
			wantSecurity: topology.SecurityUnknown,
			wantRate:     3,
		},
		{
			name:         "label unknown on all samples",
			samples:      []istioSample{{"unknown", "6"}},
			wantSecurity: topology.SecurityUnknown,
			wantRate:     6,
		},
		{
			name:         "unrecognised label value",
			samples:      []istioSample{{"permissive", "6"}},
			wantSecurity: topology.SecurityUnknown,
			wantRate:     6,
		},
		{
			name:         "mutual_tls with zero rate does not count",
			samples:      []istioSample{{"mutual_tls", "0"}, {"unknown", "1"}},
			wantSecurity: topology.SecurityUnknown,
			wantRate:     1,
		},
		{
			name:         "none with zero rate does not make mutual_tls mixed",
			samples:      []istioSample{{"mutual_tls", "5"}, {"none", "0"}},
			wantSecurity: topology.SecurityMutualTLS,
			wantRate:     5,
		},
		{
			name:         "mutual_tls plus unknown stays mutual_tls",
			samples:      []istioSample{{"mutual_tls", "7"}, {"unknown", "3"}, {"", "1"}},
			wantSecurity: topology.SecurityMutualTLS,
			wantRate:     11,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			api := newFakeAPI(t, istioSecurityResult(t, tt.samples), http.StatusOK)

			graph, err := topology.BuildTopology(context.Background(), api, []string{topology.AllNamespaces}, topology.ProtocolAll, topology.DefaultProtocolClasses(), topology.DefaultPortCardinality(), topology.SourceIstio)
			if err != nil {
				t.Fatalf("BuildTopology: %v", err)
			}
			if len(graph.Edges) != 1 {
				t.Fatalf("want 1 edge, got %d: %+v", len(graph.Edges), graph.Edges)
			}
			edge := graph.Edges[0]
			if edge.Security != tt.wantSecurity {
				t.Errorf("Security = %q, want %q", edge.Security, tt.wantSecurity)
			}
			if edge.MTLSRatio != tt.wantRatio {
				t.Errorf("MTLSRatio = %v, want %v", edge.MTLSRatio, tt.wantRatio)
			}
			if edge.Rate != tt.wantRate {
				t.Errorf("Rate = %v, want %v (security must not change the summed rate)", edge.Rate, tt.wantRate)
			}

			raw, err := json.Marshal(edge)
			if err != nil {
				t.Fatalf("marshalling Flow: %v", err)
			}
			if !strings.Contains(string(raw), fmt.Sprintf(`"security":%q`, tt.wantSecurity)) {
				t.Errorf("Flow JSON %s lacks security %q", raw, tt.wantSecurity)
			}
			if gotRatioKey := strings.Contains(string(raw), `"mtlsRatio"`); gotRatioKey != (tt.wantSecurity == topology.SecurityMixed) {
				t.Errorf("Flow JSON %s: mtlsRatio present = %v, want %v", raw, gotRatioKey, tt.wantSecurity == topology.SecurityMixed)
			}
		})
	}
}

func TestBuildTopology_Istio_Security_PerEdge(t *testing.T) {
	// Two edges in one result: policies must not leak across edgeKeys.
	body := `{
  "status": "success",
  "data": {
    "resultType": "vector",
    "result": [
      {"metric": {"source_workload": "frontend", "source_workload_namespace": "mesh-frontend", "destination_workload": "backend", "destination_workload_namespace": "mesh-backend", "request_protocol": "http", "connection_security_policy": "mutual_tls"}, "value": [1700000000, "5"]},
      {"metric": {"source_workload": "backend", "source_workload_namespace": "mesh-backend", "destination_workload": "db", "destination_workload_namespace": "mesh-backend", "request_protocol": "tcp", "connection_security_policy": "none"}, "value": [1700000000, "100"]}
    ]
  }
}`
	api := newFakeAPI(t, body, http.StatusOK)

	graph, err := topology.BuildTopology(context.Background(), api, []string{topology.AllNamespaces}, topology.ProtocolAll, topology.DefaultProtocolClasses(), topology.DefaultPortCardinality(), topology.SourceIstio)
	if err != nil {
		t.Fatalf("BuildTopology: %v", err)
	}
	got := map[string]string{}
	for _, e := range graph.Edges {
		got[e.Source+"->"+e.Target] = e.Security
	}
	want := map[string]string{
		"mesh-frontend/frontend->mesh-backend/backend": topology.SecurityMutualTLS,
		"mesh-backend/backend->mesh-backend/db":        topology.SecurityNone,
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("edge %s Security = %q, want %q (all: %v)", k, got[k], v, got)
		}
	}
}

func TestBuildTopology_Beyla_OmitsSecurity(t *testing.T) {
	api := newFakeAPI(t, fullAttributeResult, http.StatusOK)

	graph, err := topology.BuildTopology(context.Background(), api, []string{"demo-backend"}, topology.ProtocolAll, topology.DefaultProtocolClasses(), topology.DefaultPortCardinality(), topology.SourceBeyla)
	if err != nil {
		t.Fatalf("BuildTopology: %v", err)
	}
	if len(graph.Edges) != 1 {
		t.Fatalf("want 1 edge, got %d: %+v", len(graph.Edges), graph.Edges)
	}
	edge := graph.Edges[0]
	if edge.Security != "" || edge.MTLSRatio != 0 {
		t.Errorf("Security = %q, MTLSRatio = %v; want both unset for Beyla", edge.Security, edge.MTLSRatio)
	}

	raw, err := json.Marshal(edge)
	if err != nil {
		t.Fatalf("marshalling Flow: %v", err)
	}
	var keys map[string]any
	if err := json.Unmarshal(raw, &keys); err != nil {
		t.Fatalf("unmarshalling Flow JSON: %v", err)
	}
	for _, k := range []string{"security", "mtlsRatio"} {
		if _, ok := keys[k]; ok {
			t.Errorf("Beyla Flow JSON %s has %q key, want it omitted", raw, k)
		}
	}
}
