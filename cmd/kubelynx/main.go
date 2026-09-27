// Command kubelynx runs KubeLynx's backend: it queries Prometheus for
// Beyla's network flow telemetry and serves it over /api/topology.
package main

import (
	"flag"
	"log/slog"
	"net/http"
	"os"

	"github.com/rafaelpissolatto/kubelynx/internal/api"
	"github.com/rafaelpissolatto/kubelynx/internal/promclient"
	"github.com/rafaelpissolatto/kubelynx/internal/topology"
)

func main() {
	var (
		listenAddr           = flag.String("listen-addr", ":8080", "address to serve the KubeLynx API on")
		promURL              = flag.String("prometheus-url", "http://localhost:9090", "base URL of the Prometheus server to query")
		promBearerTokenFile  = flag.String("prometheus-bearer-token-file", "", `path to a file containing a bearer token sent as "Authorization: Bearer <token>" on every Prometheus request; re-read on each request so rotated Kubernetes Secrets apply without a restart; omit for an unauthenticated Prometheus`)
		protocolPortsFile    = flag.String("protocol-ports-file", "", `path to a JSON file overriding the default HTTP/gRPC port classification used by the protocol filter, e.g. {"http":["8081"],"grpc":["50052"]}; omit to use the built-in defaults`)
		tcpPortAllowlistFile = flag.String("tcp-port-allowlist-file", "", `path to a JSON file overriding the default TCP "known ports" allow-list used to bound port cardinality, e.g. {"tcp":["80","443","8080"]}; TCP ports outside this list (and UDP ports other than 53/DNS) are aggregated into a single "multiple" flow instead of one per port; omit to use the built-in defaults`)
	)
	flag.Parse()

	prom, err := promclient.New(*promURL, *promBearerTokenFile)
	if err != nil {
		slog.Error("creating prometheus client", "error", err)
		os.Exit(1)
	}
	promAuth := "none"
	if *promBearerTokenFile != "" {
		promAuth = "bearer-file"
	}

	protocolClasses, err := topology.LoadProtocolClasses(*protocolPortsFile)
	if err != nil {
		slog.Error("loading protocol classes", "error", err)
		os.Exit(1)
	}

	portCardinality, err := topology.LoadPortCardinality(*tcpPortAllowlistFile)
	if err != nil {
		slog.Error("loading port cardinality allow-list", "error", err)
		os.Exit(1)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/topology", api.TopologyHandler(prom, protocolClasses, portCardinality))
	mux.HandleFunc("/api/namespaces", api.NamespacesHandler(prom))
	mux.HandleFunc("/api/protocols", api.ProtocolsHandler())

	slog.Info("kubelynx listening", "addr", *listenAddr, "prometheus", *promURL, "prometheus_auth", promAuth)
	if err := http.ListenAndServe(*listenAddr, mux); err != nil {
		slog.Error("server exited", "error", err)
		os.Exit(1)
	}
}
