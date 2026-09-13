// Command kubelynx runs KubeLynx's backend: it queries Prometheus for
// Beyla's network flow telemetry and serves it over /api/topology.
package main

import (
	"flag"
	"log/slog"
	"net/http"
	"os"

	promapi "github.com/prometheus/client_golang/api"
	promv1 "github.com/prometheus/client_golang/api/prometheus/v1"

	"github.com/rafaelpissolatto/kubelynx/internal/api"
	"github.com/rafaelpissolatto/kubelynx/internal/topology"
)

func main() {
	var (
		listenAddr        = flag.String("listen-addr", ":8080", "address to serve the KubeLynx API on")
		promURL           = flag.String("prometheus-url", "http://localhost:9090", "base URL of the Prometheus server to query")
		protocolPortsFile = flag.String("protocol-ports-file", "", "path to a JSON file overriding the default HTTP/gRPC dst_port classification used by the protocol filter (see topology.ProtocolClasses); omit to use the built-in defaults")
	)
	flag.Parse()

	client, err := promapi.NewClient(promapi.Config{Address: *promURL})
	if err != nil {
		slog.Error("creating prometheus client", "error", err)
		os.Exit(1)
	}
	prom := promv1.NewAPI(client)

	protocolClasses, err := topology.LoadProtocolClasses(*protocolPortsFile)
	if err != nil {
		slog.Error("loading protocol classes", "error", err)
		os.Exit(1)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/topology", api.TopologyHandler(prom, protocolClasses))
	mux.HandleFunc("/api/namespaces", api.NamespacesHandler(prom))

	slog.Info("kubelynx listening", "addr", *listenAddr, "prometheus", *promURL)
	if err := http.ListenAndServe(*listenAddr, mux); err != nil {
		slog.Error("server exited", "error", err)
		os.Exit(1)
	}
}
