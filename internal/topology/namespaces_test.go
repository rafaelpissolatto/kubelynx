package topology_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	promapi "github.com/prometheus/client_golang/api"
	promv1 "github.com/prometheus/client_golang/api/prometheus/v1"

	"github.com/rafaelpissolatto/kubelynx/internal/topology"
)

func newFakeLabelValuesAPI(t *testing.T, valuesByLabel map[string]string) promv1.API {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatalf("parsing form: %v", err)
		}
		label := r.PathValue("label")
		if label == "" {
			// Older mux styles: extract the label from the path directly.
			label = r.URL.Path[len("/api/v1/label/"):]
			for i, c := range label {
				if c == '/' {
					label = label[:i]
					break
				}
			}
		}
		body, ok := valuesByLabel[label]
		if !ok {
			body = `{"status":"success","data":[]}`
		}
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

func TestListNamespaces_MergesSourceAndDestinationLabels(t *testing.T) {
	api := newFakeLabelValuesAPI(t, map[string]string{
		"k8s_src_namespace": `{"status":"success","data":["demo-frontend","shared"]}`,
		"k8s_dst_namespace": `{"status":"success","data":["demo-backend","shared"]}`,
	})

	namespaces, err := topology.ListNamespaces(context.Background(), api)
	if err != nil {
		t.Fatalf("ListNamespaces: %v", err)
	}

	want := []string{"demo-backend", "demo-frontend", "shared"}
	if len(namespaces) != len(want) {
		t.Fatalf("namespaces = %v, want %v", namespaces, want)
	}
	for i, ns := range want {
		if namespaces[i] != ns {
			t.Errorf("namespaces[%d] = %q, want %q (namespaces = %v)", i, namespaces[i], ns, namespaces)
		}
	}
}

func TestListNamespaces_EmptyResult(t *testing.T) {
	api := newFakeLabelValuesAPI(t, map[string]string{})

	namespaces, err := topology.ListNamespaces(context.Background(), api)
	if err != nil {
		t.Fatalf("ListNamespaces: %v", err)
	}
	if len(namespaces) != 0 {
		t.Errorf("namespaces = %v, want empty", namespaces)
	}
}

func TestListNamespaces_PrometheusUnreachable(t *testing.T) {
	client, err := promapi.NewClient(promapi.Config{Address: "http://127.0.0.1:1"})
	if err != nil {
		t.Fatalf("creating prometheus client: %v", err)
	}
	api := promv1.NewAPI(client)

	_, err = topology.ListNamespaces(context.Background(), api)
	if err == nil {
		t.Fatal("ListNamespaces: want error for unreachable Prometheus, got nil")
	}
}
