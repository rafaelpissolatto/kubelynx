// Command kubelynx runs KubeLynx's backend: it queries Prometheus for
// Beyla's network flow telemetry and serves it over /api/topology.
package main

import (
	"flag"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/rafaelpissolatto/kubelynx/internal/api"
	"github.com/rafaelpissolatto/kubelynx/internal/promclient"
	"github.com/rafaelpissolatto/kubelynx/internal/topology"
	"github.com/rafaelpissolatto/kubelynx/web"
)

func main() {
	var (
		listenAddr           = flag.String("listen-addr", ":8080", "address to serve the KubeLynx API on")
		promURL              = flag.String("prometheus-url", "http://localhost:9090", "base URL of the Prometheus server to query")
		promBearerTokenFile  = flag.String("prometheus-bearer-token-file", "", `path to a file containing a bearer token sent as "Authorization: Bearer <token>" on every Prometheus request; re-read on each request so rotated Kubernetes Secrets apply without a restart; omit for an unauthenticated Prometheus`)
		protocolPortsFile    = flag.String("protocol-ports-file", "", `path to a JSON file overriding the default HTTP/gRPC port classification used by the protocol filter, e.g. {"http":["8081"],"grpc":["50052"]}; omit to use the built-in defaults`)
		tcpPortAllowlistFile = flag.String("tcp-port-allowlist-file", "", `path to a JSON file overriding the default TCP "known ports" allow-list used to bound port cardinality, e.g. {"tcp":["80","443","8080"]}; TCP ports outside this list (and UDP ports other than 53/DNS) are aggregated into a single "multiple" flow instead of one per port; omit to use the built-in defaults`)
		refreshInterval      = flag.Duration("refresh-interval", 15*time.Second, "how often the UI polls /api/topology; served to the frontend via /api/config (a ?refreshInterval=<ms> URL param still overrides it)")
	)
	flag.Parse()

	// /api/config reports whole milliseconds, so anything shorter would reach
	// the UI as 0 and be silently ignored.
	if *refreshInterval < time.Millisecond {
		slog.Error("invalid refresh interval", "refresh_interval", *refreshInterval)
		os.Exit(1)
	}

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
	mux.HandleFunc("/api/sources", api.SourcesHandler(prom))
	mux.HandleFunc("/api/config", api.ConfigHandler(*refreshInterval))
	// Liveness/readiness only: deliberately doesn't touch Prometheus, whose
	// outages the UI already reports rather than restarting the pod over.
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})
	assets, uiEmbedded := web.Assets()
	mux.Handle("/", api.UIHandler(assets, uiEmbedded))

	slog.Info("kubelynx listening", "addr", *listenAddr, "prometheus", *promURL, "prometheus_auth", promAuth,
		"refresh_interval", *refreshInterval, "ui_embedded", uiEmbedded)
	if err := http.ListenAndServe(*listenAddr, mux); err != nil {
		slog.Error("server exited", "error", err)
		os.Exit(1)
	}
}
