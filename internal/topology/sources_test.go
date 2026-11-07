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

// newFakeCountAPI returns a fake Prometheus whose query responses are
// driven by which metric name(s) the incoming PromQL query text mentions —
// present reports which metric names should resolve to a non-empty
// count() vector; everything else gets an empty vector.
func newFakeCountAPI(t *testing.T, present ...string) promv1.API {
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

func TestListSources_BothPresent(t *testing.T) {
	api := newFakeCountAPI(t, "beyla_network_flow_bytes_total", "istio_requests_total")

	sources, err := topology.ListSources(context.Background(), api)
	if err != nil {
		t.Fatalf("ListSources: %v", err)
	}
	want := []string{topology.SourceBeyla, topology.SourceIstio}
	if len(sources) != len(want) {
		t.Fatalf("sources = %v, want %v", sources, want)
	}
	for i, s := range want {
		if sources[i] != s {
			t.Errorf("sources[%d] = %q, want %q", i, sources[i], s)
		}
	}
}

func TestListSources_OnlyBeylaPresent(t *testing.T) {
	api := newFakeCountAPI(t, "beyla_network_flow_bytes_total")

	sources, err := topology.ListSources(context.Background(), api)
	if err != nil {
		t.Fatalf("ListSources: %v", err)
	}
	if len(sources) != 1 || sources[0] != topology.SourceBeyla {
		t.Errorf("sources = %v, want [%q]", sources, topology.SourceBeyla)
	}
}

func TestListSources_OnlyIstioPresent_ViaTCPMetric(t *testing.T) {
	// A mesh with no waypoint (so no istio_requests_total) still has ztunnel's
	// TCP counters — any one of the three Istio metrics being present must
	// be enough to report the source as observed.
	api := newFakeCountAPI(t, "istio_tcp_sent_bytes_total")

	sources, err := topology.ListSources(context.Background(), api)
	if err != nil {
		t.Fatalf("ListSources: %v", err)
	}
	if len(sources) != 1 || sources[0] != topology.SourceIstio {
		t.Errorf("sources = %v, want [%q]", sources, topology.SourceIstio)
	}
}

func TestListSources_NeitherPresent(t *testing.T) {
	api := newFakeCountAPI(t)

	sources, err := topology.ListSources(context.Background(), api)
	if err != nil {
		t.Fatalf("ListSources: %v", err)
	}
	if len(sources) != 0 {
		t.Errorf("sources = %v, want empty", sources)
	}
}

func TestListSources_PrometheusUnreachable(t *testing.T) {
	client, err := promapi.NewClient(promapi.Config{Address: "http://127.0.0.1:1"})
	if err != nil {
		t.Fatalf("creating prometheus client: %v", err)
	}
	api := promv1.NewAPI(client)

	_, err = topology.ListSources(context.Background(), api)
	if err == nil {
		t.Fatal("ListSources: want error for unreachable Prometheus, got nil")
	}
}
